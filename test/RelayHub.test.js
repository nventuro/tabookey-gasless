const { BN, ether, expectEvent, time } = require('openzeppelin-test-helpers');

const { getTransactionHash, getTransactionSignature } = require('../src/js/relayclient/utils')

const RelayHub = artifacts.require('RelayHub');
const SampleRecipient = artifacts.require('SampleRecipient');

contract('RelayHub', function ([_, relayOwner, relay, sender, other]) {
  const RelayCallStatusCodes = {
    OK: new BN('0'),
    CanRelayFailed: new BN('1'),
    RelayedCallFailed: new BN('2'),
    PreRelayedFailed: new BN('3'),
    PostRelayedFailed: new BN('4'),
    RecipientBalanceChanged: new BN('5'),
  };

  const PreconditionCheck = {
    OK: new BN('0'),
    WrongSignature: new BN('1'),
    WrongNonce: new BN('2'),
    AcceptRelayedCallReverted: new BN('3'),
    InvalidRecipientStatusCode: new BN('4'),
  };

  let relayHub;
  let recipient;

  beforeEach(async function () {
    relayHub = await RelayHub.new();
    recipient = await SampleRecipient.new(relayHub.address);
  });

  context('with staked relay', async function () {
    const unstakeDelay = time.duration.weeks(4);

    beforeEach(async function () {
      await relayHub.stake(relay, unstakeDelay, { value: ether('5'), from: relayOwner });
    });

    context('with registered relay', async function () {
      const url = 'http://relay.com';
      const fee = 10; // 10%

      beforeEach(async function () {
        await relayHub.registerRelay(fee, url, { from: relay });
      });

      describe('canRelay & relayCall', async function () {
        const message = 'GSN RelayHub';

        const gasPrice = new BN('10');
        const gasLimit = new BN('1000000');
        const senderNonce = new BN('0');

        let txData;
        let txHash;
        let signature;

        beforeEach(async function () {
          // truffle-contract doesn't let us create method data from the class, we need an actual instance
          txData = recipient.contract.methods.emitMessage(message).encodeABI();
        });

        async function getRelayTxData(overrides = {}) {
          let cfg = Object.assign({
            sender, recipient, txData, fee, gasPrice, gasLimit, senderNonce, relayHub, relay
          }, overrides);

          const txHash = await getTransactionHash(cfg.sender, cfg.recipient.address, cfg.txData, cfg.fee, cfg.gasPrice, cfg.gasLimit, cfg.senderNonce, cfg.relayHub.address, cfg.relay);
          const signature = await getTransactionSignature(web3, cfg.sender, txHash);

          return { txHash, signature };
        }

        context('with funded recipient', async function () {
          beforeEach(async function () {
            await relayHub.depositFor(recipient.address, { value: ether('1'), from: other });
          });

          it('relaying is aborted if the recipient returns an invalid status code', async function () {
            ({ txHash, signature } = await getRelayTxData());

            await recipient.setReturnInvalidErrorCode(true);
            const { logs } = await relayHub.relayCall(sender, recipient.address, txData, fee, gasPrice, gasLimit, senderNonce, signature, { from: relay, gasPrice, gasLimit });

            expectEvent.inLogs(logs, 'TransactionRelayed', {
              status: RelayCallStatusCodes.CanRelayFailed,
              chargeOrCanRelayStatus: PreconditionCheck.InvalidRecipientStatusCode
            });
          });

          it('relays', async function () {
            ({ txHash, signature } = await getRelayTxData());

            const { receipt, logs } = await relayHub.relayCall(sender, recipient.address, txData, fee, gasPrice, gasLimit, senderNonce, signature, { from: relay, gasPrice, gasLimit });

            expectEvent.inLogs(logs, 'TransactionRelayed', {
              status: RelayCallStatusCodes.OK,
            });

            await expectEvent.inTransaction(receipt.transactionHash, SampleRecipient, 'SampleRecipientEmitted');

            const ev2 = await expectEvent.inTransaction(receipt.transactionHash, SampleRecipient, 'SampleRecipientPostCall', {
              preRetVal: '0x000000000000000000000000000000000000000000000000000000000001e240',
            });
          });

          it('not works', async function () {
            // emit SampleRecipientEmitted(message, getSender(), msg.sender, tx.origin);
          });

          describe('recipient balance withdrawal ban', async function () {
            beforeEach(async function () {
              ({ txHash, signature } = await getRelayTxData());
            });

            it('reverts relayed call if recipient withdraws balance during preRelayedCall', async function () {
              await recipient.setWithdrawDuringPreRelayedCall(true);
              await assertRevertWithRecipientBalanceChanged();
            });

            it('reverts relayed call if recipient withdraws balance during the relayed call', async function () {
              await recipient.setWithdrawDuringRelayedCall(true);
              await assertRevertWithRecipientBalanceChanged();
            });

            it('reverts relayed call if recipient withdraws balance during postRelayedCall', async function () {
              await recipient.setWithdrawDuringPostRelayedCall(true);
              await assertRevertWithRecipientBalanceChanged();
            });

            async function assertRevertWithRecipientBalanceChanged() {
              const { logs } = await relayHub.relayCall(sender, recipient.address, txData, fee, gasPrice, gasLimit, senderNonce, signature, { from: relay, gasPrice, gasLimit });

              expectEvent.inLogs(logs, 'TransactionRelayed', { status: RelayCallStatusCodes.RecipientBalanceChanged});
            }
          });
        });
      });
    });
  });
});
