pragma solidity >=0.4.0 <0.6.0;

import "./RelayHubApi.sol";
import "./RelayRecipient.sol";
import "./GsnUtils.sol";
import "./RLPReader.sol";
import "@0x/contracts-utils/contracts/src/LibBytes.sol";

contract RelayHub is RelayHubApi {

    // Anyone can call certain functions in this singleton and trigger relay processes.

    uint constant minimum_stake = 0.1 ether;    // XXX TBD
    uint constant minimum_unstake_delay = 0;    // XXX TBD
    uint constant minimum_relay_balance = 0.5 ether;  // XXX TBD - can't register/refresh below this amount.
    uint constant public gas_reserve = 99999; // XXX TBD - calculate how much reserve we actually need, to complete the post-call part of relay().
    uint constant public gas_overhead = 47396;  // the total gas overhead of relay(), before the first gasleft() and after the last gasleft(). Assume that relay has non-zero balance (costs 15'000 more otherwise).
    uint accept_relayed_call_max_gas = 50000;

    mapping (address => uint) public nonces;    // Nonces of senders, since their ether address nonce may never change.

    enum State {UNKNOWN, STAKED, REGISTERED, REMOVED, PENALIZED}
    // status flags for TransactionRelayed() event
    enum RelayCallStatus {OK, CanRelayFailed, RelayedCallFailed, PostRelayedFailed}
    enum CanRelayStatus {OK, WrongSignature, WrongNonce, AcceptRelayedCallUnkownError, AcceptRelayedCallReverted}

    struct Relay {
        uint stake;             // Size of the stake
        uint unstake_delay;     // How long between removal and unstaking
        uint unstake_time;      // When is the stake released.  Non-zero means that the relay has been removed and is waiting for unstake.
        address owner;
        uint transaction_fee;
        State state;
    }

    mapping (address => Relay) public relays;
    mapping (address => uint) public balances;

    function validate_stake(address relay) private view {
        require(relays[relay].state == State.STAKED || relays[relay].state == State.REGISTERED, "wrong state for stake");
        require(relays[relay].stake >= minimum_stake, "stake lower than minimum");
        require(relays[relay].unstake_delay >= minimum_unstake_delay, "delay lower than minimum");
    }

    function safe_add(uint a, uint b) internal pure returns (uint) {
        uint256 c = a + b;
        assert(c >= a);
        return c;
    }

    function safe_sub(uint a, uint b) internal pure returns (uint) {
        assert(b <= a);
        return a - b;
    }

    function get_nonce(address from) view external returns (uint) {
        return nonces[from];
    }

    /**
     * deposit ether for a contract.
     * This ether will be used to repay relay calls into this contract.
     * Contract owner should monitor the balance of his contract, and make sure
     * to deposit more, otherwise the contract won't be able to receive relayed calls.
     * Unused deposited can be withdrawn with `withdraw()`
     */
    function depositFor(address target) public payable {
        require(msg.value <= minimum_stake, "deposit too big");
        balances[target] += msg.value;
        require (balances[target] >= msg.value);
        emit Deposited(target, msg.value);
    }

    /**
     * withdraw funds.
     * caller is either a relay owner, withdrawing collected transaction fees.
     * or a RelayRecipient contract, withdrawing its deposit.
     * note that while everyone can `depositFor()` a contract, only
     * the contract itself can withdraw its funds.
     */
    function withdraw(uint amount) public {
        require(balances[msg.sender] >= amount, "insufficient funds");
        balances[msg.sender] -= amount;
        msg.sender.transfer(amount);
        emit Withdrawn(msg.sender, amount);
    }

    //check the deposit balance of a contract.
    function balanceOf(address target) external view returns (uint256) {
        return balances[target];
    }

    function stakeOf(address relay) external view returns (uint256) {
        return relays[relay].stake;
    }

    function ownerOf(address relay) external view returns (address) {
        return relays[relay].owner;
    }


    function stake(address relay, uint unstake_delay) external payable {
        // Create or increase the stake and unstake_delay
        require(relays[relay].owner == address(0) || relays[relay].owner == msg.sender, "not owner");
        require(msg.sender != relay, "relay cannot stake for itself");
        relays[relay].owner = msg.sender;
        relays[relay].stake += msg.value;
        // Make sure that the relay doesn't decrease his delay if already registered
        require(unstake_delay >= relays[relay].unstake_delay, "unstake_delay cannot be decreased");
        if (relays[relay].state == State.UNKNOWN) {
            relays[relay].state = State.STAKED;
        }
        relays[relay].unstake_delay = unstake_delay;
        validate_stake(relay);
        emit Staked(relay, msg.value);
    }

    function can_unstake(address relay) public view returns(bool) {
        return relays[relay].unstake_time > 0 && relays[relay].unstake_time <= now;  // Finished the unstaking delay period?
    }

    function unstake(address relay) public {
        require(can_unstake(relay), "can_unstake failed");
        require(relays[relay].owner == msg.sender, "not owner");
        uint amount = relays[relay].stake;
        delete relays[relay];
        msg.sender.transfer(amount);
        emit Unstaked(relay, amount);
    }

    function register_relay(uint transaction_fee, string memory url) public {
        // Anyone with a stake can register a relay.  Apps choose relays by their transaction fee, stake size and unstake delay,
        // optionally crossed against a blacklist.  Apps verify the relay's action in realtime.

        // Penalized relay cannot reregister
        validate_stake(msg.sender);
        require(msg.sender.balance >= minimum_relay_balance,"balance lower than minimum");
        require(msg.sender == tx.origin, "Contracts cannot register as relays");
        relays[msg.sender].unstake_time = 0;    // Activate the lock
        relays[msg.sender].state = State.REGISTERED;
        relays[msg.sender].transaction_fee = transaction_fee;
        emit RelayAdded(msg.sender, relays[msg.sender].owner, transaction_fee, relays[msg.sender].stake, relays[msg.sender].unstake_delay, url);
    }

    function remove_relay_by_owner(address relay) public {
        require(relays[relay].owner == msg.sender, "not owner");
        relays[relay].unstake_time = relays[relay].unstake_delay + now;   // Start the unstake counter
        if (relays[relay].state != State.PENALIZED) {
            relays[relay].state = State.REMOVED;
        }
        emit RelayRemoved(relay, relays[relay].unstake_time);
    }

	//check if the Hub can accept this relayed operation.
	// it validates the caller's signature and nonce, and then delegates to the destination's accept_relayed_call
	// for contract-specific checks.
	// returns "0" if the relay is valid. other values represent errors.
	// values 1..10 are reserved for can_relay. other values can be used by accept_relayed_call of target contracts.
    function can_relay(address relay, address from, RelayRecipient to, bytes memory encoded_function, uint transaction_fee, uint gas_price, uint gas_limit, uint nonce, bytes memory approval) public view returns(uint32) {
        bytes memory packed = abi.encodePacked("rlx:", from, to, encoded_function, transaction_fee, gas_price, gas_limit, nonce, address(this));
        bytes32 hashed_message = keccak256(abi.encodePacked(packed, relay));
        bytes32 signed_message = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hashed_message));
        if (!GsnUtils.checkSig(from, signed_message,  approval))  // Verify the sender's signature on the transaction
            return uint32(CanRelayStatus.WrongSignature);   // @from hasn't signed the transaction properly
        if (nonces[from] != nonce)
            return uint32(CanRelayStatus.WrongNonce);   // Not a current transaction.  May be a replay attempt.
        // XXX check @to's balance, roughly estimate if it has enough balance to pay the transaction fee.  It's the relay's responsibility to verify, but check here too.
        bytes memory accept_relayed_call_raw_tx = abi.encodeWithSelector(to.accept_relayed_call.selector, relay, from, encoded_function, gas_price, transaction_fee, approval);
        return handle_accept_relay_call(to,accept_relayed_call_raw_tx);
    }

    function handle_accept_relay_call(RelayRecipient to, bytes memory accept_relayed_call_raw_tx) private view returns (uint32){
        bool success;
        uint32 accept = uint32(CanRelayStatus.AcceptRelayedCallUnkownError);
        assembly {
            let ptr := mload(0x40)
            let accept_relayed_call_max_gas := sload(accept_relayed_call_max_gas_slot)
            success := staticcall(accept_relayed_call_max_gas, to, add(accept_relayed_call_raw_tx, 0x20), mload(accept_relayed_call_raw_tx), ptr, 0x20)
            accept := and(mload(ptr),0xffffffff)
        }
        if (!success){
            return uint32(CanRelayStatus.AcceptRelayedCallReverted);
        }
        return accept;
    }

    /**
     * relay a transaction.
     * @param from the client originating the request.
     * @param to the target RelayRecipient contract.
     * @param encoded_function the function call to relay.
     * @param transaction_fee fee (%) the relay takes over actual gas cost.
     * @param gas_price gas price the client is willing to pay
     * @param gas_limit limit the client want to put on its transaction
     * @param transaction_fee fee (%) the relay takes over actual gas cost.
     * @param nonce sender's nonce (in nonces[])
     * @param approval client's signature over all params (first 65 bytes). The remainder is dapp-specific data.
     */
    function relay(address from, address to, bytes memory encoded_function, uint transaction_fee, uint gas_price, uint gas_limit, uint nonce, bytes memory approval) public {
        uint initial_gas = gasleft();
        require(relays[msg.sender].state == State.REGISTERED, "Unknown relay");  // Must be from a known relay
        require(gas_price <= tx.gasprice, "Invalid gas price");      // Relay must use the gas price set by the signer

        uint32 can_relay_result = can_relay(msg.sender, from, RelayRecipient(to), encoded_function, transaction_fee, gas_price, gas_limit, nonce, approval);
        if (can_relay_result != 0) {
            emit TransactionRelayed(msg.sender, from, to, keccak256(encoded_function), uint(RelayCallStatus.CanRelayFailed), 0);
            return;
        }

        // ensure that the last bytes of @transaction are the @from address.
        // Recipient will trust this reported sender when msg.sender is the known RelayHub.

        // gas_reserve must be high enough to complete relay()'s post-call execution.
        require(safe_sub(initial_gas,gas_limit) >= gas_reserve, "Not enough gasleft()");
        bool success_post;
        bytes memory ret = new bytes(32);
        (success_post,ret) = address(this).call(abi.encodeWithSelector(this.recipient_calls.selector,from,to,msg.sender,encoded_function,transaction_fee,gas_limit,initial_gas));
        nonces[from]++;
        RelayCallStatus status = RelayCallStatus.OK;
        if (LibBytes.readUint256(ret,0) == 0)
            status = RelayCallStatus.RelayedCallFailed;
        // Relay transaction_fee is in %.  E.g. if transaction_fee=40, payment will be 1.4*used_gas.
        uint charge = (gas_overhead+initial_gas-gasleft())*gas_price*(100+transaction_fee)/100;
        if (!success_post){
            emit TransactionRelayed(msg.sender, from, to, keccak256(encoded_function), uint(RelayCallStatus.PostRelayedFailed), charge);
        }else{
            emit TransactionRelayed(msg.sender, from, to, keccak256(encoded_function), uint(status), charge);
        }
        require(balances[to] >= charge, "insufficient funds");
        balances[to] -= charge;
        balances[relays[msg.sender].owner] += charge;
    }

    function recipient_calls(address from, address to, address relay_addr, bytes calldata encoded_function, uint transaction_fee, uint gas_limit, uint initial_gas) external returns (bool) {
        require(msg.sender == address(this), "Only RelayHub should call this function");

        // ensure that the last bytes of @transaction are the @from address.
        // Recipient will trust this reported sender when msg.sender is the known RelayHub.
        bytes memory transaction = abi.encodePacked(encoded_function,from);
        bool success;
        bool success_post;
        uint balance_before = balances[to];
        (success, ) = to.call.gas(gas_limit)(transaction); // transaction must end with @from at this point
        transaction = abi.encodeWithSelector(RelayRecipient(to).post_relayed_call.selector, relay_addr, from, encoded_function, success, (gas_overhead+initial_gas-gasleft()), transaction_fee);
        (success_post, ) = to.call.gas((gas_overhead+initial_gas-gasleft()))(transaction);
        require(success_post, "post_relayed_call reverted - reverting the relayed transaction");
        require(balance_before <= balances[to], "Moving funds during relayed transaction disallowed");
        return success;
    }

    struct Transaction {
        uint nonce;
        uint gas_price;
        uint gas_limit;
        address to;
        uint value;
        bytes data;
    }

    function decode_transaction (bytes memory raw_transaction) private pure returns ( Transaction memory transaction) {
        (transaction.nonce,transaction.gas_price,transaction.gas_limit,transaction.to, transaction.value, transaction.data) = RLPReader.decode_transaction(raw_transaction);
        return transaction;

    }

    function penalize_repeated_nonce(bytes memory unsigned_tx1, bytes memory sig1 ,bytes memory unsigned_tx2, bytes memory sig2) public {
        // Can be called by anyone.  
        // If a relay attacked the system by signing multiple transactions with the same nonce (so only one is accepted), anyone can grab both transactions from the blockchain and submit them here.
        // Check whether unsigned_tx1 != unsigned_tx2, that both are signed by the same address, and that unsigned_tx1.nonce == unsigned_tx2.nonce.  If all conditions are met, relay is considered an "offending relay".
        // The offending relay will be unregistered immediately, its stake will be forfeited and given to the address who reported it (msg.sender), thus incentivizing anyone to report offending relays.
        // If reported via a relay, the forfeited stake is split between msg.sender (the relay used for reporting) and the address that reported it.

        Transaction memory decoded_tx1 = decode_transaction(unsigned_tx1);
        Transaction memory decoded_tx2 = decode_transaction(unsigned_tx2);

        bytes32 hash1 = keccak256(abi.encodePacked(unsigned_tx1));
        address addr1 = ecrecover(hash1, uint8(sig1[0]), LibBytes.readBytes32(sig1,1), LibBytes.readBytes32(sig1,33));

        bytes32 hash2 = keccak256(abi.encodePacked(unsigned_tx2));
        address addr2 = ecrecover(hash2, uint8(sig2[0]), LibBytes.readBytes32(sig2,1), LibBytes.readBytes32(sig2,33));

        //checking that the same nonce is used in both transaction, with both signed by the same address and the actual data is different
        // note: we compare the hash of the data to save gas over iterating both byte arrays
        require( decoded_tx1.nonce == decoded_tx2.nonce, "Different nonce");
        require(addr1 == addr2, "Different signer");
        require(keccak256(abi.encodePacked(decoded_tx1.data)) != keccak256(abi.encodePacked(decoded_tx2.data)), "tx.data is equal" ) ;
        penalize_internal(addr1);
    }

    function penalize_illegal_transaction(bytes memory unsigned_tx1, bytes memory sig1) public {
        // Externally-owned accounts that are registered as relays are not allowed to perform
        // any transactions other than 'relay' and 'register_relay'. They have no legitimate
        // reasons to do that, so this behaviour is too suspicious to be left unattended.
        // It is enforced by penalizing the relay for a transaction that we consider illegal.
        // Note: If you add  another valid function call to RelayHub, you must add a selector
        // of the function you would like to declare as legal!

        Transaction memory decoded_tx1 = decode_transaction(unsigned_tx1);
        if (decoded_tx1.to == address(this)){
            bytes4 selector = GsnUtils.getMethodSig(decoded_tx1.data);
            require (selector != this.relay.selector && selector != this.register_relay.selector, "Legal relay transaction");
        }
        bytes32 hash = keccak256(abi.encodePacked(unsigned_tx1));
        address addr = ecrecover(hash, uint8(sig1[0]), LibBytes.readBytes32(sig1,1), LibBytes.readBytes32(sig1,33));
        penalize_internal(addr);
    }

    function penalize_internal(address addr1) private {
        // Checking that we do have addr1 as a staked relay
        require(relays[addr1].stake > 0, "Unstaked relay");
        // Checking that the relay wasn't penalized yet
        require(relays[addr1].state != State.PENALIZED, "Relay already penalized");
        // compensating the sender with the stake of the relay
        uint amount = relays[addr1].stake;
        // move ownership of relay
        relays[addr1].owner = msg.sender;
        relays[addr1].state = State.PENALIZED;
        emit Penalized(addr1, msg.sender, amount);
        remove_relay_by_owner(addr1);
    }
}
