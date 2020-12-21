/* eslint-disable no-continue */
/* eslint-disable no-console */
/*  eslint-disable no-await-in-loop */
// import  Web3 from 'web3';
import {
  AdminInterface,
  DelegateInfoInterface,
  DonationListObjectInterface, DonationObjectInterface, EventInterface, extendedDonation,
  PledgeInterface, TransferInfoInterface,
} from './utils/interfaces';
// import  Web3 from 'web3';
const Web3 = require('web3');
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as config from 'config';
import * as yargs from 'yargs';
import BigNumber from 'bignumber.js';
import * as mongoose from 'mongoose';
import * as cliProgress from 'cli-progress';
import * as _colors from 'colors';

const { LiquidPledging, LiquidPledgingState } = require('giveth-liquidpledging');
const { Kernel, AppProxyUpgradeable } = require('giveth-liquidpledging/build/contracts');
const EventEmitter = require('events');
const toFn = require('../src/utils/to');
import { DonationUsdValueUtility } from './DonationUsdValueUtility';
import { getTokenByAddress } from './utils/tokenUtility';
import { createProjectHelper } from '../src/common-utils/createProjectHelper';
import { converionRateModel } from './models/conversionRates.model';
import { donationModel, DonationMongooseDocument, DonationStatus } from './models/donations.model';
import { milestoneModel, MilestoneStatus } from './models/milestones.model';
import { campaignModel, CampaignStatus } from './models/campaigns.model';
import { pledgeAdminModel, AdminTypes, PledgeAdminMongooseDocument } from './models/pledgeAdmins.model';
import { Logger } from 'winston';
import { getLogger } from './utils/logger';


const { argv } = yargs
  .option('dry-run', {
    describe: 'enable dry run',
    type: 'boolean',
    default: false,
  })
  .option('update-network-cache', {
    describe: 'update network state and events cache',
    type: 'boolean',
    default: false,
  })
  .option('cache-dir', {
    describe: 'directory to create cache file inside',
    type: 'string',
    default: path.join(os.tmpdir(), 'simulation-script'),
  })
  .option('log-dir', {
    describe: 'directory to save logs inside, if empty logs will be write to stdout',
    type: 'string',
  })
  .option('debug', {
    describe: 'produce debugging log',
    type: 'boolean',
  })
  .version(false)
  .help();
const cacheDir = argv['cache-dir'];
const logDir = argv['log-dir'];
const updateState = argv['update-network-cache'];
const updateEvents = argv['update-network-cache'];
const findConflicts = !argv['dry-run'];
const fixConflicts = !argv['dry-run'];
// const ignoredTransactions  = require('./eventProcessingHelper.json');
const ignoredTransactions = [];

// Blockchain data
let events: EventInterface[];
let pledges: PledgeInterface[];
let admins: AdminInterface[];

// Map from pledge id to list of donations which are charged and can be used to move money from
const chargedDonationListMap: DonationListObjectInterface = {};
// Map from pledge id to list of donations belonged to the pledge and are not used yet!
const pledgeNotUsedDonationListMap = {};
// Map from _id to list of donations
const donationMap: DonationObjectInterface = {};
// Map from txHash to list of included events
const txHashTransferEventMap = {};
// Map from owner pledge admin ID to dictionary of charged donations
const ownerPledgeAdminIdChargedDonationMap = {};

const { nodeUrl, liquidPledgingAddress } = config.blockchain;
let foreignWeb3;
let liquidPledging;

console.log(cacheDir);
const logger: Logger = getLogger(logDir, 'debug');
// const logger: Logger = getLogger(logDir, argv.debug ?'debug':'error')

const terminateScript = (message = '', code = 0) => {
  logger.error(`Exit message: ${message}`);
  if (message) {
    logger.error(`Exit message: ${message}`);
  }

  logger.on('finish', () => {
    setTimeout(() => process.exit(code), 5 * 1000);
  });

  logger.end();
};

const symbolDecimalsMap = {};

config.tokenWhitelist.forEach(({ symbol, decimals }) => {
  symbolDecimalsMap[symbol] = {
    cutoff: new BigNumber(10 ** (18 - Number(decimals))),
  };
});

const instantiateWeb3 = async url => {
  const provider =
    url && url.startsWith('ws')
      ? new Web3.providers.WebsocketProvider(url, {
        clientConfig: {
          maxReceivedFrameSize: 100000000,
          maxReceivedMessageSize: 100000000,
        },
      })
      : url;
  return new Promise(resolve => {
    const web3 = Object.assign(new Web3(provider), EventEmitter.prototype);

    if (web3.currentProvider.on) {
      web3.currentProvider.on('connect', () => {
        console.log('connected');
        foreignWeb3 = web3;
        liquidPledging = new LiquidPledging(web3, liquidPledgingAddress);
        resolve(web3);
      });
    } else {
      foreignWeb3 = web3;
      liquidPledging = new LiquidPledging(web3, liquidPledgingAddress);
      resolve(web3);
    }
  });
};

async function getKernel() {
  const kernelAddress = await liquidPledging.kernel();
  return new Kernel(foreignWeb3, kernelAddress);
}

const donationUsdValueUtility = new DonationUsdValueUtility(converionRateModel, config);

