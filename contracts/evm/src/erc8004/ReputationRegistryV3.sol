// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {TicketMinter} from "./TicketMinter.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {ITicketMinter} from "./interfaces/ITicketMinter.sol";

/// @title ReputationRegistryV3
/// @notice Ticket-gated ERC-8004 feedback registry (standalone deployment for x402 integration).
contract ReputationRegistryV3 is EIP712 {
    using ECDSA for bytes32;

    int128 private constant MAX_ABS_VALUE = 1e38;

    bytes32 private constant FEEDBACK_INTENT_TYPEHASH = keccak256(
        "FeedbackIntent(uint256 ticketId,bytes32 interactionHash,int128 value,uint8 valueDecimals,bytes32 tag1Hash,bytes32 tag2Hash,bytes32 endpointHash,bytes32 feedbackURIHash,bytes32 feedbackHash,uint256 nonce,uint256 deadline)"
    );

    IIdentityRegistry public immutable identityRegistry;
    ITicketMinter public immutable ticketMinter;

    mapping(uint256 => mapping(address => mapping(bytes32 => bool))) private _usedFeedbackHash;
    mapping(address => mapping(uint256 => bool)) private _feedbackNonces;

    struct FeedbackSubmission {
        address payer;
        uint256 ticketId;
        bytes32 interactionHash;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    struct StoredFeedback {
        int128 value;
        uint8 valueDecimals;
        bool isDisputed;
        string tag1;
        string tag2;
    }

    mapping(uint256 => mapping(address => mapping(uint64 => StoredFeedback))) private _feedback;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash,
        uint256 ticketId
    );

    event FeedbackDisputed(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    error LegacyGiveFeedbackDisabled();
    error InvalidTicket();
    error FeedbackHashAlreadyUsed();
    error SelfFeedbackNotAllowed();
    error InvalidSignature();
    error IntentExpired();
    error InvalidNonce();
    error FeedbackNotFound();
    error AlreadyDisputed();
    error NotAgentAuthorized();
    error TooManyDecimals();
    error ValueTooLarge();
    error ZeroAddress();
    error InteractionHashMismatch();

    /// @param identityRegistry_ ERC-8004 identity registry.
    /// @param ticketMinterOwner_ Owner of the paired `TicketMinter` (facilitator allowlist).
    /// @param permit2_ Permit2 for the paired minter; `address(0)` disables Permit2 settlement.
    constructor(address identityRegistry_, address ticketMinterOwner_, address permit2_)
        EIP712("ERC8004ReputationV3", "2")
    {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        identityRegistry = IIdentityRegistry(identityRegistry_);
        ticketMinter = ITicketMinter(
            address(new TicketMinter(ticketMinterOwner_, permit2_, address(this), identityRegistry_))
        );
    }

    function giveFeedback(
        uint256,
        int128,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external pure {
        revert LegacyGiveFeedbackDisabled();
    }

    function giveFeedbackWithTicket(
        uint256 ticketId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 interactionHash,
        bytes32 feedbackHash
    ) external {
        _validateFeedbackValue(value, valueDecimals);
        uint256 agentId = _consumeTicketForFeedback(msg.sender, ticketId, interactionHash, feedbackHash);
        _storeFeedback(
            agentId, msg.sender, ticketId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    function giveFeedbackWithTicketFor(
        FeedbackSubmission calldata submission,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _verifyFeedbackIntent(submission, nonce, deadline, signature);
        _validateFeedbackValue(submission.value, submission.valueDecimals);
        uint256 agentId =
            _consumeTicketForFeedback(submission.payer, submission.ticketId, submission.interactionHash, submission.feedbackHash);
        _storeFeedbackFromSubmission(agentId, submission);
    }

    function disputeFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external {
        if (!identityRegistry.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAgentAuthorized();
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][clientAddress]) revert FeedbackNotFound();

        StoredFeedback storage fb = _feedback[agentId][clientAddress][feedbackIndex];
        if (fb.isDisputed) revert AlreadyDisputed();
        fb.isDisputed = true;

        emit FeedbackDisputed(agentId, clientAddress, feedbackIndex);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isDisputed)
    {
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][clientAddress]) revert FeedbackNotFound();
        StoredFeedback storage fb = _feedback[agentId][clientAddress][feedbackIndex];
        return (fb.value, fb.valueDecimals, fb.tag1, fb.tag2, fb.isDisputed);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return _lastIndex[agentId][clientAddress];
    }

    function _verifyFeedbackIntent(
        FeedbackSubmission calldata submission,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (block.timestamp > deadline) revert IntentExpired();
        if (_feedbackNonces[submission.payer][nonce]) revert InvalidNonce();

        bytes32 structHash = keccak256(
            abi.encode(
                FEEDBACK_INTENT_TYPEHASH,
                submission.ticketId,
                submission.interactionHash,
                submission.value,
                submission.valueDecimals,
                keccak256(bytes(submission.tag1)),
                keccak256(bytes(submission.tag2)),
                keccak256(bytes(submission.endpoint)),
                keccak256(bytes(submission.feedbackURI)),
                submission.feedbackHash,
                nonce,
                deadline
            )
        );

        address recovered = _hashTypedDataV4(structHash).recover(signature);
        if (recovered != submission.payer) revert InvalidSignature();
        _feedbackNonces[submission.payer][nonce] = true;
    }

    function _validateFeedbackValue(int128 value, uint8 valueDecimals) internal pure {
        if (valueDecimals > 18) revert TooManyDecimals();
        if (value < -MAX_ABS_VALUE || value > MAX_ABS_VALUE) revert ValueTooLarge();
    }

    function _storeFeedbackFromSubmission(uint256 agentId, FeedbackSubmission calldata submission) internal {
        uint64 feedbackIndex = ++_lastIndex[agentId][submission.payer];
        _feedback[agentId][submission.payer][feedbackIndex] = StoredFeedback({
            value: submission.value,
            valueDecimals: submission.valueDecimals,
            tag1: submission.tag1,
            tag2: submission.tag2,
            isDisputed: false
        });

        emit NewFeedback(
            agentId,
            submission.payer,
            feedbackIndex,
            submission.value,
            submission.valueDecimals,
            submission.tag1,
            submission.tag1,
            submission.tag2,
            submission.endpoint,
            submission.feedbackURI,
            submission.feedbackHash,
            submission.ticketId
        );
    }

    function _consumeTicketForFeedback(address payer, uint256 ticketId, bytes32 interactionHash, bytes32 feedbackHash)
        internal
        returns (uint256 agentId)
    {
        ITicketMinter.Ticket memory ticket = ticketMinter.tickets(ticketId);
        if (ticket.status != ITicketMinter.TicketStatus.MINTED) revert InvalidTicket();
        if (ticket.payer != payer) revert InvalidTicket();
        if (ticket.interactionHash != interactionHash) revert InteractionHashMismatch();
        if (identityRegistry.isAuthorizedOrOwner(payer, ticket.agentId)) revert SelfFeedbackNotAllowed();
        if (_usedFeedbackHash[ticket.agentId][payer][feedbackHash]) revert FeedbackHashAlreadyUsed();

        _usedFeedbackHash[ticket.agentId][payer][feedbackHash] = true;
        ticketMinter.consumeTicket(ticketId, payer);
        return ticket.agentId;
    }

    function _storeFeedback(
        uint256 agentId,
        address payer,
        uint256 ticketId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        uint64 feedbackIndex = ++_lastIndex[agentId][payer];
        _feedback[agentId][payer][feedbackIndex] =
            StoredFeedback({value: value, valueDecimals: valueDecimals, tag1: tag1, tag2: tag2, isDisputed: false});

        emit NewFeedback(agentId, payer, feedbackIndex, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash, ticketId);
    }
}
