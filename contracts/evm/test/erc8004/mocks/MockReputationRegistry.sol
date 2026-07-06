// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal stand-in for the canonical ERC-8004 ReputationRegistry.
/// @dev Records `msg.sender` as the feedback author (like the real registry), exposes
///      `getLastIndex`, and supports `revokeFeedback` with double-revoke protection so the
///      gateway's idempotent revoke path can be exercised.
contract MockReputationRegistry {
    struct Feedback {
        uint256 agentId;
        address client;
        int128 value;
        bytes32 feedbackHash;
    }

    Feedback[] public feedbacks;
    mapping(uint256 => mapping(address => uint64)) public lastIndex;
    // keccak(agentId, client, index) => revoked
    mapping(bytes32 => bool) public revoked;

    event GaveFeedback(uint256 indexed agentId, address indexed client, int128 value, bytes32 feedbackHash);
    event RevokedFeedback(uint256 indexed agentId, address indexed client, uint64 feedbackIndex);

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32 feedbackHash
    ) external {
        feedbacks.push(Feedback({agentId: agentId, client: msg.sender, value: value, feedbackHash: feedbackHash}));
        lastIndex[agentId][msg.sender] += 1;
        emit GaveFeedback(agentId, msg.sender, value, feedbackHash);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex != 0 && feedbackIndex <= lastIndex[agentId][msg.sender], "index out of bounds");
        bytes32 key = keccak256(abi.encode(agentId, msg.sender, feedbackIndex));
        require(!revoked[key], "Already revoked");
        revoked[key] = true;
        emit RevokedFeedback(agentId, msg.sender, feedbackIndex);
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return lastIndex[agentId][clientAddress];
    }

    function isRevoked(uint256 agentId, address client, uint64 feedbackIndex) external view returns (bool) {
        return revoked[keccak256(abi.encode(agentId, client, feedbackIndex))];
    }

    function feedbackCount() external view returns (uint256) {
        return feedbacks.length;
    }
}