const createProgressBar = ({ title }) => {
  return new cliProgress.SingleBar({
    format: `${title} |${_colors.cyan(
      '{bar}',
    )}| {percentage}% || {value}/{total} events`,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });
};

// Gets status of liquidpledging storage
const fetchBlockchainData = async () => {
  await instantiateWeb3(nodeUrl);
  console.log('fetchBlockchainData ....', {
    updateEvents,
    updateState,
  });
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir);
    }
  } catch (e) {
    terminateScript(e.stack);
  }
  const stateFile = path.join(cacheDir, `./liquidPledgingState_${process.env.NODE_ENV}.json`);
  const eventsFile = path.join(cacheDir, `./liquidPledgingEvents_${process.env.NODE_ENV}.json`);

  let state: {
    pledges: PledgeInterface[],
    admins: AdminInterface [],
  } = <{
    pledges: PledgeInterface[],
    admins: AdminInterface [],
  }>{};

  if (!updateState) {
    state = fs.existsSync(stateFile) ? JSON.parse(String(fs.readFileSync(stateFile))) : {};
  }
  events = fs.existsSync(eventsFile) ? JSON.parse(String(fs.readFileSync(eventsFile))) : [];

  if (updateState || updateEvents) {
    let fromBlock = 0;
    let fetchBlockNum: string | number = 'latest';
    if (updateEvents) {
      fromBlock = events.length > 0 ? events[events.length - 1].blockNumber + 1 : 0;
      fetchBlockNum =
        (await foreignWeb3.eth.getBlockNumber()) - config.blockchain.requiredConfirmations;
    }

    const liquidPledgingState = new LiquidPledgingState(liquidPledging);

    let newEvents = [];
    let error = null;
    let firstTry = true;
    while (
      error ||
      !Array.isArray(state.pledges) ||
      state.pledges.length <= 1 ||
      !Array.isArray(state.admins) ||
      state.admins.length <= 1 ||
      !Array.isArray(newEvents)
      ) {
      if (!firstTry) {
        logger.error('Some problem on fetching network info... Trying again!');
        if (!Array.isArray(state.pledges) || state.pledges.length <= 1) {
          logger.debug(`state.pledges: ${state.pledges}`);
        }
        if (!Array.isArray(state.admins) || state.admins.length <= 1) {
          logger.debug(`state.admins: ${state.admins}`);
        }
      }
      let result;
      // eslint-disable-next-line no-await-in-loop
      [error, result] = await toFn(
        Promise.all([
          updateState ? liquidPledgingState.getState() : Promise.resolve(state),
          updateEvents
            ? liquidPledging.$contract.getPastEvents('allEvents', {
              fromBlock,
              toBlock: fetchBlockNum,
            })
            : Promise.resolve([]),
        ]),
      );
      if (result) [state, newEvents] = result;
      if (error && error instanceof Error) {
        logger.error(`Error on fetching network info\n${error.stack}`);
      }
      firstTry = false;
    }

    state.pledges = state.pledges.map(pledge => {
      // the first Item of pledge is always null so I have to check
      if (pledge) {
        delete pledge.amount;
      }
      return pledge;
    });
    if (updateState) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    if (updateEvents && newEvents) {
      events = [...events, ...newEvents];
      fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
    }
  }

  events.forEach(e => {
    if (e.event === 'Transfer') {
      const { transactionHash } = e;
      const list: EventInterface[] = txHashTransferEventMap[transactionHash] || [];
      if (list.length === 0) {
        txHashTransferEventMap[transactionHash] = list;
      }
      list.push(e);
    }
  });

  pledges = state.pledges;
  admins = state.admins;
};

// Update createdAt date of donations based on transaction date
// @params {string} startDate
// eslint-disable-next-line no-unused-vars
const updateDonationsCreatedDate = async (startDate: Date) => {
  const web3 = foreignWeb3;
  const donations = await donationModel.find({
    createdAt: {
      // $gte: startDate.toISOString(),
      $gte: startDate,
    },
  });
  for (const donation of donations) {
    const { _id, txHash, createdAt } = donation;
    const { blockNumber } = await web3.eth.getTransaction(txHash);
    const { timestamp } = await web3.eth.getBlock(blockNumber);
    const newCreatedAt = new Date(timestamp * 1000);
    if (createdAt.toISOString() !== newCreatedAt.toISOString()) {
      logger.info(
        `Donation ${_id.toString()} createdAt is changed from ${createdAt.toISOString()} to ${newCreatedAt.toISOString()}`,
      );
      logger.info('Updating...');
      const [d] = await donationModel.find({ _id });
      d.createdAt = newCreatedAt;
      await d.save();
    }
  }

};

