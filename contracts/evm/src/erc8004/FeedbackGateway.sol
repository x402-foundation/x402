// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IX402AgentReputation} from "./interfaces/IX402AgentReputation.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";

/// @title FeedbackGateway
/// @notice EIP-7702 delegate that turns a consumed x402 ticket into client-authored
///         feedback on the canonical ERC-8004 ReputationRegistry.
/// @dev A paying client delegates their EOA to this contract (EIP-7702 set-code auth). The
///      entrypoints then execute *in the client's EOA context*, so the calls to
///      `consumeTicket` and `giveFeedback` both run with `msg.sender == client` — feedback is
///      stored on the canonical registry and authored by the client, while the ticket gates it.
///
///      Deploy once per chain: a stateless singleton (no funds, only replay nonces). Because
///      delegation persists on the EOA until reset, the entrypoints are guarded — self-paid
///      requires the EOA itself (`msg.sender == address(this)`), sponsored requires a
///      client-signed EIP-712 `FeedbackIntent` binding the exact wrapper/registry/params.
contract FeedbackGateway {
    using ECDSA for bytes32;

    struct FeedbackParams {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    bytes32 private constant FEEDBACK_INTENT_TYPEHASH = keccak256(
        "FeedbackIntent(address wrapper,address registry,uint256 ticketId,int128 value,uint8 valueDecimals,bytes32 tag1Hash,bytes32 tag2Hash,bytes32 endpointHash,bytes32 feedbackURIHash,bytes32 feedbackHash,uint256 nonce,uint256 deadline)"
    );

    /// @dev Fixed EIP-712 domain separator (verifyingContract = this gateway's deployed
    ///      address). Computed at construction and read as an immutable so it stays correct
    ///      even when the code runs under EIP-7702 delegation, where `address(this)` is the
    ///      client EOA rather than the gateway.
    ///
    ///      NB: do NOT replace this with OpenZeppelin `EIP712`. Its `_domainSeparatorV4()`
    ///      caches `address(this)` at construction and *rebuilds* the separator whenever the
    ///      runtime `address(this)` differs — which under 7702 delegation is the client EOA.
    ///      That would set `verifyingContract` to the EOA and break recovery of intents the
    ///      client signed against the gateway address. The immutable below is inlined into the
    ///      gateway's runtime bytecode, so it survives delegated execution unchanged.
    bytes32 private immutable _DOMAIN_SEPARATOR;

    /// @dev signer (== `address(this)` under delegation) => nonce => used.
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    error Unauthorized();
    error IntentExpired();
    error NonceUsed();
    error InvalidSignature();

    constructor() {
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("X402FeedbackGateway")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    /// @notice Self-paid feedback: the client EOA (delegated to this code) calls itself.
    /// @dev `msg.sender == address(this)` holds only when the delegated EOA is the tx sender.
    function submitFeedback(
        address wrapper,
        address registry,
        uint256 ticketId,
        FeedbackParams calldata params
    ) external {
        if (msg.sender != address(this)) revert Unauthorized();
        _submit(wrapper, registry, ticketId, params);
    }

    /// @notice Sponsored feedback: a relayer calls the delegated client EOA; a client-signed
    ///         EIP-712 `FeedbackIntent` authorizes the exact wrapper/registry/params.
    function submitFeedbackFor(
        address wrapper,
        address registry,
        uint256 ticketId,
        FeedbackParams calldata params,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert IntentExpired();
        if (usedNonces[address(this)][nonce]) revert NonceUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                FEEDBACK_INTENT_TYPEHASH,
                wrapper,
                registry,
                ticketId,
                params.value,
                params.valueDecimals,
                keccak256(bytes(params.tag1)),
                keccak256(bytes(params.tag2)),
                keccak256(bytes(params.endpoint)),
                keccak256(bytes(params.feedbackURI)),
                params.feedbackHash,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));
        if (digest.recover(signature) != address(this)) revert InvalidSignature();

        usedNonces[address(this)][nonce] = true;
        _submit(wrapper, registry, ticketId, params);
    }

    /// @dev Consume the caller's ticket (gating), then forward feedback to the canonical
    ///      registry. Both calls run as the client EOA under delegation, so the registry
    ///      records the client as author and binds feedback to the paid `agentId`.
    function _submit(
        address wrapper,
        address registry,
        uint256 ticketId,
        FeedbackParams calldata params
    ) internal {
        uint256 agentId = IX402AgentReputation(wrapper).consumeTicket(ticketId);
        IReputationRegistry(registry).giveFeedback(
            agentId,
            params.value,
            params.valueDecimals,
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedbackURI,
            params.feedbackHash
        );
    }
}
