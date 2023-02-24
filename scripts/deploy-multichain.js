const yargs = require("yargs");
const {hideBin} = require("yargs/helpers");
const StagingAccounts = require('./staging-accounts');

const {Network_v2, Web3Connection, NetworkRegistry, ERC20, BountyToken} = require("@taikai/dappkit");
const {nativeZeroAddress} = require("@taikai/dappkit/dist/src/utils/constants");
const {Sequelize} = require("sequelize");
const SettingsModel = require("../db/models/settings.model");
const NetworkModel = require("../db/models/network.model");
const NetworkTokensModel = require("../db/models/network-tokens.model");
const RepositoryModel = require("../db/models/repositories.model");

const xNetworks = {
  seneca: 'https://eth-seneca.taikai.network:8080',
  diogenes: 'https://eth-diogenes.taikai.network:8080',
  aurelius: 'https://eth-aurelius.taikai.network:8080',
  afrodite: 'https://eth-afrodite.taikai.network:8080',
  irene: 'https://eth-irene.taikai.network:8080',
  apollodorus: 'https://eth-apollodorus.taikai.network:8080',
}

const options = yargs(hideBin(process.argv))
  .option(`network`, {alias: `n`, type: `array`, desc: `ids of network to deploy to, as seen on https://chainid.network/ or custom known one`})
  .option(`deployTestTokens`, {alias: `d`, type: `boolean`, desc: `deploys contracts (-d takes precedence over -pgb`})
  .option(`paymentToken`, {alias: `p`, type: `array`, desc: `use these addresses as transactional token`})
  .option(`governanceToken`, {alias: `g`, type: `array`, desc: `use these addresses as governance token`})
  .option(`bountyNFT`, {alias: `b`, type: `array`, desc: `use these addresses as bounty token`})
  .option(`privateKey`, {alias: `k`, type: `array`, desc: `Owner private key`})
  .option(`treasury`, {alias: `t`, type: `string`, desc: `custom treasury address (defaults to owner private key if not provided)`})
  .option(`envFile`, {alias: `e`, type: `array`, desc: `env-file names to load`})
  .demandOption([`n`, `k`])
  .parseSync();