// Fills pledgeNotUsedDonationListMap map to contain donation items for each pledge
// Fills donationMap to map id to donation item
const fetchDonationsInfo = async () => {
  // TODO: pendingAmountRemaining is not considered in updating, it should be removed for successful transactions

  const donations = await donationModel.find({});
  for (const donation of donations) {
    const {
      _id,
      amount,
      amountRemaining,
      pledgeId,
      status,
      mined,
      txHash,
      parentDonations,
      ownerId,
      ownerType,
      ownerTypeId,
      intendedProjectId,
      giverAddress,
      tokenAddress,
      isReturn,
      usdValue,
      createdAt,
    } = donation;

    const list = pledgeNotUsedDonationListMap[pledgeId.toString()] || [];
    if (list.length === 0) {
      pledgeNotUsedDonationListMap[pledgeId.toString()] = list;
    }

    const item = {
      _id: _id.toString(),
      amount: amount.toString(),
      savedAmountRemaining: amountRemaining.toString(),
      amountRemaining: new BigNumber(0),
      txHash,
      status,
      savedStatus: status,
      mined,
      parentDonations: parentDonations.map(id => id.toString()),
      ownerId,
      ownerType,
      ownerTypeId,
      intendedProjectId,
      giverAddress,
      pledgeId: pledgeId.toString(),
      tokenAddress,
      isReturn,
      usdValue,
      createdAt,
    };

    list.push(item);
    donationMap[_id.toString()] = item as unknown as extendedDonation;
  }

};

const convertPledgeStateToStatus = (pledge: PledgeInterface,
                                    pledgeAdmin: AdminInterface | PledgeAdminMongooseDocument) => {
  const { pledgeState, delegates, intendedProject } = pledge;
  switch (pledgeState) {
    case 'Paying':
    case '1':
      return DonationStatus.PAYING;

    case 'Paid':
    case '2':
      return DonationStatus.PAID;

    case 'Pledged':
    case '0':
      if (intendedProject !== '0') return DonationStatus.TO_APPROVE;
      if (pledgeAdmin.type === 'Giver' || delegates.length > 0) return DonationStatus.WAITING;
      return DonationStatus.COMMITTED;

    default:
      return null;
  }
};

/**
 * Determine if this transfer was a return of excess funds of an over-funded milestone
 * @param {object} transferInfo
 */
async function isReturnTransfer(transferInfo: TransferInfoInterface) {
  const { fromPledge, fromPledgeAdmin, toPledgeId, txHash, fromPledgeId } = transferInfo;
  // currently only milestones will can be over-funded
  if (fromPledgeId === '0' || !fromPledgeAdmin || fromPledgeAdmin.type !== AdminTypes.MILESTONE) {
    return false;
  }

  const transferEventsInTx = txHashTransferEventMap[txHash];

  // ex events in return case:
  // Transfer(from: 1, to: 2, amount: 1000)
  // Transfer(from: 2, to: 1, amount: < 1000)
  return transferEventsInTx.some(
    (e: EventInterface) =>
      // it may go directly to fromPledge.oldPledge if this was delegated funds
      // being returned b/c the intermediary pledge is the pledge w/ the intendedProject
      [e.returnValues.from, fromPledge.oldPledge].includes(toPledgeId) &&
      e.returnValues.to === fromPledgeId,
  );
}

const isRejectedDelegation = (data: { fromPledge: PledgeInterface, toPledge: PledgeInterface }) => {
  const { fromPledge, toPledge } = data;
  return !!fromPledge &&
    Number(fromPledge.intendedProject) > 0 &&
    fromPledge.intendedProject !== toPledge.owner;
};


const addChargedDonation = (donation: DonationMongooseDocument) => {
  const candidates = chargedDonationListMap[donation.pledgeId] || [];
  if (candidates.length === 0) {
    chargedDonationListMap[donation.pledgeId] = candidates;
  }
  candidates.push(donation);

  const ownerEntityDonations = ownerPledgeAdminIdChargedDonationMap[donation.ownerId] || {};
  if (Object.keys(ownerEntityDonations).length === 0) {
    ownerPledgeAdminIdChargedDonationMap[donation.ownerId] = ownerEntityDonations;
  }
  ownerEntityDonations[donation._id] = donation;
};

async function correctFailedDonation(failedDonationList, matchingFailedDonationIndex, toPledge, toOwnerAdmin, to: string, toUnusedDonationList, candidateToDonationList) {
  const toFixDonation = failedDonationList[matchingFailedDonationIndex];
  logger.error(`Donation ${toFixDonation._id} hasn't failed, it should be updated`);

  // Remove from failed donations
  failedDonationList.splice(matchingFailedDonationIndex, 1);

  toFixDonation.status = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
  toFixDonation.pledgeId = to;
  toFixDonation.mined = true;
  toUnusedDonationList.push(toFixDonation);

  candidateToDonationList = [toFixDonation];

  logger.debug('Will update to:');
  logger.debug(JSON.stringify(toFixDonation, null, 2));

  if (fixConflicts) {
    logger.debug('Updating...');
    await donationModel.updateOne(
      { _id: toFixDonation._id },
      { status: toFixDonation.status, pledgeId: to },
    );
  }
  return candidateToDonationList;
}

