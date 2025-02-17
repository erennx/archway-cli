// archway-cli/util/deploy.js

const _ = require('lodash');
const chalk = require('chalk');
const { prompts, PromptCancelledError } = require('../util/prompts');
const { spawn } = require('promisify-child-process');
const path = require('path');
const { copyFile, mkdir } = require('fs/promises');
const { pathExists } = require('../util/fs');
const { isJson, isArchwayAddress } = require('../util/validators');
const Config = require('../util/config');
const ScriptRunner = require('../util/scripts');
const Cargo = require('../clients/cargo');

const isValidDeployment = _.conforms({
  type: _.isString,
  chainId: _.isString,
  codeId: _.isNumber,
});
async function storeDeployment(deployment = {}) {
  if (!isValidDeployment(deployment)) {
    console.error(chalk`{red Invalid deployment config}`, deployment);
    throw new Error(`Could not save deployment data to config file`);
  }

  await Config.update(
    { developer: { deployments: [deployment] } },
    { arrayMode: 'prepend' }
  );
}

// TODO: move to the archwayd tx wrapper?
function getEventAttribute(transaction, eventType, attributeKey) {
  const { logs: [{ events = [] } = {},] = [], txhash } = transaction;
  const { attributes = [] } = events.find(event => event.type === eventType) || {};
  const { value } = attributes.find(attribute => attribute.key === attributeKey) || {};
  return { txhash, value };
}

async function promptRewardAddress(archwayd) {
  // if a rewardAddress is present in the config, this should
  // already be available when prompts.override() was called.
  const { rewardAddress } = await prompts({
    type: 'text',
    name: 'rewardAddress',
    message: chalk`Enter an address to receive developer rewards, or hit <enter> to list all accounts {reset.dim (e.g. "archway1...")}`,
    validate: value => _.isEmpty(_.trim(value)) || isArchwayAddress(_.trim(value)) || 'Invalid address',
    format: value => _.trim(value),
  });

  if (_.isEmpty(rewardAddress)) {
    await archwayd.keys.list();
    return await promptRewardAddress(archwayd);
  }

  return rewardAddress;
}

async function parseAndUpdateMetadata(archwayd, srcDApp) {
  const rewardAddress = await promptRewardAddress(archwayd);
  console.info(chalk`Address for dApp rewards: {cyan ${rewardAddress}}`);

  const dApp = { ...srcDApp, rewardAddress };
  await Config.update({ developer: { dApp } });
  return dApp;
}

function toBase64(value) {
  try {
    return Buffer.from(value).toString('base64');
  } catch (e) {
    console.error(e);
    throw new Error(`Could not encode initialization arguments ${value} to base64`);
  }
}

function buildInitArgs(args, { rewardAddress, gasRebate, collectPremium, premiumPercentage } = {}) {
  const initArgs = {
    reward_address: rewardAddress,
    gas_rebate_to_user: gasRebate,
    instantiation_request: toBase64(args),
    collect_premium: collectPremium,
    premium_percentage_charged: premiumPercentage
  };
  return JSON.stringify(initArgs);
}

async function parseContractInitArgs(archwayd, chainId, args, dApp) {
  if (_.isEmpty(dApp) || chainId !== 'constantine-1') {
    return args;
  }

  const updatedDappConfig = await parseAndUpdateMetadata(archwayd, dApp);
  return buildInitArgs(args, updatedDappConfig);
}

async function parseBech32Address(archwayd, address) {
  if (isArchwayAddress(address)) {
    return address;
  }

  console.info(chalk`Fetching address for wallet {cyan ${address}}...`);
  return await archwayd.keys.getAddress(address);
}

