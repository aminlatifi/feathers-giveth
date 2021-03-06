const request = require('supertest');
const config = require('config');
const { assert } = require('chai');
const { getFeatherAppInstance } = require('../../app');

const app = getFeatherAppInstance();
const baseUrl = config.get('givethFathersBaseUrl');
const relativeUrl = '/conversionRates';

function getConversionRatesTestCases() {
  const btcSymbol = 'BTC';

  it('should get successful result', async function() {
    const response = await request(baseUrl)
      .get(relativeUrl)
      .query({ symbol: btcSymbol });
    assert.equal(response.statusCode, 200);
    assert.exists(response.body.rates);
  });

  it('should get equal values for BTC and WBTC', async function() {
    const wbtcSumbol = 'WBTC';
    const response = await request(baseUrl)
      .get(relativeUrl)
      .query({ symbol: wbtcSumbol });
    assert.equal(response.statusCode, 200);
    assert.exists(response.body.rates);
    assert.equal(response.body.rates[btcSymbol], 1);
  });

  it('should hourly get successful result', async function() {
    const usdSymbol = 'USD';
    const hourlyInterval = 'hourly';
    const response = await request(baseUrl)
      .get(relativeUrl)
      .query({ interval: hourlyInterval, from: btcSymbol, to: usdSymbol });
    assert.equal(response.statusCode, 200);
    assert.exists(response.body.rate);
  });

  it('should hourly get equal values for BTC and WBTC', async function() {
    const wbtcSymbol = 'WBTC';
    const hourlyInterval = 'hourly';
    const response = await request(baseUrl)
      .get(relativeUrl)
      .query({ interval: hourlyInterval, from: btcSymbol, to: wbtcSymbol });
    assert.equal(response.statusCode, 200);
    assert.exists(response.body.rate);
    assert.equal(response.body.rate, 1);
  });

  it('should multiple hourly get successful result', async function() {
    const usdSymbol = 'USD';
    const eurSymbol = 'EUR';
    const hourlyInterval = 'hourly';
    const response = await request(baseUrl)
      .get(relativeUrl)
      .query({ interval: hourlyInterval, from: btcSymbol, to: [usdSymbol, eurSymbol] });
    assert.equal(response.statusCode, 200);
    assert.exists(response.body.rates);
    assert.exists(response.body.rates[usdSymbol]);
    assert.exists(response.body.rates[eurSymbol]);
  });
}

it('should conversionRates service registration be ok', () => {
  const userService = app.service('conversionRates');
  assert.ok(userService, 'Registered the service');
});

describe('test get /conversionRates', getConversionRatesTestCases);