const handleFromDonations = async (from: string, to: string,
                                   amount: string, transactionHash: string) => {
  const usedFromDonations = []; // List of donations which could be parent of the donation
  let giverAddress;

  const toUnusedDonationList = pledgeNotUsedDonationListMap[to] || []; // List of donations which are candidates to be charged

  const toPledge = pledges[Number(to)];
  const toOwnerId = toPledge.owner;

  const toOwnerAdmin = admins[Number(toOwnerId)];

  if (from !== '0') {
    const candidateChargedParents = chargedDonationListMap[from] || [];

    // Trying to find the matching donation from DB
    let candidateToDonationList = toUnusedDonationList.filter(
      item => item.txHash === transactionHash && item.amountRemaining.eq(0),
    );

    if (candidateToDonationList.length > 1) {
      logger.debug('candidateToDonationList length is greater than one!');
    } else if (candidateToDonationList.length === 0) {
      // Try to find donation among failed ones!
      const failedDonationList = pledgeNotUsedDonationListMap['0'] || [];
      const matchingFailedDonationIndex = failedDonationList.findIndex(item => {
        if (item.txHash === transactionHash && item.amount === amount) {
          const { parentDonations } = item;
          if (from === '0') {
            return parentDonations.length === 0;
          } // It should not have parent
          // Check whether parent pledgeId equals from
          if (parentDonations.length === 0) return false;
          const parent = donationMap[item.parentDonations[0]];
          return parent.pledgeId === from;
        }
        return false;
      });

      // A matching failed donation found, it's not failed and should be updated with correct value
      if (matchingFailedDonationIndex !== -1) {
        candidateToDonationList = await correctFailedDonation(failedDonationList, matchingFailedDonationIndex, toPledge, toOwnerAdmin, to, toUnusedDonationList, candidateToDonationList);
      }
    }

    // Reduce money from parents one by one
    if (candidateChargedParents.length > 0) {
      let fromAmount = new BigNumber(amount);

      // If this is a return transfer, last donate added to charged parents has the same
      // transaction hash and greater than or equal amount remaining than this transfer amount
      // Money should be removed from that donation for better transparency
      const lastInsertedCandidate = candidateChargedParents[candidateChargedParents.length - 1];
      if (
        lastInsertedCandidate.txHash === transactionHash &&
        new BigNumber(lastInsertedCandidate.amountRemaining).gte(new BigNumber(amount))
      ) {
        giverAddress = lastInsertedCandidate.giverAddress;
        lastInsertedCandidate.amountRemaining = new BigNumber(lastInsertedCandidate.amountRemaining).minus(amount).toFixed();

        fromAmount = new BigNumber(0);
        logger.debug(
          `Amount ${amount} is reduced from ${JSON.stringify(
            {
              ...lastInsertedCandidate,
              amountRemaining: new BigNumber(lastInsertedCandidate.amountRemaining).toFixed(),
            },
            null,
            2,
          )}`,
        );

        if (lastInsertedCandidate._id) {
          usedFromDonations.push(lastInsertedCandidate._id);
        }

        if (new BigNumber(lastInsertedCandidate.amountRemaining).isZero()) {
          candidateChargedParents.pop();
        }
      } else {
        let consumedCandidates = 0;
        for (let j = 0; j < candidateChargedParents.length; j += 1) {
          const item = candidateChargedParents[j];

          if (item.giverAddress) {
            giverAddress = item.giverAddress;
          }

          const min = BigNumber.min(item.amountRemaining, fromAmount);
          item.amountRemaining = new BigNumber(item.amountRemaining).minus(min).toFixed();
          if (new BigNumber(item.amountRemaining).isZero()) {
            consumedCandidates += 1;
          }
          fromAmount = fromAmount.minus(min);
          logger.debug(
            `Amount ${min.toFixed()} is reduced from ${JSON.stringify(
              { ...item, amountRemaining: item.amountRemaining },
              null,
              2,
            )}`,
          );
          if (item._id) {
            usedFromDonations.push(item._id);
          }
          if (fromAmount.eq(0)) break;
        }

        chargedDonationListMap[from] = candidateChargedParents.slice(consumedCandidates);
      }

      if (!fromAmount.eq(0)) {
        logger.debug(`from delegate ${from} donations don't have enough amountRemaining!`);
        logger.debug(`Deficit amount: ${fromAmount.toFixed()}`);
        logger.debug('Not used candidates:');
        candidateChargedParents.forEach(candidate =>
          logger.debug(JSON.stringify(candidate, null, 2)),
        );
        terminateScript();
      }
    } else {
      logger.error(`There is no donation for transfer from ${from} to ${to}`);
      // I think we should not terminate script
      terminateScript(`There is no donation for transfer from ${from} to ${to}`);
    }
  }

  return { usedFromDonations, giverAddress };
};

