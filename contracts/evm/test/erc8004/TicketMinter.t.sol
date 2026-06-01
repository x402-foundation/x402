// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {TicketMinter} from "../../src/erc8004/TicketMinter.sol";
import {ITicketMinter} from "../../src/erc8004/interfaces/ITicketMinter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract TicketMinterTest is Test {
    TicketMinter public minter;
    MockERC20 public token;

    address public owner = makeAddr("owner");
    address public facilitator = makeAddr("facilitator");
    address public payer = makeAddr("payer");
    address public payTo = makeAddr("payTo");

    bytes32 public constant REQUEST_HASH = keccak256("request");
    bytes32 public constant INTERACTION_HASH = keccak256("interaction");

    function setUp() public {
        minter = new TicketMinter(owner);
        token = new MockERC20("USDC", "USDC", 6);

        vm.startPrank(owner);
        minter.setFacilitator(facilitator, true);
        vm.stopPrank();

        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(minter), type(uint256).max);
    }

    function test_settleAndMintTicket_mintsAndTransfers() public {
        ITicketMinter.SettlePayment memory payment =
            ITicketMinter.SettlePayment({token: address(token), payTo: payTo, amount: 100e6});

        vm.prank(facilitator);
        uint256 ticketId = minter.settleAndMintTicket(
            payer, 42, REQUEST_HASH, INTERACTION_HASH, "https://agent.example/r", payment
        );

        assertEq(ticketId, 1);
        assertEq(token.balanceOf(payTo), 100e6);

        ITicketMinter.Ticket memory ticket = minter.tickets(ticketId);
        assertEq(ticket.payer, payer);
        assertEq(ticket.agentId, 42);
        assertEq(ticket.requestHash, REQUEST_HASH);
        assertEq(ticket.interactionHash, INTERACTION_HASH);
        assertEq(uint256(ticket.status), uint256(ITicketMinter.TicketStatus.MINTED));
    }

    function test_ticketMinted_emittedForReceiptRecovery() public {
        ITicketMinter.SettlePayment memory payment =
            ITicketMinter.SettlePayment({token: address(token), payTo: payTo, amount: 50e6});

        vm.expectEmit(true, true, true, true);
        emit ITicketMinter.TicketMinted(1, payer, 1, REQUEST_HASH, INTERACTION_HASH);

        vm.prank(facilitator);
        minter.settleAndMintTicket(payer, 1, REQUEST_HASH, INTERACTION_HASH, "/r", payment);
    }

    function test_revertWhen_notFacilitator() public {
        ITicketMinter.SettlePayment memory payment =
            ITicketMinter.SettlePayment({token: address(token), payTo: payTo, amount: 1});

        vm.prank(payer);
        vm.expectRevert(TicketMinter.NotFacilitator.selector);
        minter.settleAndMintTicket(payer, 1, REQUEST_HASH, INTERACTION_HASH, "/r", payment);
    }

    function test_consumeTicket_onlyRegistry() public {
        address registry = makeAddr("registry");
        vm.prank(owner);
        minter.setReputationRegistry(registry);

        ITicketMinter.SettlePayment memory payment =
            ITicketMinter.SettlePayment({token: address(token), payTo: payTo, amount: 1});

        vm.prank(facilitator);
        uint256 ticketId = minter.settleAndMintTicket(
            payer, 1, REQUEST_HASH, INTERACTION_HASH, "/r", payment
        );

        vm.prank(registry);
        minter.consumeTicket(ticketId, payer);

        assertEq(uint256(minter.tickets(ticketId).status), uint256(ITicketMinter.TicketStatus.CONSUMED));
    }
}