async function instantiateContract(archwayd, options = {}) {
  const {
    project: { id: projectId } = {},
    from,
    adminAddress,
    chainId,
    dApp,
    wasm: { codeId } = {}
  } = options;

  console.info(chalk`Instantiating {cyan ${projectId}} on {cyan ${chainId}} using wallet {cyan ${from}}...`);

  const { label, args } = await prompts([
    {
      type: 'text',
      name: 'label',
      message: chalk`Choose a label for this deployment {reset.dim (type <enter> to use the default)}`,
      initial: projectId,
      validate: value => !_.isEmpty(_.trim(value)) || 'Invalid deployment label',
      format: value => _.trim(value),
    },
    {
      type: 'text',
      name: 'args',
      message: chalk`JSON encoded arguments for contract initialization {reset.dim (e.g. \{ "count": 0 \})}`,
      initial: '{}',
      validate: value => isJson(value) || 'Invalid initialization args - inform a valid JSON string',
    },
  ]);

  const contractInitArgs = await parseContractInitArgs(archwayd, chainId, args, dApp);
  const bech32AdminAddress = await parseBech32Address(archwayd, adminAddress);
  const instantiateArgs = [codeId, contractInitArgs, '--label', label, '--admin', bech32AdminAddress];
  const transaction = await archwayd.tx.wasm('instantiate', instantiateArgs, options);
  const { txhash, value: contractAddress } = getEventAttribute(transaction, 'instantiate', '_contract_address');
  if (!txhash || !contractAddress) {
    throw new Error(`Failed to instantiate contract with code_id=${codeId} and args=${args}`);
  }

  await storeDeployment({
    type: 'instantiate',
    chainId: chainId,
    codeId: codeId,
    address: contractAddress,
    admin: bech32AdminAddress
  });

  console.info(chalk`{green Successfully instantiated contract with address {cyan ${contractAddress}} on tx hash {cyan ${txhash}} at {cyan ${chainId}}}\n`);

  if (_.isEmpty(dApp)) {
    console.warn(chalk`{whiteBright It is recommended that you now set the contract metadata using the {green.bold archway metadata} command}`);
  }

  return { contractAddress };
}

async function verifyUploadedWasm(archwayd, { chainId, node, wasm: { codeId, localPath, remotePath } = {} } = {}) {
  console.log(chalk`Validating artifact deployed to {cyan ${chainId}}...`);

  const downloadWasmName = `${path.basename(localPath, '.wasm')}_download.wasm`;
  const localDownloadPath = path.join(path.dirname(localPath), downloadWasmName);
  await archwayd.run('query', ['wasm', 'code', codeId, '--node', node, localDownloadPath]);

  // We need to update the path to where the docker container volume is mapped to
  const remoteDownloadPath = path.join(path.dirname(remotePath), downloadWasmName);
  if (!await pathExists(remoteDownloadPath)) {
    throw new Error(`Failed to locate downloaded wasm file at ${remoteDownloadPath}`);
  }

  const { stdout } = await spawn('diff', [remotePath, remoteDownloadPath], { encoding: 'utf8' });
  if (!_.isEmpty(stdout)) {
    console.error(chalk`{red Wasm file does not match uploaded file}`, stdout);
    throw new Error('Could not verify wasm artifact');
  }

  console.info(chalk`{green Integrity check Ok!}\n`);
}

async function storeWasm(archwayd, { project: { name } = {}, from, chainId, ...options } = {}) {
  console.info(chalk`Uploading optimized executable to {cyan ${chainId}} using wallet {cyan ${from}}...`);

  const fileName = `${name.replace(/-/g, '_')}.wasm`;
  const localPath = path.join('artifacts', fileName);
  const remotePath = path.join(archwayd.workingDir, localPath);
  // If we use docker or for any reason need to copy the file to any other directory before upload
  if (!_.isEmpty(path.relative(localPath, remotePath))) {
    console.info(`Copying file ${localPath} to ${remotePath}`);
    await mkdir(path.dirname(remotePath), { recursive: true });
    await copyFile(localPath, remotePath);
  }

  const transaction = await archwayd.tx.wasm('store', [localPath], { from, chainId, ...options });
  const { txhash, value: codeIdString } = getEventAttribute(transaction, 'store_code', 'code_id');
  const codeId = _.toNumber(codeIdString);
  if (!txhash || !codeId) {
    throw new Error(`Failed to upload wasm file ${fileName}`);
  }

  await storeDeployment({
    type: 'create',
    chainId: chainId,
    codeId: codeId,
  });

  console.info(chalk`{green Uploaded {cyan ${fileName}} on tx hash {cyan ${txhash}} at {cyan ${chainId}}}\n`);

  return { codeId, localPath, remotePath };
}