const handleToDonations = async ({
                                   from,
                                   to,
                                   amount,
                                   transactionHash,
                                   blockNumber,
                                   usedFromDonations,
                                   giverAddress,
                                   isReverted = false,
                                 }) => {
  const toNotFilledDonationList = pledgeNotUsedDonationListMap[to] || []; // List of donations which are candidates to be charged

  const toIndex = toNotFilledDonationList.findIndex(
    item => item.txHash === transactionHash && item.amountRemaining.eq(0),
  );

  const toDonation = toIndex !== -1 ? toNotFilledDonationList.splice(toIndex, 1)[0] : undefined;

  // It happens when a donation is cancelled, we choose the first one (created earlier)
  // if (toDonationList.length > 1) {
  //   console.log('toDonationList length is greater than 1');
  //   process.exit();
  // }

  const fromPledge = pledges[Number(from)];
  const toPledge = pledges[Number(to)];

  const toOwnerId = toPledge.owner;
  const fromOwnerId = from !== '0' ? fromPledge.owner : 0;

  const toOwnerAdmin = admins[Number(toOwnerId)];
  const fromOwnerAdmin = from !== '0' ? admins[Number(fromOwnerId)] : {};

  const [fromPledgeAdmin] = await pledgeAdminModel.find({ id: Number(fromOwnerId) });

  let isReturn = isReverted;
  if (!isReturn) {
    const returnedTransfer = await isReturnTransfer({
      fromPledge,
      fromPledgeAdmin,
      fromPledgeId: from,
      toPledgeId: to,
      txHash: transactionHash,
    });
    isReturn = isReturn || returnedTransfer;
  }

  if (!isReturn) {
    const rejectedDelegation = isRejectedDelegation({ toPledge, fromPledge });
    isReturn = isReturn || rejectedDelegation;
  }

  if (toDonation === undefined) {
    // If parent is cancelled, this donation is not needed anymore
    const status = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
    let expectedToDonation: any = {
      txHash: transactionHash,
      parentDonations: usedFromDonations,
      from,
      pledgeId: to,
      pledgeState: toPledge.pledgeState,
      amount,
      amountRemaining: new BigNumber(amount),
      ownerId: toOwnerId,
      status,
      giverAddress,
      isReturn,
    };

    if (fixConflicts) {
      let toPledgeAdmin: any = (await pledgeAdminModel.find({ id: Number(toOwnerId) }))[0];
      if (toPledgeAdmin === undefined) {
        if (toOwnerAdmin.type !== 'Giver') {
          terminateScript(
            `No PledgeAdmin record exists for non user admin ${JSON.stringify(
              toOwnerAdmin,
              null,
              2,
            )}`,
          );
          logger.error(
            `No PledgeAdmin record exists for non user admin ${JSON.stringify(
              toOwnerAdmin,
              null,
              2,
            )}`,
          );
          return;
        }

        // Create user pledge admin
        toPledgeAdmin = new pledgeAdminModel({
          id: Number(toOwnerId),
          type: AdminTypes.GIVER,
          typeId: toOwnerAdmin.addr,
        });
        await toPledgeAdmin.save();
        logger.info(`pledgeAdmin crated: ${toPledgeAdmin._id.toString()}`);
      }

      expectedToDonation = {
        ...expectedToDonation,
        ownerId: toPledgeAdmin.id,
        ownerTypeId: toPledgeAdmin.typeId,
        ownerType: toPledgeAdmin.type,
      };

      // Create donation
      const token = config.tokenWhitelist.find(
        t => t.foreignAddress.toLowerCase() === toPledge.token.toLowerCase(),
      );
      if (token === undefined) {
        logger.error(`No token found for address ${toPledge.token}`);
        terminateScript(`No token found for address ${toPledge.token}`);
        return;
      }
      expectedToDonation.tokenAddress = token.address;
      const delegationInfo: DelegateInfoInterface = <DelegateInfoInterface>{};
      // It's delegated to a DAC
      if (toPledge.delegates.length > 0) {
        const [delegate] = toPledge.delegates;
        const dacPledgeAdmin = await pledgeAdminModel.findOne({ id: Number(delegate.id) });
        if (!dacPledgeAdmin) {
          // This is wrong, why should we terminate if there is no dacPledgeAdmin
          logger.error(`No dac found for id: ${delegate.id}`);
          terminateScript(`No dac found for id: ${delegate.id}`);
          return;
        }
        delegationInfo.delegateId = dacPledgeAdmin.id;
        delegationInfo.delegateTypeId = dacPledgeAdmin.typeId;
        delegationInfo.delegateType = dacPledgeAdmin.type;

        // Has intended project
        const { intendedProject } = toPledge;
        if (intendedProject !== '0') {
          const [intendedProjectPledgeAdmin] = await pledgeAdminModel.find({
            id: Number(intendedProject),
          });
          if (intendedProjectPledgeAdmin === undefined) {
            terminateScript(`No project found for id: ${intendedProject}`);
            return;
          }
          delegationInfo.intendedProjectId = intendedProjectPledgeAdmin.id;
          delegationInfo.intendedProjectTypeId = intendedProjectPledgeAdmin.typeId;
          delegationInfo.intendedProjectType = intendedProjectPledgeAdmin.type;
        }
      }
      expectedToDonation = {
        ...expectedToDonation,
        ...delegationInfo,
      };

      // Set giverAddress to owner address if is a Giver
      if (giverAddress === undefined) {
        if (toOwnerAdmin.type !== 'Giver') {
          logger.error('Cannot set giverAddress');
          terminateScript(`Cannot set giverAddress`);
          return;
        }
        giverAddress = toPledgeAdmin.typeId;
        expectedToDonation.giverAddress = giverAddress;
      }

      if (status === null) {
        logger.error(`Pledge status ${toPledge.pledgeState} is unknown`);
        terminateScript(`Pledge status ${toPledge.pledgeState} is unknown`);
        return;
      }

      const { timestamp } = await foreignWeb3.eth.getBlock(blockNumber);

      const model: any = {
        ...expectedToDonation,
        tokenAddress: token.address,
        amountRemaining: expectedToDonation.amountRemaining.toFixed(),
        mined: true,
        createdAt: new Date(timestamp * 1000),
      };

      const { cutoff } = symbolDecimalsMap[token.symbol];
      model.lessThanCutoff = cutoff.gt(model.amountRemaining);

      const donation = new donationModel(model);

      await donationUsdValueUtility.setDonationUsdValue(donation);
      await donation.save();

      const _id = donation._id.toString();
      expectedToDonation._id = _id;
      expectedToDonation.savedAmountRemaining = model.amountRemaining;
      donationMap[_id] = { ...expectedToDonation };
      logger.info(
        `donation created: ${JSON.stringify(
          {
            ...expectedToDonation,
            amountRemaining: expectedToDonation.amountRemaining.toFixed(),
          },
          null,
          2,
        )}`,
      );
    } else {
      logger.info(
        `this donation should be created: ${JSON.stringify(
          {
            ...expectedToDonation,
            amountRemaining: expectedToDonation.amountRemaining.toFixed(),
          },
          null,
          2,
        )}`,
      );
      logger.debug('--------------------------------');
      logger.debug(`From owner: ${fromOwnerAdmin}`);
      logger.debug(`To owner:${toOwnerAdmin}`);
      logger.debug('--------------------------------');
      logger.debug(`From pledge: ${fromPledge}`);
      logger.debug(`To pledge: ${toPledge}`);
    }
    addChargedDonation(expectedToDonation);
  } else {
    // Check toDonation has correct status and mined flag
    const expectedStatus = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
    if (expectedStatus === null) {
      logger.error(`Pledge status ${toPledge.pledgeState} is unknown`);
      terminateScript(`Pledge status ${toPledge.pledgeState} is unknown`);
      return;
    }

    if (toDonation.mined === false) {
      logger.error(`Donation ${toDonation._id} mined flag should be true`);
      logger.debug('Updating...');
      await donationModel.update({ _id: toDonation._id }, { mined: true });
      toDonation.mined = true;
    }

    toDonation.status = expectedStatus;

    const { parentDonations } = toDonation;
    if (
      usedFromDonations.length !== parentDonations.length ||
      usedFromDonations.some(id => !parentDonations.includes(id))
    ) {
      logger.error(`Parent of ${toDonation._id} should be updated to ${usedFromDonations}`);
      if (fixConflicts) {
        logger.debug('Updating...');
        toDonation.parentDonations = usedFromDonations;
        await donationModel.update(
          { _id: toDonation._id },
          { parentDonations: usedFromDonations },
        );
      }
    }

    if (toDonation.isReturn !== isReturn) {
      logger.error(`Donation ${toDonation._id} isReturn flag should be ${isReturn}`);
      logger.debug('Updating...');
      await donationModel.update({ _id: toDonation._id }, { isReturn });
      toDonation.isReturn = isReturn;
    }

    const { usdValue } = toDonation;
    await donationUsdValueUtility.setDonationUsdValue(toDonation);
    if (toDonation.usdValue !== usdValue) {
      logger.error(
        `Donation ${toDonation._id} usdValue is ${usdValue} but should be updated to ${toDonation.usdValue}`,
      );
      logger.debug('Updating...');
      await donationModel.updateOne({ _id: toDonation._id }, { usdValue: toDonation.usdValue });
    }

    toDonation.txHash = transactionHash;
    toDonation.from = from;
    toDonation.pledgeId = to;
    toDonation.pledgeState = toPledge.pledgeState;
    toDonation.amountRemaining = new BigNumber(amount);

    addChargedDonation(toDonation);

    logger.debug(
      `Amount added to ${JSON.stringify(
        {
          _id: toDonation._id,
          amountRemaining: toDonation.amountRemaining.toFixed(),
          amount: toDonation.amount,
          status: toDonation.status,
        },
        null,
        2,
      )}`,
    );
  }
};

