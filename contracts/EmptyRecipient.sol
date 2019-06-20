pragma solidity ^0.5.5;

import "./IRelayRecipient.sol";

contract EmptyRecipient {
    function acceptRelayedCall(address, address, bytes memory, uint, uint, bytes memory) public view returns (uint) {
        return 0; // OK
    }

    function preRelayedCall(address, address, bytes memory, uint) public returns (bytes32) {
    }

    function postRelayedCall(address, address, bytes memory, bool, uint, uint, bytes32) public {
    }

    function nop(uint256) external {
    }
}

