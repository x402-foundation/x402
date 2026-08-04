// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}