const revertProjectDonations = async projectId => {
  const donations: any = ownerPledgeAdminIdChargedDonationMap[projectId] || {};
  const values = Object.values(donations);
  const revertExceptionStatus = [DonationStatus.PAYING, DonationStatus.PAID];

  for (let i = 0; i < values.length; i += 1) {
    const donation: any = values[i];
    if (!donation.amountRemaining.isZero() && !revertExceptionStatus.includes(donation.status)) {
      donation.status = DonationStatus.CANCELED;
    }

    // Remove all donations of same pledgeId from charged donation list that are not Paying or Paid
    // because all will be reverted
  }
};

const cancelProject = async (projectId: string) => {
  admins[projectId].isCanceled = true;
  await revertProjectDonations(projectId);

  const projectIdStr = String(projectId);
  for (let index = 1; index < admins.length; index += 1) {
    const admin = admins[index];

    if (admin.parentProject === projectIdStr) {
      admin.isCanceled = true;
      // eslint-disable-next-line no-await-in-loop
      await revertProjectDonations(index);
    }
  }
};

const fixConflictInDonations = unusedDonationMap => {
  const promises = [];
  Object.values(donationMap).forEach(
    ({
       _id,
       amount,
       amountRemaining,
       savedAmountRemaining,
       status,
       savedStatus,
       pledgeId,
       txHash,
       tokenAddress,
     }) => {
      if (status === DonationStatus.FAILED) return;

      const pledge: PledgeInterface = pledges[Number(pledgeId)] || <PledgeInterface>{};

      if (unusedDonationMap.has(_id.toString())) {
        logger.error(
          `Donation was unused!\n${JSON.stringify(
            {
              _id,
              amount: amount.toString(),
              amountRemaining,
              status,
              pledgeId: pledgeId.toString(),
              pledgeOwner: pledge.owner,
              txHash,
            },
            null,
            2,
          )}`,
        );
        if (fixConflicts) {
          logger.debug('Deleting...');
          promises.push(donationModel.findOneAndDelete({ _id }));
        }
      } else {
        if (savedAmountRemaining && amountRemaining !== savedAmountRemaining) {
          logger.error(
            `Below donation should have remaining amount ${amountRemaining} but has ${savedAmountRemaining}\n${JSON.stringify(
              {
                _id,
                amount,
                amountRemaining,
                status,
                pledgeId,
                txHash,
              },
              null,
              2,
            )}`,
          );
          if (Number(pledgeId) !== 0) {
            logger.info(`Pledge Amount: ${pledge.amount}`);
          }
          if (fixConflicts) {
            logger.debug('Updating...');
            const { cutoff } = symbolDecimalsMap[getTokenByAddress(tokenAddress).symbol];
            promises.push(
              donationModel.updateOne(
                { _id },
                {
                  $set: {
                    amountRemaining,
                    lessThanCutoff: cutoff.gt(amountRemaining),
                  },
                },
              ),
            );
          }
        }

        if (savedStatus !== status) {
          logger.error(
            `Below donation status should be ${status} but is ${savedStatus}\n${JSON.stringify(
              {
                _id,
                amount: amount.toString(),
                amountRemaining,
                status,
                pledgeId: pledgeId.toString(),
                txHash,
              },
              null,
              2,
            )}`,
          );
          if (fixConflicts) {
            logger.debug('Updating...');
            promises.push(donationModel.updateOne({ _id }, { status }));
          }
        }
      }
    },
  );
  return Promise.all(promises);
};

