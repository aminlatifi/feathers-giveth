const { seedData } = require('./testUtility');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

before(async () => {
  try {
    // await mongoServer.getUri();
    await seedData();

    // If we require startServer before initializing mongo the server will not responding, I dont know the reason yet
    /* eslint-disable-next-line */
    const { startServer } = require('../src/server');
    // we need to wait after setting up of mongoServer we starServer
    await startServer();

    // This is because it takes seconds to feather server starts
    await sleep(3000);
    // console.log('after running feather js', mongoUri);
  } catch (e) {
    console.log('error in beforeAll', e);
    throw new Error('could not setup tests requirements');
  }
});
