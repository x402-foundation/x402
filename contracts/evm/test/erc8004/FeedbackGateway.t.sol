// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {FeedbackGateway} from "../../src/erc8004/FeedbackGateway.sol";
import {IFeedbackGateway} from "../../src/erc8004/interfaces/IFeedbackGateway.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {x402ExactPermit2Proxy} from "../../src/x402ExactPermit2Proxy.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC3009Token} from "../mocks/MockERC3009Token.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

/// @dev Exercises the merged FeedbackGateway: settle/mint, self-paid + sponsored feedback,
///      and client-signed revocation. The registry records `msg.sender == gateway` as author.
contract FeedbackGatewayTest is Test {
    FeedbackGateway public gateway;
    MockReputationRegistry public registry;
    MockIdentityRegistry public identity;
    MockERC20 public token;
    MockERC3009Token public t3009;

    address public owner = makeAddr("owner");
    address public payTo = makeAddr("payTo");
    address public relayer = makeAddr("relayer");

    uint256 internal payerPk = 0xC11E27;
    address public payer;

    uint256 public constant AGENT_ID = 7;
    uint256 private _nextNonce;

    function setUp() public {
        payer = vm.addr(payerPk);

        identity = new MockIdentityRegistry();
        identity.setOwner(AGENT_ID, payTo); // pay_to == agent owner, so mint-time binding holds
        registry = new MockReputationRegistry();

        gateway = new FeedbackGateway(owner, address(0), address(identity), address(registry));

        token = new MockERC20("USDC", "USDC", 6);
        token.mint(payer, 1_000e6);
        t3009 = new MockERC3009Token("USDC3009", "USDC", 6);
        t3009.mint(payer, 1_000e6);
    }

    // ----- helpers -----

    function _mintTicketEIP3009(address from, uint256 value, bytes32 nonce) internal returns (uint256 ticketId) {
        IFeedbackGateway.EIP3009Settlement memory s = IFeedbackGateway.EIP3009Settlement({
            token: address(t3009),
            payTo: payTo,
            value: value,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: nonce,
            signature: ""
        });
        ticketId = gateway.settleAndMintTicketEIP3009(from, AGENT_ID, payTo, s);
    }

    function _mintTicket() internal returns (uint256 ticketId) {
        ticketId = _mintTicketEIP3009(payer, 10e6, keccak256(abi.encode("mint", _nextNonce++)));
    }

    function _params(bytes32 feedbackHash) internal pure returns (IFeedbackGateway.FeedbackParams memory) {
        return IFeedbackGateway.FeedbackParams({
            value: 95,
            valueDecimals: 0,
            tag1: "quality",
            tag2: "x402",
            endpoint: "https://agent.example/r",
            feedbackURI: "mem://fb",
            feedbackHash: feedbackHash
        });
    }

    // ----- settle + mint -----

    function test_settleAndMintTicket_mintsPlainFields() public {
        uint256 ticketId = _mintTicketEIP3009(payer, 100e6, keccak256("plain"));

        assertEq(ticketId, 1);
        assertEq(t3009.balanceOf(payTo), 100e6);

        IFeedbackGateway.Ticket memory ticket = gateway.tickets(ticketId);
        assertEq(ticket.payer, payer);
        assertEq(ticket.agentId, AGENT_ID);
        assertEq(ticket.agentAddress, payTo);
        assertEq(ticket.token, address(t3009));
        assertEq(ticket.amount, 100e6);
        assertFalse(ticket.consumed);
    }

    function test_ticketMinted_emittedForReceiptRecovery() public {
        vm.expectEmit(true, true, true, true);
        emit IFeedbackGateway.TicketMinted(1, payer, AGENT_ID, payTo, address(t3009), 50e6);
        _mintTicketEIP3009(payer, 50e6, keccak256("emit"));
    }

    function test_revertWhen_payToMismatch() public {
        IFeedbackGateway.EIP3009Settlement memory s = IFeedbackGateway.EIP3009Settlement({
            token: address(t3009),
            payTo: makeAddr("other"),
            value: 1,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: keccak256("mismatch"),
            signature: ""
        });
        vm.expectRevert(FeedbackGateway.PayToMismatch.selector);
        gateway.settleAndMintTicketEIP3009(payer, AGENT_ID, payTo, s);
    }

    function test_revertWhen_invalidAgent() public {
        IFeedbackGateway.EIP3009Settlement memory s = IFeedbackGateway.EIP3009Settlement({
            token: address(t3009),
            payTo: payTo,
            value: 1,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: keccak256("badagent"),
            signature: ""
        });
        vm.expectRevert(FeedbackGateway.InvalidAgent.selector);
        gateway.settleAndMintTicketEIP3009(payer, 9999, payTo, s);
    }

    function test_revertWhen_agentAddressNotOwner() public {
        address notOwner = makeAddr("notOwner");
        IFeedbackGateway.EIP3009Settlement memory s = IFeedbackGateway.EIP3009Settlement({
            token: address(t3009),
            payTo: notOwner,
            value: 1,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: keccak256("notowner"),
            signature: ""
        });
        vm.expectRevert(FeedbackGateway.InvalidAgent.selector);
        gateway.settleAndMintTicketEIP3009(payer, AGENT_ID, notOwner, s);
    }

    function test_settleAndMintTicketPermit2_mintsAndTransfers() public {
        MockPermit2 permit2 = new MockPermit2();
        permit2.setShouldActuallyTransfer(true);

        x402ExactPermit2Proxy proxy = new x402ExactPermit2Proxy(address(permit2));
        FeedbackGateway gw = new FeedbackGateway(owner, address(proxy), address(identity), address(registry));

        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: 75e6}),
            nonce: 7,
            deadline: block.timestamp + 1 hours
        });

        IFeedbackGateway.Permit2Settlement memory s = IFeedbackGateway.Permit2Settlement({
            permit: permit,
            payTo: payTo,
            validAfter: 0,
            signature: ""
        });

        uint256 ticketId = gw.settleAndMintTicketPermit2(payer, AGENT_ID, payTo, s);

        assertEq(ticketId, 1);
        assertEq(token.balanceOf(payTo), 75e6);
        assertFalse(gw.tickets(ticketId).consumed);
    }

    // ----- self-paid submitFeedback -----

    function test_selfPaid_consumesAuthorsAndCapturesIndex() public {
        uint256 ticketId = _mintTicket();
        bytes32 h = keccak256("fb1");

        vm.expectEmit(true, true, true, true);
        emit IFeedbackGateway.TicketConsumed(ticketId, payer, AGENT_ID, payTo, h);

        vm.prank(payer);
        gateway.submitFeedback(ticketId, _params(h));

        assertTrue(gateway.tickets(ticketId).consumed);
        // gateway is the registry author
        assertEq(registry.lastIndex(AGENT_ID, address(gateway)), 1);
        assertTrue(gateway.usedFeedbackHashes(h));
        (uint256 agentId, uint64 idx, bool exists) = gateway.feedbackRef(ticketId);
        assertEq(agentId, AGENT_ID);
        assertEq(idx, 1);
        assertTrue(exists);
    }

    function test_selfPaid_revertWhen_notPayer() public {
        uint256 ticketId = _mintTicket();
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.Unauthorized.selector);
        gateway.submitFeedback(ticketId, _params(keccak256("fb1")));
    }

    function test_selfPaid_revertWhen_unknownTicket() public {
        vm.prank(payer);
        vm.expectRevert(FeedbackGateway.Unauthorized.selector); // ticket.payer == 0 != msg.sender
        gateway.submitFeedback(999, _params(keccak256("fb1")));
    }

    function test_selfPaid_revertWhen_reuseTicket() public {
        uint256 ticketId = _mintTicket();
        vm.startPrank(payer);
        gateway.submitFeedback(ticketId, _params(keccak256("fb1")));
        vm.expectRevert(FeedbackGateway.InvalidTicket.selector);
        gateway.submitFeedback(ticketId, _params(keccak256("fb2")));
        vm.stopPrank();
    }

    function test_selfPaid_revertWhen_duplicateFeedbackHash() public {
        uint256 t1 = _mintTicket();
        uint256 t2 = _mintTicket();
        bytes32 h = keccak256("dup");
        vm.startPrank(payer);
        gateway.submitFeedback(t1, _params(h));
        vm.expectRevert(FeedbackGateway.DuplicateFeedbackHash.selector);
        gateway.submitFeedback(t2, _params(h));
        vm.stopPrank();
    }

    function test_selfPaid_revertWhen_selfFeedback() public {
        // Ticket whose payer is the agent owner (== payTo): the agent cannot review itself.
        t3009.mint(payTo, 100e6);
        uint256 ticketId = _mintTicketEIP3009(payTo, 10e6, keccak256("self"));
        vm.prank(payTo);
        vm.expectRevert(FeedbackGateway.SelfFeedbackNotAllowed.selector);
        gateway.submitFeedback(ticketId, _params(keccak256("fb-self")));
    }

    // ----- sponsored submitFeedbackFor -----

    bytes32 private constant FEEDBACK_INTENT_TYPEHASH = keccak256(
        "FeedbackIntent(address registry,uint256 ticketId,uint256 agentId,address payer,int128 value,uint8 valueDecimals,bytes32 tag1Hash,bytes32 tag2Hash,bytes32 endpointHash,bytes32 feedbackURIHash,bytes32 feedbackHash,uint256 nonce,uint256 deadline)"
    );

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("FeedbackGateway")),
                keccak256(bytes("1")),
                block.chainid,
                address(gateway)
            )
        );
    }

    function _feedbackIntent(uint256 ticketId, IFeedbackGateway.FeedbackParams memory p, uint256 nonce, uint256 deadline)
        internal
        view
        returns (IFeedbackGateway.FeedbackIntent memory)
    {
        return IFeedbackGateway.FeedbackIntent({
            registry: address(registry),
            ticketId: ticketId,
            agentId: AGENT_ID,
            payer: payer,
            value: p.value,
            valueDecimals: p.valueDecimals,
            tag1Hash: keccak256(bytes(p.tag1)),
            tag2Hash: keccak256(bytes(p.tag2)),
            endpointHash: keccak256(bytes(p.endpoint)),
            feedbackURIHash: keccak256(bytes(p.feedbackURI)),
            feedbackHash: p.feedbackHash,
            nonce: nonce,
            deadline: deadline
        });
    }

    function _feedbackStructHash(IFeedbackGateway.FeedbackIntent memory i) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FEEDBACK_INTENT_TYPEHASH,
                i.registry, i.ticketId, i.agentId, i.payer,
                i.value, i.valueDecimals,
                i.tag1Hash, i.tag2Hash, i.endpointHash, i.feedbackURIHash, i.feedbackHash,
                i.nonce, i.deadline
            )
        );
    }

    function _signFeedback(IFeedbackGateway.FeedbackIntent memory i, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = _feedbackStructHash(i);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_sponsored_relayerSubmitsClientIntent() public {
        uint256 ticketId = _mintTicket();
        IFeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        IFeedbackGateway.FeedbackIntent memory i = _feedbackIntent(ticketId, p, 1, block.timestamp + 1 hours);
        bytes memory sig = _signFeedback(i, payerPk);

        vm.prank(relayer);
        gateway.submitFeedbackFor(i, p, sig);

        assertTrue(gateway.tickets(ticketId).consumed);
        assertEq(registry.lastIndex(AGENT_ID, address(gateway)), 1);
        assertTrue(gateway.usedNonces(payer, 1));
    }

    function test_sponsored_revertWhen_badSignature() public {
        uint256 ticketId = _mintTicket();
        IFeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        IFeedbackGateway.FeedbackIntent memory i = _feedbackIntent(ticketId, p, 1, block.timestamp + 1 hours);
        bytes memory sig = _signFeedback(i, 0xBAD); // wrong key

        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.InvalidSignature.selector);
        gateway.submitFeedbackFor(i, p, sig);
    }

    function test_sponsored_revertWhen_nonceReused() public {
        uint256 t1 = _mintTicket();
        uint256 t2 = _mintTicket();
        IFeedbackGateway.FeedbackParams memory p1 = _params(keccak256("fb1"));
        IFeedbackGateway.FeedbackIntent memory i1 = _feedbackIntent(t1, p1, 1, block.timestamp + 1 hours);
        vm.prank(relayer);
        gateway.submitFeedbackFor(i1, p1, _signFeedback(i1, payerPk));

        IFeedbackGateway.FeedbackParams memory p2 = _params(keccak256("fb2"));
        IFeedbackGateway.FeedbackIntent memory i2 = _feedbackIntent(t2, p2, 1, block.timestamp + 1 hours); // same nonce
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.NonceUsed.selector);
        gateway.submitFeedbackFor(i2, p2, _signFeedback(i2, payerPk));
    }

    function test_sponsored_revertWhen_expired() public {
        uint256 ticketId = _mintTicket();
        IFeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        IFeedbackGateway.FeedbackIntent memory i = _feedbackIntent(ticketId, p, 1, block.timestamp - 1);
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.IntentExpired.selector);
        gateway.submitFeedbackFor(i, p, _signFeedback(i, payerPk));
    }

    function test_sponsored_revertWhen_paramsMismatchIntent() public {
        uint256 ticketId = _mintTicket();
        IFeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        IFeedbackGateway.FeedbackIntent memory i = _feedbackIntent(ticketId, p, 1, block.timestamp + 1 hours);
        bytes memory sig = _signFeedback(i, payerPk);
        // tamper the calldata params after signing the intent
        p.tag1 = "tampered";
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.ParamsMismatch.selector);
        gateway.submitFeedbackFor(i, p, sig);
    }

    function test_sponsored_revertWhen_registryMismatch() public {
        uint256 ticketId = _mintTicket();
        IFeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        IFeedbackGateway.FeedbackIntent memory i = _feedbackIntent(ticketId, p, 1, block.timestamp + 1 hours);
        i.registry = makeAddr("wrongRegistry");
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.RegistryMismatch.selector);
        gateway.submitFeedbackFor(i, p, _signFeedback(i, payerPk));
    }

    // ----- revokeFeedbackFor -----

    bytes32 private constant REVOKE_INTENT_TYPEHASH =
        keccak256("RevokeIntent(address payer,uint256 ticketId,uint256 nonce,uint256 deadline)");

    function _signRevoke(IFeedbackGateway.RevokeIntent memory i, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(REVOKE_INTENT_TYPEHASH, i.payer, i.ticketId, i.nonce, i.deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _submitSelfPaid(uint256 ticketId, bytes32 h) internal {
        vm.prank(payer);
        gateway.submitFeedback(ticketId, _params(h));
    }

    function test_revoke_happyPath() public {
        uint256 ticketId = _mintTicket();
        _submitSelfPaid(ticketId, keccak256("fb1"));

        IFeedbackGateway.RevokeIntent memory i =
            IFeedbackGateway.RevokeIntent({payer: payer, ticketId: ticketId, nonce: 2, deadline: block.timestamp + 1 hours});

        vm.expectEmit(true, true, true, true);
        emit IFeedbackGateway.FeedbackRevokedFor(ticketId, payer, AGENT_ID, 1);

        vm.prank(relayer);
        gateway.revokeFeedbackFor(i, _signRevoke(i, payerPk));

        assertTrue(registry.isRevoked(AGENT_ID, address(gateway), 1));
    }

    function test_revoke_revertWhen_notOriginalPayer() public {
        uint256 ticketId = _mintTicket();
        _submitSelfPaid(ticketId, keccak256("fb1"));

        uint256 strangerPk = 0x5152;
        address stranger = vm.addr(strangerPk);
        IFeedbackGateway.RevokeIntent memory i = IFeedbackGateway.RevokeIntent({
            payer: stranger,
            ticketId: ticketId,
            nonce: 1,
            deadline: block.timestamp + 1 hours
        });
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.Unauthorized.selector);
        gateway.revokeFeedbackFor(i, _signRevoke(i, strangerPk));
    }

    function test_revoke_revertWhen_badSignature() public {
        uint256 ticketId = _mintTicket();
        _submitSelfPaid(ticketId, keccak256("fb1"));
        IFeedbackGateway.RevokeIntent memory i =
            IFeedbackGateway.RevokeIntent({payer: payer, ticketId: ticketId, nonce: 2, deadline: block.timestamp + 1 hours});
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.InvalidSignature.selector);
        gateway.revokeFeedbackFor(i, _signRevoke(i, 0xBAD));
    }

    function test_revoke_revertWhen_unknownFeedback() public {
        uint256 ticketId = _mintTicket(); // minted but feedback never submitted
        IFeedbackGateway.RevokeIntent memory i =
            IFeedbackGateway.RevokeIntent({payer: payer, ticketId: ticketId, nonce: 1, deadline: block.timestamp + 1 hours});
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.UnknownFeedback.selector);
        gateway.revokeFeedbackFor(i, _signRevoke(i, payerPk));
    }

    function test_revoke_idempotentDoubleRevoke() public {
        uint256 ticketId = _mintTicket();
        _submitSelfPaid(ticketId, keccak256("fb1"));

        IFeedbackGateway.RevokeIntent memory i1 =
            IFeedbackGateway.RevokeIntent({payer: payer, ticketId: ticketId, nonce: 2, deadline: block.timestamp + 1 hours});
        vm.prank(relayer);
        gateway.revokeFeedbackFor(i1, _signRevoke(i1, payerPk));

        // second revoke with a fresh nonce: registry reverts "Already revoked", gateway swallows it
        IFeedbackGateway.RevokeIntent memory i2 =
            IFeedbackGateway.RevokeIntent({payer: payer, ticketId: ticketId, nonce: 3, deadline: block.timestamp + 1 hours});
        vm.expectEmit(true, true, true, true);
        emit IFeedbackGateway.FeedbackRevokedFor(ticketId, payer, AGENT_ID, 1);
        vm.prank(relayer);
        gateway.revokeFeedbackFor(i2, _signRevoke(i2, payerPk));

        assertTrue(registry.isRevoked(AGENT_ID, address(gateway), 1));
    }

    function test_revoke_revertWhen_nonceReused() public {
        uint256 ticketId = _mintTicket();
        _submitSelfPaid(ticketId, keccak256("fb1"));
        IFeedbackGateway.RevokeIntent memory i =
            IFeedbackGateway.RevokeIntent({payer: payer, ticketId: ticketId, nonce: 2, deadline: block.timestamp + 1 hours});
        vm.startPrank(relayer);
        gateway.revokeFeedbackFor(i, _signRevoke(i, payerPk));
        vm.expectRevert(FeedbackGateway.NonceUsed.selector);
        gateway.revokeFeedbackFor(i, _signRevoke(i, payerPk));
        vm.stopPrank();
    }

    function test_sponsored_revertWhen_agentIdMismatch() public {
        uint256 ticketId = _mintTicket(); // ticket bound to AGENT_ID
        IFeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        IFeedbackGateway.FeedbackIntent memory i = _feedbackIntent(ticketId, p, 1, block.timestamp + 1 hours);
        i.agentId = AGENT_ID + 1; // intent targets a different agent than the ticket
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.AgentMismatch.selector);
        gateway.submitFeedbackFor(i, p, _signFeedback(i, payerPk));
    }
}