function spawnOptimizer(cargo, { network: { optimizers: { docker: { target, image } = {} } = {} } = {} } = {}) {
  const options = { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' };
  if (target && image) {
    // TODO: deprecate
    const targetSrc = path.basename(process.cwd()) + '_cache';
    return spawn('docker', [
      'run',
      '--rm',
      '-e', 'CARGO_TERM_COLOR=always',
      '-v', `${process.cwd()}:/code`,
      // Local project mount
      '--mount', `type=volume,source=${targetSrc},target=/code/target`,
      // Registry mount
      '--mount', `type=volume,source=registry_cache,target=${target}`,
      image
    ], options);
  } else {
    return cargo.runScript('optimize', options);
  }
}

async function buildWasm(cargo, config) {
  console.info('Building optimized wasm binary...\n');

  const optimizer = spawnOptimizer(cargo, config);
  optimizer.stdout.pipe(process.stdout);

  const { stdout } = await optimizer;
  if (!stdout.includes('done')) {
    throw new Error('Building optimized wasm binary failed');
  }

  console.info(chalk`{green Optimized wasm binary built successfully}\n`);
}

async function parseDeploymentOptions(cargo, config = {}, { adminAddress, confirm, args, label, defaultLabel, ...options } = {}) {
  if (!_.isEmpty(args) && !isJson(args)) {
    throw new Error(`Arguments should be a JSON string, received "${args}"`);
  }

  const project = await cargo.projectMetadata();
  if (_.isEmpty(project.name)) {
    console.debug('Project metadata:', project);
    throw new Error('Failed to resolve project metadata');
  }

  const {
    network: { chainId, urls: { rpc } = {}, gas } = {},
    developer: { dApp = {} } = {}
  } = config;
  const node = `${rpc.url}:${rpc.port}`;

  prompts.override({
    args,
    rewardAddress: dApp.rewardAddress || undefined,
    label: label || (defaultLabel && project.id) || undefined,
    ...options
  });
  const { from } = await prompts([
    {
      type: 'text',
      name: 'from',
      message: chalk`Send tx from which wallet in your keychain? {reset.dim (e.g. "main" or crtl+c to quit)}`,
      validate: value => !_.isEmpty(value.trim()) || 'Invalid wallet label',
      format: value => _.trim(value),
    },
  ]);

  const flags = [
    confirm || '--yes',
    // FIXME: --dry-run is not working as expected on archwayd
    // dryRun && '--dry-run',
  ].filter(_.isString);

  return {
    project,
    from,
    adminAddress: adminAddress || from,
    chainId,
    node,
    gas,
    dApp,
    flags
  }
}

async function deploy(archwayd, { build = true, verify = true, dryRun = false, ...options } = {}) {
  // TODO: call archwayd operations with the --dry-run flag
  if (dryRun) {
    console.info('Building wasm binary...\n');
    await new ScriptRunner().run('wasm');
    return;
  }

  const config = await Config.read();
  const cargo = new Cargo();

  build && await buildWasm(cargo, config);

  const deployOptions = await parseDeploymentOptions(cargo, config, options);

  const wasm = await storeWasm(archwayd, deployOptions);
  const deployedWasmConfig = { ...deployOptions, wasm };
  verify && await verifyUploadedWasm(archwayd, deployedWasmConfig);

  await instantiateContract(archwayd, deployedWasmConfig);
}

async function main(archwayd, options = {}) {
  try {
    await deploy(archwayd, options);
  } catch (e) {
    if (e instanceof PromptCancelledError) {
      console.warn(chalk`{yellow ${e.message}}`);
    } else {
      console.error(chalk`\n{red {bold Failed to deploy project}\n${e.stack}}`);
    }
  }
}

module.exports = main;
