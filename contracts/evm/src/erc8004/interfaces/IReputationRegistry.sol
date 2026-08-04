// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal view of the canonical ERC-8004 ReputationRegistry (deployed v2).
/// @dev Feedback is keyed by `msg.sender` (the author). `getLastIndex` returns the latest
///      1-indexed feedback index for `(agentId, clientAddress)`; `revokeFeedback` flips the
///      `isRevoked` flag on an existing slot (no shift/renumber).
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
}
