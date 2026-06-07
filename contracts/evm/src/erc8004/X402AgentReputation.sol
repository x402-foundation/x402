// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

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

/// @notice Minimal view of the canonical x402ExactPermit2Proxy `settle` entrypoint.
/// @dev The proxy is the Permit2 spender and enforces the witness-bound destination,
///      exactly as in the standard x402 Permit2 flow. Struct layout (to, validAfter)
///      matches x402ExactPermit2Proxy.Witness so the ABI encoding is identical.
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

/// @title X402AgentReputation
/// @notice x402 settle + consume-once ticket mint. Tickets gate ERC-8004 feedback: the
///         `FeedbackGateway` (an EIP-7702 delegate) calls `consumeTicket` as the paying
///         client and then forwards `giveFeedback` to the canonical `ReputationRegistry`,
///         so feedback is stored on the canonical registry and authored by the client.
/// @dev Feedback storage, reads, and disputes live entirely on the canonical
///      `ReputationRegistry` (`giveFeedback` / `revokeFeedback` / `appendResponse`).
contract X402AgentReputation is IX402AgentReputation, Ownable {
    IX402ExactPermit2Proxy public immutable PERMIT2_PROXY;
    IIdentityRegistry public immutable identityRegistry;

    mapping(uint256 => Ticket) private _tickets;

    uint256 private _nextTicketId = 1;

    error InvalidPayment();
    error InvalidPermit2();
    error InvalidAgent();
    error InvalidTicket();
    error SelfFeedbackNotAllowed();
    error ZeroAddress();
    error PayToMismatch();

    /// @param owner_ Reserved admin handle (currently no privileged functions).
    /// @param permit2Proxy_ Canonical x402ExactPermit2Proxy address; `address(0)` disables Permit2 settlement.
    /// @param identityRegistry_ ERC-8004 identity registry; `agentId` must exist at mint time.
    constructor(address owner_, address permit2Proxy_, address identityRegistry_) Ownable(owner_) {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        identityRegistry = IIdentityRegistry(identityRegistry_);
        PERMIT2_PROXY = IX402ExactPermit2Proxy(permit2Proxy_);
    }

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

    /// @notice Settle a standard x402 Permit2 payment through the canonical proxy, then mint a ticket.
    /// @dev Settlement is delegated to `x402ExactPermit2Proxy.settle` so the on-chain flow — and the
    ///      payer's signature (spender = proxy, witness = `Witness(to, validAfter)`) — is byte-for-byte
    ///      identical to a non-ticket x402 Permit2 payment. The only added behaviour is minting the
    ///      ticket atomically once the proxy has moved funds payer -> payTo.
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

    /// @notice Consume the caller's unconsumed ticket, returning the agent it was paid to.
    /// @dev Must be called by the ticket's payer. Under the feedback flow this is the
    ///      `FeedbackGateway` executing as the client EOA (EIP-7702), so `msg.sender` is the
    ///      paying client. Consume-once; reverts if the caller is the agent (no self-feedback).
    /// @param ticketId The ticket minted at settlement.
    /// @return agentId The agent the ticket was paid to (passed straight to `giveFeedback`).
    function consumeTicket(uint256 ticketId) external returns (uint256 agentId) {
        Ticket storage ticket = _tickets[ticketId];
        if (ticket.payer == address(0) || ticket.consumed) revert InvalidTicket();
        if (ticket.payer != msg.sender) revert InvalidTicket();
        if (identityRegistry.isAuthorizedOrOwner(msg.sender, ticket.agentId)) revert SelfFeedbackNotAllowed();

        ticket.consumed = true;
        agentId = ticket.agentId;

        emit TicketConsumed(ticketId, msg.sender, agentId);
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
}