async function main(option = 0) {
  const web3Host =
    xNetworks[options.network[option]] ||
    await fetch(`https://chainid.network/chains_mini.json`)
      .then(d => d.json())
      .then(data => data.find(d => d.networkId === +options.network[option]))
      .then(chain => chain.rpc[0]);

  const env = require('dotenv').config({path: options.envFile[option]});
  const privateKey = options.privateKey[option] || options.privateKey[0];

  const connection = new Web3Connection({web3Host, privateKey});
  connection.start();

  const treasury = options.treasury[option] || await connection.getAddress();
  const hasPayment = !!options.paymentToken[option];
  const hasGovernance = !!options.governanceToken[option];
  const hasBountyNFT = !!options.bountyNFT[option];

  async function getContractAddress({contractAddress}) {
    return contractAddress;
  }

  async function Deploy(_class, ...args) {
    const deployer = new _class(connection);
    deployer.loadAbi();
    console.debug(`Deploying ${deployer.constructor?.name} with args:`, ...(args || []));
    return getContractAddress(await deployer.deployJsonAbi(...(args || [])))
  }

  async function deployNetwork(governanceToken, registryAddress) {
    return Deploy(Network_v2, governanceToken, registryAddress);
  }

  async function deployRegistry(governanceToken, bountyToken) {
    const {DEPLOY_LOCK_AMOUNT_FOR_NETWORK_CREATION, DEPLOY_LOCK_FEE_PERCENTAGE, DEPLOY_CLOSE_BOUNTY_FEE} = env;
    return Deploy(NetworkRegistry, governanceToken, DEPLOY_LOCK_AMOUNT_FOR_NETWORK_CREATION, treasury, DEPLOY_LOCK_FEE_PERCENTAGE, DEPLOY_CLOSE_BOUNTY_FEE, bountyToken);
  }

  async function deployERC20(name, symbol) {
    const {DEPLOY_TOKENS_CAP_AMOUNT} = env;
    return Deploy(ERC20, name, symbol, DEPLOY_TOKENS_CAP_AMOUNT)
  }

  async function deployBountyToken() {
    return Deploy(BountyToken, `BEPRO Bounty`, `~BEPRO`)
  }

  async function deployTokens() {
    const mapper = ([name, symbol]) => deployERC20(name, symbol);

    return Promise.all([[`Test USDC`, `TUSD`], [`Test BEPRO`, `TBEPRO`], [`Test Reward BEPRO`, `TRBEPRO`]].map(mapper));
  }

  async function changeNetworkOptions(networkAddress, tokens) {
    const {DEPLOY_LOCK_AMOUNT_FOR_NETWORK_CREATION, DEPLOY_DRAFT_TIME, DEPLOY_DISPUTABLE_TIME, DEPLOY_COUNCIL_AMOUNT} = env;
    const network = new Network_v2(connection, networkAddress);
    await network.loadContract();
    await Promise.all([
      [`changeDraftTime`, DEPLOY_DRAFT_TIME],
      [`changeDisputableTime`, DEPLOY_DISPUTABLE_TIME],
      [`changeCouncilAmount`, DEPLOY_COUNCIL_AMOUNT]
    ].map(([fn, value]) => network[fn](value)));

    [[tokens[0], true], ... tokens[1] !== nativeZeroAddress ? [tokens[1], false] : []]
      .map(([address, transactional]) => network.registry.addAllowedTokens(address, transactional));

    await network.registry.token.approve(network.registry.contractAddress, DEPLOY_LOCK_AMOUNT_FOR_NETWORK_CREATION);
    await network.registry.lock(DEPLOY_LOCK_AMOUNT_FOR_NETWORK_CREATION);
    await network.registry.registerNetwork(networkAddress);

    const nameSymbol = async (address) => {
      const token = new ERC20(connection, address);
      await token.loadContract();
      return ({name: await token.name(), symbol: await token.symbol()});
    }

    const tokenInfo =
      async (isTransactional, isReward, address) =>
        ({...await nameSymbol(address), isTransactional, isReward, address})

    const result = {
      network: networkAddress,
      registry: network.registry.contractAddress,
      payment: await tokenInfo(true, false, tokens[0]),
      governance: await tokenInfo(true, false, tokens[1]),
      reward: tokens[2] !== nativeZeroAddress ? await tokenInfo(true, false, tokens[2]) : {},
      bounty: {...await nameSymbol(tokens[3]), address: tokens[3]}
    }

    console.debug(`Deploying and Configurations finished`);
    console.debug(JSON.stringify(result, null, 2));

    return result;
  }

  async function saveSettingsToDb({registry, payment, governance, reward, bounty},) {
    const {NEXT_DB_USERNAME: username, NEXT_DB_PASSWORD: password, NEXT_DB_DATABASE: database, NEXT_DB_HOST, NEXT_DB_PORT} = env;

    const dbConfig = {
      dialect: 'postgres',
      username, password, database, host: NEXT_DB_HOST || 'localhost', port: NEXT_DB_PORT || 54320,
      ... NEXT_DB_HOST ? {dialectOptions: {ssl: {required: true, rejectUnauthorized: false}}} : {}
    }

    /* todo: use DB config to save needed information */
  }

  async function getTokens() {
    if (!options.deployTestTokens) {
      if (!hasGovernance || !hasPayment || !hasBountyNFT)
        throw new Error(`Missing one of (or all): governanceToken, paymentToken, bountyNFT`);

      return [options.paymentToken[option], options.governanceToken[option], nativeZeroAddress, options.bountyNFT[option]];
    }

    const tokens = [...Object.values(await deployTokens()), await deployBountyToken()];

    const mapper = async (address) => {
      const _token = new ERC20(connection, address);
      await _token.loadContract();
      return _token;
    }

    const transfers = async ([payment, governance, rwd]) => {
      for (const address of StagingAccounts) {
        console.debug(`Sending tokens to ${address}...`);
        await Promise.all([payment, governance, rwd].map(t => t.transferTokenAmount(address, 10000000)));
      }

      console.debug(`All tokens sent!`);
    }

    /** Slice the BountyNFT from the saveTokens array and send transfers */
    Promise.all(tokens.slice(0, 2).map(mapper)).then(transfers);

    return tokens;
  }

  const tokensToUse = await getTokens();

  await saveSettingsToDb( /** grab the result from having changed the network options and save it to db */
    await changeNetworkOptions( /** Load networkAddress and change settings on chain, return result */
      await deployNetwork(tokensToUse[0], /** deploy a network, return contractAddress */
        await deployRegistry(tokensToUse[1], tokensToUse[3])))); /** Deploy Registry, return contractAddress */

}

(async () => {
  for (let index = 0; index <= options.network.length - 1; index--)
    await main(index);
})()

