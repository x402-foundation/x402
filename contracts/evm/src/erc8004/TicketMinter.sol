// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ITicketMinter} from "./interfaces/ITicketMinter.sol";

/// @title TicketMinter
/// @notice Mints an on-chain x402 job ticket atomically with token settlement.
/// @dev Phase 1 uses ERC-20 transferFrom settlement; EIP-3009/Permit2 wiring lands in Phase 2.
///      Recovery: standard x402 PAYMENT-RESPONSE tx hash → receipt → TicketMinted.ticketId.
contract TicketMinter is ITicketMinter, Ownable {
    using SafeERC20 for IERC20;

    mapping(uint256 => Ticket) private _tickets;
    mapping(address => bool) public facilitators;

    address public reputationRegistry;

    uint256 private _nextTicketId = 1;

    error NotFacilitator();
    error NotReputationRegistry();
    error InvalidPayment();
    error TicketNotMinted();
    error PayerMismatch();

    modifier onlyFacilitator() {
        if (!facilitators[msg.sender]) revert NotFacilitator();
        _;
    }

    modifier onlyReputationRegistry() {
        if (msg.sender != reputationRegistry) revert NotReputationRegistry();
        _;
    }

    constructor(address owner_) Ownable(owner_) {}

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
}
