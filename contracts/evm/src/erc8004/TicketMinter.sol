// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ISignatureTransfer} from "../interfaces/ISignatureTransfer.sol";
import {ITicketMinter} from "./interfaces/ITicketMinter.sol";

/// @notice Minimal EIP-3009 view used by TicketMinter. USDC and similar tokens implement the
///         bytes-overload of `transferWithAuthorization`.
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

/// @title TicketMinter
/// @notice Mints an on-chain x402 job ticket atomically with token settlement.
/// @dev Phase 2 supports three settlement modes:
///        1. ERC-20 `transferFrom` (requires prior approval) — original Phase 1 path.
///        2. EIP-3009 `transferWithAuthorization` — direct call into the token.
///        3. Permit2 `permitWitnessTransferFrom` — TicketMinter is the spender, witness binds ticket metadata.
///      Recovery: standard x402 PAYMENT-RESPONSE tx hash → receipt → TicketMinted.ticketId.
contract TicketMinter is ITicketMinter, Ownable {
    using SafeERC20 for IERC20;

    /// @notice EIP-712 type string for the Permit2 witness binding the ticket.
    string public constant TICKET_WITNESS_TYPE_STRING =
        "TicketWitness witness)TicketWitness(address payer,uint256 agentId,bytes32 requestHash,bytes32 interactionHash,string endpoint,address payTo,uint256 validAfter)TokenPermissions(address token,uint256 amount)";

    /// @notice EIP-712 typehash for the Permit2 ticket witness struct.
    bytes32 public constant TICKET_WITNESS_TYPEHASH = keccak256(
        "TicketWitness(address payer,uint256 agentId,bytes32 requestHash,bytes32 interactionHash,string endpoint,address payTo,uint256 validAfter)"
    );

    ISignatureTransfer public immutable PERMIT2;

    mapping(uint256 => Ticket) private _tickets;
    mapping(address => bool) public facilitators;

    address public reputationRegistry;

    uint256 private _nextTicketId = 1;

    error NotFacilitator();
    error NotReputationRegistry();
    error InvalidPayment();
    error TicketNotMinted();
    error PayerMismatch();
    error PaymentTooEarly();
    error InvalidPermit2();

    modifier onlyFacilitator() {
        if (!facilitators[msg.sender]) revert NotFacilitator();
        _;
    }

    modifier onlyReputationRegistry() {
        if (msg.sender != reputationRegistry) revert NotReputationRegistry();
        _;
    }

    /// @param owner_ Owner of the minter (controls facilitator/registry setters).
    /// @param permit2_ Canonical Permit2 address. Pass `address(0)` if Permit2 is not used on this chain.
    constructor(address owner_, address permit2_) Ownable(owner_) {
        PERMIT2 = ISignatureTransfer(permit2_);
    }

    function setFacilitator(address facilitator, bool enabled) external onlyOwner {
        facilitators[facilitator] = enabled;
    }

    function setReputationRegistry(address registry) external onlyOwner {
        reputationRegistry = registry;
    }

    function settleAndMintTicket(
        address payer,
        uint256 agentId,
        bytes32 requestHash,
        bytes32 interactionHash,
        string calldata endpoint,
        SettlePayment calldata payment
    ) external onlyFacilitator returns (uint256 ticketId) {
        if (payer == address(0) || payment.token == address(0) || payment.payTo == address(0) || payment.amount == 0) {
            revert InvalidPayment();
        }

        IERC20(payment.token).safeTransferFrom(payer, payment.payTo, payment.amount);

        ticketId = _mintTicket(payer, agentId, requestHash, interactionHash, endpoint);
    }

    function settleAndMintTicketEIP3009(
        address payer,
        uint256 agentId,
        bytes32 requestHash,
        bytes32 interactionHash,
        string calldata endpoint,
        EIP3009Settlement calldata settlement
    ) external onlyFacilitator returns (uint256 ticketId) {
        if (payer == address(0) || settlement.token == address(0) || settlement.payTo == address(0) || settlement.value == 0) {
            revert InvalidPayment();
        }

        // EIP-3009: payer signed an authorization to move `value` from `payer` to `payTo`.
        // Token contract checks the signature; we just forward the call.
        IERC3009(settlement.token).transferWithAuthorization(
            payer,
            settlement.payTo,
            settlement.value,
            settlement.validAfter,
            settlement.validBefore,
            settlement.nonce,
            settlement.signature
        );

        ticketId = _mintTicket(payer, agentId, requestHash, interactionHash, endpoint);
    }

    function settleAndMintTicketPermit2(
        address payer,
        uint256 agentId,
        bytes32 requestHash,
        bytes32 interactionHash,
        string calldata endpoint,
        Permit2Settlement calldata settlement
    ) external onlyFacilitator returns (uint256 ticketId) {
        if (address(PERMIT2) == address(0)) revert InvalidPermit2();
        if (payer == address(0) || settlement.payTo == address(0) || settlement.permit.permitted.amount == 0) {
            revert InvalidPayment();
        }
        if (block.timestamp < settlement.validAfter) revert PaymentTooEarly();

        bytes32 witnessHash = keccak256(
            abi.encode(
                TICKET_WITNESS_TYPEHASH,
                payer,
                agentId,
                requestHash,
                interactionHash,
                keccak256(bytes(endpoint)),
                settlement.payTo,
                settlement.validAfter
            )
        );

        ISignatureTransfer.SignatureTransferDetails memory transferDetails = ISignatureTransfer.SignatureTransferDetails({
            to: settlement.payTo,
            requestedAmount: settlement.permit.permitted.amount
        });

        PERMIT2.permitWitnessTransferFrom(
            settlement.permit,
            transferDetails,
            payer,
            witnessHash,
            TICKET_WITNESS_TYPE_STRING,
            settlement.signature
        );

        ticketId = _mintTicket(payer, agentId, requestHash, interactionHash, endpoint);
    }

    function consumeTicket(uint256 ticketId, address payer) external onlyReputationRegistry {
        Ticket storage ticket = _tickets[ticketId];
        if (ticket.status != TicketStatus.MINTED) revert TicketNotMinted();
        if (ticket.payer != payer) revert PayerMismatch();

        ticket.status = TicketStatus.CONSUMED;
        emit TicketConsumed(ticketId, payer);
    }

    function tickets(uint256 ticketId) external view returns (Ticket memory) {
        return _tickets[ticketId];
    }

    function nextTicketId() external view returns (uint256) {
        return _nextTicketId;
    }

    function _mintTicket(
        address payer,
        uint256 agentId,
        bytes32 requestHash,
        bytes32 interactionHash,
        string calldata endpoint
    ) internal returns (uint256 ticketId) {
        ticketId = _nextTicketId++;
        _tickets[ticketId] = Ticket({
            payer: payer,
            agentId: agentId,
            requestHash: requestHash,
            interactionHash: interactionHash,
            endpoint: endpoint,
            status: TicketStatus.MINTED
        });

        emit TicketMinted(ticketId, payer, agentId, requestHash, interactionHash);
    }
}