const syncEventWithDb = async (eventData: EventInterface) => {
  const { event, transactionHash, logIndex, returnValues, blockNumber } = eventData;
  if (ignoredTransactions.some(it => it.txHash === transactionHash && it.logIndex === logIndex)) {
    logger.debug('Event ignored.');
    return;
  }

  if (event === 'Transfer') {
    const { from, to, amount } = returnValues;
    logger.debug(`Transfer from ${from} to ${to} amount ${amount}`);

    // eslint-disable-next-line no-await-in-loop
    const { usedFromDonations, giverAddress } = await handleFromDonations(
      from,
      to,
      amount,
      transactionHash,
    );

    // eslint-disable-next-line no-await-in-loop
    await handleToDonations({
      from,
      to,
      amount,
      transactionHash,
      blockNumber,
      usedFromDonations,
      giverAddress,
    });
  } else if (event === 'CancelProject') {
    const { idProject } = returnValues;
    logger.debug(
      `Cancel project ${idProject}: ${JSON.stringify(admins[Number(idProject)], null, 2)}`,
    );
    // eslint-disable-next-line no-await-in-loop
    await cancelProject(idProject);
  }
};

const syncDonationsWithNetwork = async () => {
  // Map from pledge id to list of donations belonged to the pledge and are not used yet!
  await fetchDonationsInfo();
  const startTime = new Date();
  // create new progress bar
  const progressBar = createProgressBar({ title: 'Syncing donations with events.' });
  progressBar.start(events.length, 0);

  // Simulate transactions by events
  for (let i = 0; i < events.length; i += 1) {
    progressBar.update(i);
    const { event, transactionHash, logIndex, returnValues, blockNumber } = events[i];
    logger.debug(
      `-----\nProcessing event ${i}:\nLog Index: ${logIndex}\nEvent: ${event}\nTransaction hash: ${transactionHash}`,
    );
    // eslint-disable-next-line no-await-in-loop
    await syncEventWithDb({ event, transactionHash, logIndex, returnValues, blockNumber });
  }
  progressBar.update(events.length);
  progressBar.stop();
  const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
  console.log(`events donations synced end.\n spentTime :${spentTime} seconds`);

  // Find conflicts in donations and pledges!
  Object.keys(chargedDonationListMap).forEach(pledgeId => {
    const list = chargedDonationListMap[pledgeId];
    const reducer = (totalAmountRemaining, chargedDonation) => {
      return totalAmountRemaining.plus(chargedDonation.amountRemaining);
    };
    const totalAmountRemaining = list.reduce(reducer, new BigNumber(0));
    const { amount: pledgeAmount, owner, oldPledge, pledgeState } = pledges[Number(pledgeId)];
    const admin = admins[Number(owner)];
    const { isCanceled, canceled } = admin;

    if (!totalAmountRemaining.eq(pledgeAmount)) {
      logger.error(
        `Pledge ${pledgeId} amount ${pledgeAmount} does not equal total amount remaining ${totalAmountRemaining.toFixed()}`,
      );
      logger.debug(
        JSON.stringify(
          {
            PledgeState: pledgeState,
            'Old Pledge': oldPledge,
            Owner: owner,
            'Owner canceled': !!canceled,
            'Owner isCanceled': !!isCanceled,
          },
          null,
          2,
        ),
      );
    }
  });

  const unusedDonationMap = new Map();
  Object.values(pledgeNotUsedDonationListMap).forEach((list: any = []) =>
    list.forEach(item => unusedDonationMap.set(item._id, item)),
  );
  await fixConflictInDonations(unusedDonationMap);
};

