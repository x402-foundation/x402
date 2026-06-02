// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {TicketMinter} from "../../src/erc8004/TicketMinter.sol";
import {ITicketMinter} from "../../src/erc8004/interfaces/ITicketMinter.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC3009Token} from "../mocks/MockERC3009Token.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";

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
        minter = new TicketMinter(owner, address(0));
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

    function test_settleAndMintTicketEIP3009_callsTokenAndMints() public {
        MockERC3009Token t3009 = new MockERC3009Token("USDC3009", "USDC", 6);
        t3009.mint(payer, 1_000e6);

        ITicketMinter.EIP3009Settlement memory settlement = ITicketMinter.EIP3009Settlement({
            token: address(t3009),
            payTo: payTo,
            value: 25e6,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: keccak256("nonce-1"),
            signature: ""
        });

        vm.prank(facilitator);
        uint256 ticketId = minter.settleAndMintTicketEIP3009(
            payer, 99, REQUEST_HASH, INTERACTION_HASH, "/r", settlement
        );

        assertEq(ticketId, 1);
        assertEq(t3009.balanceOf(payTo), 25e6);
        ITicketMinter.Ticket memory ticket = minter.tickets(ticketId);
        assertEq(ticket.payer, payer);
        assertEq(ticket.agentId, 99);
        assertEq(uint256(ticket.status), uint256(ITicketMinter.TicketStatus.MINTED));
    }

    function test_settleAndMintTicketEIP3009_revertWhen_notFacilitator() public {
        MockERC3009Token t3009 = new MockERC3009Token("USDC3009", "USDC", 6);
        ITicketMinter.EIP3009Settlement memory settlement = ITicketMinter.EIP3009Settlement({
            token: address(t3009),
            payTo: payTo,
            value: 1,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: bytes32(uint256(1)),
            signature: ""
        });

        vm.prank(payer);
        vm.expectRevert(TicketMinter.NotFacilitator.selector);
        minter.settleAndMintTicketEIP3009(payer, 1, REQUEST_HASH, INTERACTION_HASH, "/r", settlement);
    }

    function test_settleAndMintTicketPermit2_mintsAndTransfers() public {
        MockPermit2 permit2 = new MockPermit2();
        permit2.setShouldActuallyTransfer(true);

        TicketMinter mp = new TicketMinter(owner, address(permit2));
        vm.prank(owner);
        mp.setFacilitator(facilitator, true);

        // Approve the mock Permit2 to transfer from payer
        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: 75e6}),
            nonce: 7,
            deadline: block.timestamp + 1 hours
        });

        ITicketMinter.Permit2Settlement memory settlement = ITicketMinter.Permit2Settlement({
            permit: permit,
            payTo: payTo,
            validAfter: 0,
            signature: ""
        });

        vm.prank(facilitator);
        uint256 ticketId = mp.settleAndMintTicketPermit2(
            payer, 123, REQUEST_HASH, INTERACTION_HASH, "/p", settlement
        );

        assertEq(ticketId, 1);
        assertEq(token.balanceOf(payTo), 75e6);
        ITicketMinter.Ticket memory ticket = mp.tickets(ticketId);
        assertEq(ticket.agentId, 123);
        assertEq(uint256(ticket.status), uint256(ITicketMinter.TicketStatus.MINTED));
    }

    function test_settleAndMintTicketPermit2_revertWhen_permit2NotConfigured() public {
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: 1}),
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        ITicketMinter.Permit2Settlement memory settlement = ITicketMinter.Permit2Settlement({
            permit: permit,
            payTo: payTo,
            validAfter: 0,
            signature: ""
        });

        vm.prank(facilitator);
        vm.expectRevert(TicketMinter.InvalidPermit2.selector);
        minter.settleAndMintTicketPermit2(payer, 1, REQUEST_HASH, INTERACTION_HASH, "/p", settlement);
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
