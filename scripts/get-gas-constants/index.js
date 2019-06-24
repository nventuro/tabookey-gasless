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

const TOTAL_RELAYCALL_GAS = new BN('10000000000');

async function main() {
  const vm = new VM();

  const relayHub = await deploy(vm, RelayHub);
  const recipient = await deploy(vm, EmptyRecipient);

  const owner = Wallet.generate();
  const relay = Wallet.generate();

  await call(vm, relayHub, 'stake', [toAddress(relay), '100000'], {
    from: owner,
    value: toWei('0.5', 'ether'),
  });

  await addBalance(vm, relay, toWei('0.1', 'ether'));

  await call(vm, relayHub, 'registerRelay', ['0x0a', ''], {
    from: relay,
  });

  await call(vm, relayHub, 'depositFor', [toAddress(recipient)], {
    value: toWei('1', 'ether')
  });

  const sender = Wallet.generate();

  await runDemoRelayCall(vm, relayHub, relay, sender, recipient);

  const stepper = new Stepper(vm);
  await runDemoRelayCall(vm, relayHub, relay, sender, recipient);

  console.log(`${stepper.blocks.length} checkpoints:`);
  for (const block of stepper.blocks) {
    console.log(`- ${block.type}\t${block.usedGas}`);
  }
}

const nextRelayHubNonce = new WeakMap();

async function runDemoRelayCall(vm, relayHub, relay, sender, recipient) {
  const nonce = nextRelayHubNonce.get(sender) || 0;
  nextRelayHubNonce.set(sender, nonce + 1);

  const args = [
    toAddress(sender),                        // address from,
    toAddress(recipient),                     // address recipient,
    recipient.methods.nop(0).encodeABI(),     // bytes memory encodedFunction,
    '0',                                      // uint256 transactionFee,
    '1',                                      // uint256 gasPrice,
    '8000000',                                // uint256 gasLimit,
    nonce.toString(),                         // uint256 nonce,
  ];

  const hash = await getTransactionHash(...args, toAddress(relayHub), toAddress(relay));
  const sig = web3EthSign(sender, fromHex(hash));

  await call(vm, relayHub, 'relayCall', [...args, sig], {
    from: relay,
    gasLimit: TOTAL_RELAYCALL_GAS,
    gasPrice: new BN('1'),
  });
}

class Stepper {
  constructor(vm) {
    this.running = false;

    const step = this.step.bind(this);
    const beforeTx = this.beforeTx.bind(this);
    const afterTx = this.afterTx.bind(this);

    vm.on('beforeTx', beforeTx);
    vm.on('step', step);
    vm.on('afterTx', afterTx);
  }

  beforeTx(tx) {
    if (this.running) {
      // shouldn't happen. sanity check
      throw new Error('Concurrent vm usage');
    }

    this.running = true;
    this.blocks = [{ type: 'begin', beginGas: new BN(tx.gasLimit) }];
    this.prevOpcode = undefined;
    this.seen = {};
  }

  step(data) {
    const { gasLeft } = data;
    const { name: opcode, fee: currentFee } = data.opcode;

    if (this.seen[opcode] === undefined) {
      this.seen[opcode] = 0;
    }

    // if (data.opcode.dynamic) {
    //   console.log(data.opcode.name);
    // }

    if (
      this.prevOpcode &&
      isCheckpoint(this.prevOpcode, this.seen[this.prevOpcode] - 1)
    ) {
      const type = this.prevOpcode === 'GAS' ? 'gas' : 'yield';
      this.blocks.push({ type, beginGas: gasLeft });
    }

    // console.log(opcode, this.seen[opcode]);

    if (isCheckpoint(opcode, this.seen[opcode])) {
      const block = this.blocks[this.blocks.length - 1];
      block.yieldGas = gasLeft.sub(new BN(currentFee));
      block.usedGas = block.beginGas.sub(block.yieldGas);
    }

    this.seen[opcode] += 1;
    this.prevOpcode = opcode;
  }

  afterTx() {
    this.running = false;
  }
}

function isCheckpoint(opcode, timesSeen) {
  // ignore the first staticcall, it's a call to the ecrecover precompile
  if (opcode === 'STATICCALL' && timesSeen === 0) {
    return false;
  }

  const isYield = ['CALL', 'STATICCALL', 'RETURN', 'STOP'].includes(opcode);

  if (isYield) {
    return true;
  }

  if (opcode === 'GAS') {
    if ([0, 2, 4, 5, 6].includes(timesSeen)) {
      return true;
    }
  }

  return false;
}

async function deploy(vm, contract) {
  const { createdAddress } = await runTx(vm, {
    to: null,
    data: contract.options.data,
  });

  const instance = contract.clone();
  instance.address = createdAddress;

  return instance;
}

async function call(vm, contract, fn, args = [], opts = {}) {
  const data = contract.methods[fn](...args).encodeABI();

  const res = await runTx(vm, Object.assign({}, opts, {
    data, to: contract.address
  }));

  if (res.vm.exceptionError) {
    let reason;
    // we decode only if it's a normal revert reason
    if (res.vm.return.slice(0, 4).equals(fromHex('0x08c379a0'))) {
      reason = res.vm.return.slice(4 + 32 + 32);
    } else {
      reason = toHex(res.vm.return);
    }

    throw new Error(`Transaction reverted (${reason})`);
  }

  const returnType = contract.options.jsonInterface.find(f => f.name === fn).outputs.map(o => o.type);
  res.decodedReturn = abi.rawDecode(returnType, res.vm.return);

  return res;
}

const nextNonce = new WeakMap();

async function runTx(vm, opts) {
  // set defaults
  const {
    to,
    data = '0x',
    value = '0',
    from = Wallet.generate(),
    gasLimit = new BN('100000000000'), // effectively infinit gas
    gasPrice = new BN('0'),
  } = opts;

  const nonce = nextNonce.get(from) || 0;
  nextNonce.set(from, nonce + 1);

  // give the sender enough balance for the value transfer
  await addBalance(vm, from, value);

  const tx = new Transaction({
    nonce: toHex(nonce),
    gasPrice,
    gasLimit,
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

function toAddress(x) {
  if (x instanceof Buffer || typeof x === 'number') {
    return toHex(x);
  }

  if (x instanceof Wallet) {
    return x.getAddressString();
  }

  if (x instanceof Web3Contract) {
    return toHex(x.address);
  }

  throw new Error('Cannot convert to address');
}

function toHex(x) {
  if (x instanceof Buffer) {
    return '0x' + x.toString('hex');
  } else if (typeof x === 'number') {
    return '0x' + x.toString(16);
  }
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
