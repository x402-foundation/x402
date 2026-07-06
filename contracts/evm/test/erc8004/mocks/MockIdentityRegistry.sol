// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IIdentityRegistry} from "../../../src/erc8004/interfaces/IIdentityRegistry.sol";

contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) private _owners;
    mapping(uint256 => mapping(address => bool)) private _operators;

    function setOwner(uint256 agentId, address owner) external {
        _owners[agentId] = owner;
    }

    function setOperator(uint256 agentId, address operator, bool enabled) external {
        _operators[agentId][operator] = enabled;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _owners[agentId];
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address owner = _owners[agentId];
        if (owner == address(0)) return false;
        return spender == owner || _operators[agentId][spender];
    }
}
