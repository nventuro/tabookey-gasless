const VM = require('ethereumjs-vm');
const Transaction = require('ethereumjs-tx')
const Wallet = require('ethereumjs-wallet');
const Account = require('ethereumjs-account');
const abi = require('ethereumjs-abi');
const util = require('ethereumjs-util');
const Web3Contract = require('web3-eth-contract');

const { BN, toWei } = require('web3-utils');

const pify = require('./pify');
const path = require('path');

const { getTransactionHash } = require('../../src/js/relayclient/utils');

const RelayHub = requireContract('RelayHub');
const EmptyRecipient = requireContract('EmptyRecipient');

async function main() {
  const vm = new VM();

  const relayHub = await deploy(vm, RelayHub);
  const recipient = await deploy(vm, EmptyRecipient);

  const owner = Wallet.generate();
  const relay = Wallet.generate();

  // console.log((await call(vm, relayHub, 'version', [], { value: '0x00' })).decodedReturn);

  await call(vm, relayHub, 'stake', [relay.getAddressString(), '100000'], {
    from: owner,
    value: toWei('0.5', 'ether'),
  });

  await addBalance(vm, relay, toWei('0.1', 'ether'));

  await call(vm, relayHub, 'registerRelay', ['0x0a', ''], {
    from: relay,
  });

  await call(vm, relayHub, 'depositFor', [toHex(recipient.address)], { value: toWei('1', 'ether') });

  const sender = Wallet.generate();

  // address from,
  // address recipient,
  // bytes memory encodedFunction,
  // uint256 transactionFee,
  // uint256 gasPrice,
  // uint256 gasLimit,
  // uint256 nonce,
  // bytes memory approval

  const args = [
    sender.getAddressString(),
    toHex(recipient.address),
    recipient.methods.nop(0).encodeABI(),
    '0',
    '0',
    '8000000',
    '0',
  ];

  const hash = await getTransactionHash(...args, toHex(relayHub.address), relay.getAddressString());
  const sig = web3EthSign(sender, fromHex(hash));

  vm.on('step', function (data) {
    if (data.opcode.name === 'GAS') {
      console.log(`gasleft #${n}`, data.gasLeft.toString());
    }
  });

  await call(vm, relayHub, 'relayCall', [...args, sig], {
    from: relay,
  });
}

async function deploy(vm, contract) {
  const deployer = Wallet.generate();

  const tx = new Transaction({
    nonce: '0x00',
    gasPrice: '0x00',
    gasLimit: '0x800000000000', // we want effectively infinit gas
    to: null,
    value: '0x00',
    data: contract.options.data,
  });

  tx.sign(deployer.getPrivateKey());

  const { createdAddress } = await pify(vm).runTx({ tx, skipBalance: true });

  const instance = contract.clone();
  instance.address = createdAddress;

  return instance;
}

async function call(vm, contract, fn, args = [], opts = {}) {
  const data = contract.methods[fn](...args).encodeABI();

  const res = await runTx(vm, Object.assign({}, opts, { data, to: contract.address }));

  if (res.vm.exceptionError) {
    let reason;
    // we decode only if it's a normal revert reason
    if (res.vm.return.slice(0, 4).equals(Buffer.from('08c379a0', 'hex'))) {
      reason = res.vm.return.slice(4 + 32 + 32);
    } else {
      reason = res.vm.return.toString('hex');
    }

    throw new Error(`Transaction reverted (${reason})`);
  }

  const returnType = contract.options.jsonInterface.find(f => f.name === fn).outputs.map(o => o.type);
  res.decodedReturn = abi.rawDecode(returnType, res.vm.return);

  return res;
}

const nextNonce = new WeakMap();

async function runTx(vm, opts) {
  const {
    to,
    data = '0x',
    value = '0',
    from = Wallet.generate(),
  } = opts;

  const nonce = nextNonce.get(from) || 0;
  nextNonce.set(from, nonce + 1);

  // give the sender enough balance for the value transfer
  await addBalance(vm, from, value);

  const tx = new Transaction({
    nonce: '0x' + nonce.toString(16),
    gasPrice: '0x00',
    gasLimit: '0x800000000000', // we want effectively infinit gas
    to,
    value: new BN(value).toBuffer(),
    data,
  });

  tx.sign(from.getPrivateKey());

  // we set skipBalance because there is not enough balance for the gas limit
  return await pify(vm).runTx({ tx, skipBalance: true });
}

async function addBalance(vm, wallet, balance) {
  const account = await pify(vm.stateManager).getAccount(wallet.getAddress());
  const newBalance = new BN(account.balance).add(new BN(balance));
  account.balance = newBalance.toBuffer();
  await pify(vm.stateManager).putAccount(wallet.getAddress(), account);
}

function toHex(buf) {
  return '0x' + buf.toString('hex');
}

function fromHex(str) {
  return Buffer.from(str.replace(/^0x/, ''), 'hex');
}

function requireContract(name) {
  const { abi, bytecode } = require(`../../build/contracts/${name}.json`);
  return new Web3Contract(abi, { data: bytecode });
}

function web3EthSign(wallet, msg) {
  const sig = util.ecsign(util.hashPersonalMessage(msg), wallet.getPrivateKey())
  return toHex(Buffer.concat([Buffer.from([sig.v]), sig.r, sig.s]));
}

main().catch(console.error);
