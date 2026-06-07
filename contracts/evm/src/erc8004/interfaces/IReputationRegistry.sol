// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal view of the canonical ERC-8004 ReputationRegistry `giveFeedback`.
/// @dev Matches the deployed registry (e.g. mainnet 0x8004BAa1…): feedback is keyed by
///      `msg.sender` (the client/author) and validated by the registry itself.
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
}
