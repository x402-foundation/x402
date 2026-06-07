// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {X402AgentReputation} from "../../src/erc8004/X402AgentReputation.sol";
import {IX402AgentReputation} from "../../src/erc8004/interfaces/IX402AgentReputation.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC3009Token} from "../mocks/MockERC3009Token.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {x402ExactPermit2Proxy} from "../../src/x402ExactPermit2Proxy.sol";

contract X402AgentReputationTest is Test {
    X402AgentReputation public wrapper;
    MockERC20 public token;
    MockERC3009Token public t3009;
    MockIdentityRegistry public identity;

    address public owner = makeAddr("owner");
    address public agentOwner = makeAddr("agentOwner");
    address public facilitator = makeAddr("facilitator");
    address public payer = makeAddr("payer");
    address public payTo = makeAddr("payTo");

    uint256 public constant AGENT_ID = 7;
    bytes32 public constant FEEDBACK_HASH = keccak256("feedback");

    uint256 payerPrivateKey = 0xA11CE;
    uint256 private _nextNonce;

    function setUp() public {
        payer = vm.addr(payerPrivateKey);

        identity = new MockIdentityRegistry();
        identity.setOwner(AGENT_ID, agentOwner);

        wrapper = new X402AgentReputation(owner, address(0), address(identity));
        token = new MockERC20("USDC", "USDC", 6);
        token.mint(payer, 1_000e6);
        t3009 = new MockERC3009Token("USDC3009", "USDC", 6);
        t3009.mint(payer, 1_000e6);
    }

    /// @dev Mint a ticket via the EIP-3009 path (the bare transferFrom path was removed).
    ///      The EIP-3009 mock ignores the signature and transfers `value` from `from`.
    function _mintTicketEIP3009(address from, uint256 value, bytes32 nonce) internal returns (uint256 ticketId) {
        IX402AgentReputation.EIP3009Settlement memory settlement = IX402AgentReputation.EIP3009Settlement({
            token: address(t3009),
            payTo: payTo,
            value: value,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: nonce,
            signature: ""
        });
        ticketId = wrapper.settleAndMintTicketEIP3009(from, AGENT_ID, payTo, settlement);
    }

    function _mintTicket() internal returns (uint256 ticketId) {
        ticketId = _mintTicketEIP3009(payer, 10e6, keccak256(abi.encode("mint", _nextNonce++)));
    }

    function test_settleAndMintTicket_mintsPlainFields() public {
        uint256 ticketId = _mintTicketEIP3009(payer, 100e6, keccak256("plain"));

        assertEq(ticketId, 1);
        assertEq(t3009.balanceOf(payTo), 100e6);

        IX402AgentReputation.Ticket memory ticket = wrapper.tickets(ticketId);
        assertEq(ticket.payer, payer);
        assertEq(ticket.agentId, AGENT_ID);
        assertEq(ticket.agentAddress, payTo);
        assertEq(ticket.token, address(t3009));
        assertEq(ticket.amount, 100e6);
        assertFalse(ticket.consumed);
    }

    function test_ticketMinted_emittedForReceiptRecovery() public {
        vm.expectEmit(true, true, true, true);
        emit IX402AgentReputation.TicketMinted(1, payer, AGENT_ID, payTo, address(t3009), 50e6);

        _mintTicketEIP3009(payer, 50e6, keccak256("emit"));
    }

    function test_revertWhen_payToMismatch() public {
        IX402AgentReputation.EIP3009Settlement memory settlement = IX402AgentReputation.EIP3009Settlement({
            token: address(t3009),
            payTo: makeAddr("other"),
            value: 1,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: keccak256("mismatch"),
            signature: ""
        });
        vm.expectRevert(X402AgentReputation.PayToMismatch.selector);
        wrapper.settleAndMintTicketEIP3009(payer, AGENT_ID, payTo, settlement);
    }

    function test_revertWhen_invalidAgent() public {
        IX402AgentReputation.EIP3009Settlement memory settlement = IX402AgentReputation.EIP3009Settlement({
            token: address(t3009),
            payTo: payTo,
            value: 1,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: keccak256("badagent"),
            signature: ""
        });
        vm.expectRevert(X402AgentReputation.InvalidAgent.selector);
        wrapper.settleAndMintTicketEIP3009(payer, 9999, payTo, settlement);
    }

    function test_settleAndMintTicketEIP3009_callsTokenAndMints() public {
        uint256 ticketId = _mintTicketEIP3009(payer, 25e6, keccak256("nonce-1"));

        assertEq(ticketId, 1);
        assertEq(t3009.balanceOf(payTo), 25e6);
        IX402AgentReputation.Ticket memory ticket = wrapper.tickets(ticketId);
        assertEq(ticket.amount, 25e6);
        assertFalse(ticket.consumed);
    }

    function test_settleAndMintTicketPermit2_mintsAndTransfers() public {
        MockPermit2 permit2 = new MockPermit2();
        permit2.setShouldActuallyTransfer(true);

        // Settle exactly as x402 does: the wrapper calls the proxy, which is the Permit2 spender.
        x402ExactPermit2Proxy proxy = new x402ExactPermit2Proxy(address(permit2));

        X402AgentReputation wp = new X402AgentReputation(owner, address(proxy), address(identity));

        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: 75e6}),
            nonce: 7,
            deadline: block.timestamp + 1 hours
        });

        IX402AgentReputation.Permit2Settlement memory settlement = IX402AgentReputation.Permit2Settlement({
            permit: permit,
            payTo: payTo,
            validAfter: 0,
            signature: ""
        });

        vm.prank(facilitator);
        uint256 ticketId = wp.settleAndMintTicketPermit2(payer, AGENT_ID, payTo, settlement);

        assertEq(ticketId, 1);
        assertEq(token.balanceOf(payTo), 75e6);
        assertFalse(wp.tickets(ticketId).consumed);
    }

    function test_giveFeedbackWithTicket_consumesTicket() public {
        uint256 ticketId = _mintTicket();

        vm.expectEmit(true, true, true, true);
        emit IX402AgentReputation.TicketConsumed(ticketId, payer, AGENT_ID, 1);

        vm.prank(payer);
        wrapper.giveFeedbackWithTicket(ticketId, 100, 0, "quality", "", "https://agent.example/r", "", FEEDBACK_HASH);

        assertTrue(wrapper.tickets(ticketId).consumed);
        assertEq(wrapper.getLastIndex(AGENT_ID, payer), 1);
    }

    function test_revertWhen_reuseConsumedTicket() public {
        uint256 ticketId = _mintTicket();

        vm.startPrank(payer);
        wrapper.giveFeedbackWithTicket(ticketId, 100, 0, "q", "", "/r", "", FEEDBACK_HASH);
        vm.expectRevert(X402AgentReputation.InvalidTicket.selector);
        wrapper.giveFeedbackWithTicket(ticketId, 50, 0, "q", "", "/r", "", keccak256("other"));
        vm.stopPrank();
    }

    function test_revertWhen_duplicateFeedbackHash() public {
        uint256 ticketId = _mintTicket();

        vm.startPrank(payer);
        wrapper.giveFeedbackWithTicket(ticketId, 100, 0, "q", "", "/r", "", FEEDBACK_HASH);
        vm.stopPrank();

        uint256 ticketId2 = _mintTicket();

        vm.prank(payer);
        vm.expectRevert(X402AgentReputation.FeedbackHashAlreadyUsed.selector);
        wrapper.giveFeedbackWithTicket(ticketId2, 50, 0, "q", "", "/r", "", FEEDBACK_HASH);
    }

    function test_giveFeedbackWithTicketFor_sponsored() public {
        uint256 ticketId = _mintTicket();

        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "FeedbackIntent(uint256 ticketId,int128 value,uint8 valueDecimals,bytes32 tag1Hash,bytes32 tag2Hash,bytes32 endpointHash,bytes32 feedbackURIHash,bytes32 feedbackHash,uint256 nonce,uint256 deadline)"
                ),
                ticketId,
                int128(80),
                uint8(0),
                keccak256(bytes("quality")),
                keccak256(bytes("")),
                keccak256(bytes("https://agent.example/r")),
                keccak256(bytes("")),
                FEEDBACK_HASH,
                nonce,
                deadline
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wrapper.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        wrapper.giveFeedbackWithTicketFor(
            IX402AgentReputation.FeedbackSubmission({
                payer: payer,
                ticketId: ticketId,
                value: 80,
                valueDecimals: 0,
                tag1: "quality",
                tag2: "",
                endpoint: "https://agent.example/r",
                feedbackURI: "",
                feedbackHash: FEEDBACK_HASH
            }),
            nonce,
            deadline,
            sig
        );

        assertTrue(wrapper.tickets(ticketId).consumed);
    }

    function test_disputeFeedback_agentOnly() public {
        uint256 ticketId = _mintTicket();

        vm.prank(payer);
        wrapper.giveFeedbackWithTicket(ticketId, 100, 0, "q", "", "/r", "", FEEDBACK_HASH);

        vm.prank(agentOwner);
        wrapper.disputeFeedback(AGENT_ID, payer, 1);

        (,,,, bool isDisputed) = wrapper.readFeedback(AGENT_ID, payer, 1);
        assertTrue(isDisputed);
    }

    function test_revertWhen_selfFeedback() public {
        address selfPayer = agentOwner;
        t3009.mint(selfPayer, 100e6);

        uint256 ticketId = _mintTicketEIP3009(selfPayer, 10e6, keccak256("self"));

        vm.prank(selfPayer);
        vm.expectRevert(X402AgentReputation.SelfFeedbackNotAllowed.selector);
        wrapper.giveFeedbackWithTicket(ticketId, 100, 0, "q", "", "/r", "", FEEDBACK_HASH);
    }
}
