// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {ISignatureTransfer} from "../interfaces/ISignatureTransfer.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IX402AgentReputation} from "./interfaces/IX402AgentReputation.sol";

interface IERC3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

/// @title X402AgentReputation
/// @notice Single wrapper: x402 settle + ticket mint + ticket-gated ERC-8004 feedback + dispute.
/// @dev Does not replace upstream `ReputationRegistry.giveFeedback` — direct feedback stays open there.
contract X402AgentReputation is IX402AgentReputation, EIP712, Ownable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    string public constant TICKET_WITNESS_TYPE_STRING =
        "TicketWitness witness)TicketWitness(address payer,uint256 agentId,address agentAddress,address payTo,uint256 validAfter)TokenPermissions(address token,uint256 amount)";

    bytes32 public constant TICKET_WITNESS_TYPEHASH = keccak256(
        "TicketWitness(address payer,uint256 agentId,address agentAddress,address payTo,uint256 validAfter)"
    );

    bytes32 private constant FEEDBACK_INTENT_TYPEHASH = keccak256(
        "FeedbackIntent(uint256 ticketId,int128 value,uint8 valueDecimals,bytes32 tag1Hash,bytes32 tag2Hash,bytes32 endpointHash,bytes32 feedbackURIHash,bytes32 feedbackHash,uint256 nonce,uint256 deadline)"
    );

    int128 private constant MAX_ABS_VALUE = 1e38;

    ISignatureTransfer public immutable PERMIT2;
    IIdentityRegistry public immutable identityRegistry;

    mapping(uint256 => Ticket) private _tickets;
    mapping(address => bool) public facilitators;
    mapping(uint256 => mapping(address => mapping(bytes32 => bool))) private _usedFeedbackHash;
    mapping(address => mapping(uint256 => bool)) private _feedbackNonces;

    struct StoredFeedback {
        int128 value;
        uint8 valueDecimals;
        bool isDisputed;
        string tag1;
        string tag2;
    }

    mapping(uint256 => mapping(address => mapping(uint64 => StoredFeedback))) private _feedback;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;

    uint256 private _nextTicketId = 1;

    error NotFacilitator();
    error InvalidPayment();
    error TicketNotMinted();
    error PayerMismatch();
    error PaymentTooEarly();
    error InvalidPermit2();
    error InvalidAgent();
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
    error PayToMismatch();

    modifier onlyFacilitator() {
        if (!facilitators[msg.sender]) revert NotFacilitator();
        _;
    }

    /// @param owner_ Owner controlling the facilitator allowlist.
    /// @param permit2_ Canonical Permit2 address; `address(0)` disables Permit2 settlement.
    /// @param identityRegistry_ ERC-8004 identity registry; `agentId` must exist at mint time.
    constructor(address owner_, address permit2_, address identityRegistry_) Ownable(owner_) EIP712("X402AgentReputation", "1") {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        identityRegistry = IIdentityRegistry(identityRegistry_);
        PERMIT2 = ISignatureTransfer(permit2_);
    }

    function setFacilitator(address facilitator, bool enabled) external onlyOwner {
        facilitators[facilitator] = enabled;
    }

    function settleAndMintTicket(
        address payer,
        uint256 agentId,
        address agentAddress,
        SettlePayment calldata payment
    ) external onlyFacilitator returns (uint256 ticketId) {
        _validateMintPayment(payer, agentAddress, payment.token, payment.payTo, payment.amount);
        IERC20(payment.token).safeTransferFrom(payer, payment.payTo, payment.amount);
        ticketId = _mintTicket(payer, agentId, agentAddress, payment.token, payment.amount);
    }

    function settleAndMintTicketEIP3009(
        address payer,
        uint256 agentId,
        address agentAddress,
        EIP3009Settlement calldata settlement
    ) external onlyFacilitator returns (uint256 ticketId) {
        _validateMintPayment(payer, agentAddress, settlement.token, settlement.payTo, settlement.value);
        IERC3009(settlement.token).transferWithAuthorization(
            payer,
            settlement.payTo,
            settlement.value,
            settlement.validAfter,
            settlement.validBefore,
            settlement.nonce,
            settlement.signature
        );
        ticketId = _mintTicket(payer, agentId, agentAddress, settlement.token, settlement.value);
    }

    function settleAndMintTicketPermit2(
        address payer,
        uint256 agentId,
        address agentAddress,
        Permit2Settlement calldata settlement
    ) external onlyFacilitator returns (uint256 ticketId) {
        if (address(PERMIT2) == address(0)) revert InvalidPermit2();
        address token = settlement.permit.permitted.token;
        uint256 amount = settlement.permit.permitted.amount;
        _validateMintPayment(payer, agentAddress, token, settlement.payTo, amount);
        if (block.timestamp < settlement.validAfter) revert PaymentTooEarly();

        bytes32 witnessHash = keccak256(
            abi.encode(
                TICKET_WITNESS_TYPEHASH, payer, agentId, agentAddress, settlement.payTo, settlement.validAfter
            )
        );

        ISignatureTransfer.SignatureTransferDetails memory transferDetails = ISignatureTransfer.SignatureTransferDetails({
            to: settlement.payTo,
            requestedAmount: amount
        });

        PERMIT2.permitWitnessTransferFrom(
            settlement.permit,
            transferDetails,
            payer,
            witnessHash,
            TICKET_WITNESS_TYPE_STRING,
            settlement.signature
        );

        ticketId = _mintTicket(payer, agentId, agentAddress, token, amount);
    }

    function giveFeedbackWithTicket(
        uint256 ticketId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        _validateFeedbackValue(value, valueDecimals);
        (uint256 agentId, uint64 feedbackIndex) =
            _consumeTicketForFeedback(msg.sender, ticketId, feedbackHash);
        _storeFeedback(agentId, msg.sender, feedbackIndex, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    function giveFeedbackWithTicketFor(
        FeedbackSubmission calldata submission,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        _verifyFeedbackIntent(submission, nonce, deadline, signature);
        _validateFeedbackValue(submission.value, submission.valueDecimals);
        (uint256 agentId, uint64 feedbackIndex) =
            _consumeTicketForFeedback(submission.payer, submission.ticketId, submission.feedbackHash);
        _storeFeedbackFromSubmission(agentId, submission, feedbackIndex);
    }

    function disputeFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external {
        if (!identityRegistry.isAuthorizedOrOwner(msg.sender, agentId)) revert NotAgentAuthorized();
        if (feedbackIndex == 0 || feedbackIndex > _lastIndex[agentId][clientAddress]) revert FeedbackNotFound();

        StoredFeedback storage fb = _feedback[agentId][clientAddress][feedbackIndex];
        if (fb.isDisputed) revert AlreadyDisputed();
        fb.isDisputed = true;

        emit FeedbackDisputed(agentId, clientAddress, feedbackIndex);
    }

    function tickets(uint256 ticketId) external view returns (Ticket memory) {
        return _tickets[ticketId];
    }

    function nextTicketId() external view returns (uint256) {
        return _nextTicketId;
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

    function _validateMintPayment(
        address payer,
        address agentAddress,
        address token,
        address payTo,
        uint256 amount
    ) internal pure {
        if (payer == address(0) || agentAddress == address(0) || token == address(0) || payTo == address(0) || amount == 0) {
            revert InvalidPayment();
        }
        if (payTo != agentAddress) revert PayToMismatch();
    }

    function _mintTicket(
        address payer,
        uint256 agentId,
        address agentAddress,
        address token,
        uint256 amount
    ) internal returns (uint256 ticketId) {
        _requireAgentExists(agentId);

        ticketId = _nextTicketId++;
        _tickets[ticketId] = Ticket({
            payer: payer,
            agentId: agentId,
            agentAddress: agentAddress,
            token: token,
            amount: amount,
            consumed: false
        });

        emit TicketMinted(ticketId, payer, agentId, agentAddress, token, amount);
    }

    function _requireAgentExists(uint256 agentId) internal view {
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert InvalidAgent();
        } catch {
            revert InvalidAgent();
        }
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

    function _consumeTicketForFeedback(address payer, uint256 ticketId, bytes32 feedbackHash)
        internal
        returns (uint256 agentId, uint64 feedbackIndex)
    {
        Ticket storage ticket = _tickets[ticketId];
        if (ticket.payer == address(0) || ticket.consumed) revert InvalidTicket();
        if (ticket.payer != payer) revert InvalidTicket();
        if (identityRegistry.isAuthorizedOrOwner(payer, ticket.agentId)) revert SelfFeedbackNotAllowed();
        if (_usedFeedbackHash[ticket.agentId][payer][feedbackHash]) revert FeedbackHashAlreadyUsed();

        _usedFeedbackHash[ticket.agentId][payer][feedbackHash] = true;
        ticket.consumed = true;

        feedbackIndex = ++_lastIndex[ticket.agentId][payer];
        emit TicketConsumed(ticketId, payer, ticket.agentId, feedbackIndex);

        return (ticket.agentId, feedbackIndex);
    }

    function _storeFeedback(
        uint256 agentId,
        address payer,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        _feedback[agentId][payer][feedbackIndex] = StoredFeedback({
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            isDisputed: false
        });

        emit NewFeedback(
            agentId, payer, feedbackIndex, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    function _storeFeedbackFromSubmission(uint256 agentId, FeedbackSubmission calldata submission, uint64 feedbackIndex)
        internal
    {
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
            submission.feedbackHash
        );
    }
}