const createMilestoneForPledgeAdmin = async ({
                                               project, getMilestoneDataForCreate,
                                               idProject, milestoneType, transactionHash,
                                             }) => {
  const campaign = await campaignModel.findOne({ projectId: project.parentProject });
  if (!campaign) {
    logger.error(`Campaign doesn't exist -> projectId:${idProject}`);
    return undefined;
  }
  const createMilestoneData = await getMilestoneDataForCreate({
    milestoneType,
    project,
    projectId: idProject,
    txHash: transactionHash,
  });
  return new milestoneModel({
    ...createMilestoneData,
    status: MilestoneStatus.CANCELED,
    campaignId: campaign._id,
  }).save();
};
const createCampaignForPledgeAdmin = async ({ project, idProject, transactionHash, getCampaignDataForCreate }) => {
  const createCampaignData = await getCampaignDataForCreate({
    project,
    projectId: idProject,
    txHash: transactionHash,
  });
  return new campaignModel({
    ...createCampaignData,
    status: CampaignStatus.CANCELED,
  }).save();
};

const syncPledgeAdmin = async () => {

};

// Creates PledgeAdmins entity for a project entity
// Requires corresponding project entity has been saved holding correct value of txHash
// eslint-disable-next-line no-unused-vars
const syncPledgeAdmins = async () => {
  console.log('syncPledgeAdmins called', { fixConflicts });
  if (!fixConflicts) return;
  const {
    getMilestoneTypeByProjectId,
    getCampaignDataForCreate,
    getMilestoneDataForCreate,
  } = await createProjectHelper({
    web3: foreignWeb3,
    liquidPledging,
    kernel: await getKernel(),
    AppProxyUpgradeable,
  });

  const startTime = new Date();
  const progressBar = createProgressBar({ title: 'Syncing PledgeAdmins with events' });
  progressBar.start(events.length, 0);
  for (let i = 0; i < events.length; i += 1) {
    progressBar.update(i);
    try {
      const { event, transactionHash, returnValues } = events[i];
      if (event !== 'ProjectAdded') continue;
      const { idProject } = returnValues;
      const pledgeAdmin = await pledgeAdminModel.findOne({ id: Number(idProject) });

      if (pledgeAdmin) {
        continue;
      }
      logger.error(`No pledge admin exists for ${idProject}`);
      logger.info('Transaction Hash:', transactionHash);

      const { project, milestoneType, isCampaign } = await getMilestoneTypeByProjectId(idProject);
      let entity = isCampaign
        ? await campaignModel.findOne({ txHash: transactionHash })
        : await milestoneModel.findOne({ txHash: transactionHash });
      // Not found any
      if (!entity && !isCampaign) {
        entity = await createMilestoneForPledgeAdmin({
          project,
          idProject,
          milestoneType,
          transactionHash,
          getMilestoneDataForCreate,
        });
      } else if (!entity && isCampaign) {
        entity = await createCampaignForPledgeAdmin({ project, idProject, transactionHash, getCampaignDataForCreate });
      }
      if (!entity) {
        continue;
      }

      logger.info('created entity ', entity);
      const type = isCampaign ? AdminTypes.CAMPAIGN : AdminTypes.MILESTONE;
      logger.info(`a ${type} found with id ${entity._id.toString()} and status ${entity.status}`);
      logger.info(`Title: ${entity.title}`);
      const newPledgeAdmin = new pledgeAdminModel({
        id: Number(idProject),
        type,
        typeId: entity._id.toString(),
      });
      const result = await newPledgeAdmin.save();
      logger.info('pledgeAdmin saved', result);
    } catch (e) {
      logger.error('error in creating pledgeAdmin', e);
    }
  }
  progressBar.update(events.length);
  progressBar.stop();
  const spentTime = (new Date().getTime() - startTime.getTime()) / 1000;
  console.log(`pledgeAdmin events synced end.\n spentTime :${spentTime} seconds`);
};

const main = async () => {
  try {
    await fetchBlockchainData();

    if (!findConflicts && !fixConflicts) {
      terminateScript(null, 0);
      return;
    }

    /*
       Find conflicts in milestone donation counter
      */
    const mongoUrl = config.mongodb;
    mongoose.connect(mongoUrl);
    const db = mongoose.connection;

    db.on('error', err => logger.error(`Could not connect to Mongo:\n${err.stack}`));

    db.once('open', async () => {
      logger.info('Connected to Mongo');
      await syncPledgeAdmins();
      await syncDonationsWithNetwork();
      terminateScript(null, 0);
    });
  } catch (e) {
    logger.error(e);
    throw e;
  }
};

main()
  .then(() => {
  })
  .catch(e => terminateScript(e, 1));