// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IERC3009} from "../interfaces/IERC3009.sol";
import {ISignatureTransfer} from "../interfaces/ISignatureTransfer.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IFeedbackGateway} from "./interfaces/IFeedbackGateway.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";

/// @notice Minimal view of the canonical x402ExactPermit2Proxy `settle` entrypoint.
/// @dev Struct layout (to, validAfter) matches x402ExactPermit2Proxy.Witness so the ABI
///      encoding is identical to the standard x402 Permit2 flow.
interface IX402ExactPermit2Proxy {
    struct Witness {
        address to;
        uint256 validAfter;
    }

    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external;
}

/// @title FeedbackGateway
/// @notice One contract: settles x402 payments, mints/consumes single-use tickets, and submits
///         (and revokes) ticket-gated feedback on the canonical ERC-8004 ReputationRegistry.
/// @dev The gateway itself calls `giveFeedback`, so the registry records `clientAddress ==
///      address(this)`. The real payer is recovered off-chain by joining `TicketConsumed`
///      (carries `payer` + `feedbackHash`) to the registry's `NewFeedback` on `feedbackHash`.
///      Replaces the prior two-contract (X402AgentReputation + EIP-7702 delegate) design; no
///      delegation, so `address(this)` is stable and OZ `EIP712` is safe.
contract FeedbackGateway is IFeedbackGateway, Ownable, EIP712 {
    using ECDSA for bytes32;

    IX402ExactPermit2Proxy public immutable PERMIT2_PROXY;
    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;

    mapping(uint256 => Ticket) private _tickets;
    mapping(uint256 => FeedbackRef) public feedbackRef;
    mapping(bytes32 => bool) public usedFeedbackHashes;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    uint256 private _nextTicketId = 1;

    bytes32 private constant FEEDBACK_INTENT_TYPEHASH = keccak256(
        "FeedbackIntent(address registry,uint256 ticketId,uint256 agentId,address payer,int128 value,uint8 valueDecimals,bytes32 tag1Hash,bytes32 tag2Hash,bytes32 endpointHash,bytes32 feedbackURIHash,bytes32 feedbackHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant REVOKE_INTENT_TYPEHASH =
        keccak256("RevokeIntent(address payer,uint256 ticketId,uint256 nonce,uint256 deadline)");

    error InvalidPayment();
    error InvalidPermit2();
    error InvalidAgent();
    error InvalidTicket();
    error SelfFeedbackNotAllowed();
    error ZeroAddress();
    error PayToMismatch();
    error Unauthorized();
    error DuplicateFeedbackHash();
    error UnknownFeedback();
    error IntentExpired();
    error NonceUsed();
    error InvalidSignature();
    error RegistryMismatch();
    error ParamsMismatch();
    error AgentMismatch();

    /// @param owner_ Reserved admin handle (currently no privileged functions).
    /// @param permit2Proxy_ Canonical x402ExactPermit2Proxy; `address(0)` disables Permit2 settlement.
    /// @param identityRegistry_ ERC-8004 identity registry; `agentId` must exist at mint time.
    /// @param reputationRegistry_ Canonical ERC-8004 ReputationRegistry feedback is submitted to.
    constructor(address owner_, address permit2Proxy_, address identityRegistry_, address reputationRegistry_)
        Ownable(owner_)
        EIP712("FeedbackGateway", "1")
    {
        if (identityRegistry_ == address(0) || reputationRegistry_ == address(0)) revert ZeroAddress();
        identityRegistry = IIdentityRegistry(identityRegistry_);
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        PERMIT2_PROXY = IX402ExactPermit2Proxy(permit2Proxy_);
    }

    // ----------------------------------------------------------------- settle + mint

    function settleAndMintTicketEIP3009(
        address payer,
        uint256 agentId,
        address agentAddress,
        EIP3009Settlement calldata settlement
    ) external returns (uint256 ticketId) {
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
    ) external returns (uint256 ticketId) {
        if (address(PERMIT2_PROXY) == address(0)) revert InvalidPermit2();
        address token = settlement.permit.permitted.token;
        uint256 amount = settlement.permit.permitted.amount;
        _validateMintPayment(payer, agentAddress, token, settlement.payTo, amount);

        PERMIT2_PROXY.settle(
            settlement.permit,
            payer,
            IX402ExactPermit2Proxy.Witness({to: settlement.payTo, validAfter: settlement.validAfter}),
            settlement.signature
        );

        ticketId = _mintTicket(payer, agentId, agentAddress, token, amount);
    }

    function tickets(uint256 ticketId) external view returns (Ticket memory) {
        return _tickets[ticketId];
    }

    function nextTicketId() external view returns (uint256) {
        return _nextTicketId;
    }

    function _validateMintPayment(
        address payer,
        address agentAddress,
        address token,
        address payTo,
        uint256 amount
    ) internal pure {
        if (
            payer == address(0) || agentAddress == address(0) || token == address(0) || payTo == address(0)
                || amount == 0
        ) {
            revert InvalidPayment();
        }
        if (payTo != agentAddress) revert PayToMismatch();
    }

    function _mintTicket(address payer, uint256 agentId, address agentAddress, address token, uint256 amount)
        internal
        returns (uint256 ticketId)
    {
        _requireAgentBinding(agentId, agentAddress);

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

    /// @dev Bind the ticket's `agentId` to the address that received payment.
    function _requireAgentBinding(uint256 agentId, address agentAddress) internal view {
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            if (owner != agentAddress) revert InvalidAgent();
        } catch {
            revert InvalidAgent();
        }
    }

    // ----------------------------------------------------------------- feedback

    /// @notice Self-paid: the ticket's payer submits their own feedback (pays gas).
    function submitFeedback(uint256 ticketId, FeedbackParams calldata params) external {
        if (_tickets[ticketId].payer != msg.sender) revert Unauthorized();
        _submitFeedback(msg.sender, ticketId, params);
    }

    /// @notice Sponsored: a relayer submits a client-signed `FeedbackIntent` (client pays no gas).
    function submitFeedbackFor(
        FeedbackIntent calldata intent,
        FeedbackParams calldata params,
        bytes calldata signature
    ) external {
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (intent.registry != address(reputationRegistry)) revert RegistryMismatch();
        if (intent.agentId != _tickets[intent.ticketId].agentId) revert AgentMismatch();
        if (usedNonces[intent.payer][intent.nonce]) revert NonceUsed();
        _requireParamsMatchIntent(intent, params);

        bytes32 digest = _hashTypedDataV4(_feedbackStructHash(intent));
        if (digest.recover(signature) != intent.payer) revert InvalidSignature();

        usedNonces[intent.payer][intent.nonce] = true;
        _submitFeedback(intent.payer, intent.ticketId, params);
    }

    function _requireParamsMatchIntent(FeedbackIntent calldata intent, FeedbackParams calldata params)
        internal
        pure
    {
        if (
            intent.value != params.value || intent.valueDecimals != params.valueDecimals
                || intent.feedbackHash != params.feedbackHash || intent.tag1Hash != keccak256(bytes(params.tag1))
                || intent.tag2Hash != keccak256(bytes(params.tag2))
                || intent.endpointHash != keccak256(bytes(params.endpoint))
                || intent.feedbackURIHash != keccak256(bytes(params.feedbackURI))
        ) revert ParamsMismatch();
    }

    function _feedbackStructHash(FeedbackIntent calldata intent) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FEEDBACK_INTENT_TYPEHASH,
                intent.registry,
                intent.ticketId,
                intent.agentId,
                intent.payer,
                intent.value,
                intent.valueDecimals,
                intent.tag1Hash,
                intent.tag2Hash,
                intent.endpointHash,
                intent.feedbackURIHash,
                intent.feedbackHash,
                intent.nonce,
                intent.deadline
            )
        );
    }

    /// @dev Consume the ticket (gating), dedup the hash, forward `giveFeedback` as the gateway,
    ///      capture the assigned index, and emit `TicketConsumed` carrying the real payer + hash.
    function _submitFeedback(address payer, uint256 ticketId, FeedbackParams calldata params) internal {
        uint256 agentId = _consumeTicketFor(ticketId, payer);

        if (usedFeedbackHashes[params.feedbackHash]) revert DuplicateFeedbackHash();
        usedFeedbackHashes[params.feedbackHash] = true;

        reputationRegistry.giveFeedback(
            agentId,
            params.value,
            params.valueDecimals,
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedbackURI,
            params.feedbackHash
        );

        // Sole submitter + same synchronous call => this equals the index just assigned.
        uint64 idx = reputationRegistry.getLastIndex(agentId, address(this));
        feedbackRef[ticketId] = FeedbackRef({agentId: agentId, feedbackIndex: idx, exists: true});

        emit TicketConsumed(ticketId, payer, agentId, _tickets[ticketId].agentAddress, params.feedbackHash);
    }

    /// @notice Revoke previously submitted feedback. Authorized by a client-signed `RevokeIntent`;
    ///         only the ticket's original payer can revoke. Relayable (client pays no gas).
    function revokeFeedbackFor(RevokeIntent calldata intent, bytes calldata signature) external {
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (usedNonces[intent.payer][intent.nonce]) revert NonceUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(REVOKE_INTENT_TYPEHASH, intent.payer, intent.ticketId, intent.nonce, intent.deadline))
        );
        if (digest.recover(signature) != intent.payer) revert InvalidSignature();
        if (_tickets[intent.ticketId].payer != intent.payer) revert Unauthorized();

        FeedbackRef memory ref = feedbackRef[intent.ticketId];
        if (!ref.exists) revert UnknownFeedback();

        usedNonces[intent.payer][intent.nonce] = true;

        // Idempotent: a registry "Already revoked" revert is treated as success.
        try reputationRegistry.revokeFeedback(ref.agentId, ref.feedbackIndex) {} catch {}

        emit FeedbackRevokedFor(intent.ticketId, intent.payer, ref.agentId, ref.feedbackIndex);
    }

    /// @dev Consume-once; `payer` must own the ticket; agent cannot review itself.
    function _consumeTicketFor(uint256 ticketId, address payer) internal returns (uint256 agentId) {
        Ticket storage ticket = _tickets[ticketId];
        if (ticket.payer == address(0) || ticket.consumed) revert InvalidTicket();
        if (ticket.payer != payer) revert InvalidTicket();
        if (identityRegistry.isAuthorizedOrOwner(payer, ticket.agentId)) revert SelfFeedbackNotAllowed();
        ticket.consumed = true;
        agentId = ticket.agentId;
    }
}
