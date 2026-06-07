// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {X402AgentReputation} from "../../src/erc8004/X402AgentReputation.sol";
import {IX402AgentReputation} from "../../src/erc8004/interfaces/IX402AgentReputation.sol";
import {FeedbackGateway} from "../../src/erc8004/FeedbackGateway.sol";
import {MockERC3009Token} from "../mocks/MockERC3009Token.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

/// @dev Exercises the EIP-7702 feedback flow: a paying client delegates its EOA to the
///      gateway, which consumes the ticket and forwards giveFeedback to the canonical
///      registry — with the client as msg.sender (author) on both calls.
contract FeedbackGatewayTest is Test {
    X402AgentReputation public wrapper;
    FeedbackGateway public gateway;
    MockReputationRegistry public registry;
    MockIdentityRegistry public identity;
    MockERC3009Token public t3009;

    address public agentOwner = makeAddr("agentOwner");
    address public payTo = makeAddr("payTo");
    address public relayer = makeAddr("relayer");

    uint256 internal payerPk = 0xC11E27;
    address public payer;

    uint256 public constant AGENT_ID = 7;

    bytes32 private constant FEEDBACK_INTENT_TYPEHASH = keccak256(
        "FeedbackIntent(address wrapper,address registry,uint256 ticketId,int128 value,uint8 valueDecimals,bytes32 tag1Hash,bytes32 tag2Hash,bytes32 endpointHash,bytes32 feedbackURIHash,bytes32 feedbackHash,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        payer = vm.addr(payerPk);

        identity = new MockIdentityRegistry();
        identity.setOwner(AGENT_ID, agentOwner);

        wrapper = new X402AgentReputation(address(this), address(0), address(identity));
        registry = new MockReputationRegistry();
        gateway = new FeedbackGateway();

        t3009 = new MockERC3009Token("USDC3009", "USDC", 6);
        t3009.mint(payer, 1_000e6);
    }

    function _mintTicket(bytes32 nonce) internal returns (uint256 ticketId) {
        IX402AgentReputation.EIP3009Settlement memory s = IX402AgentReputation.EIP3009Settlement({
            token: address(t3009),
            payTo: payTo,
            value: 10e6,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: nonce,
            signature: ""
        });
        ticketId = wrapper.settleAndMintTicketEIP3009(payer, AGENT_ID, payTo, s);
    }

    function _params(bytes32 feedbackHash) internal pure returns (FeedbackGateway.FeedbackParams memory) {
        return FeedbackGateway.FeedbackParams({
            value: 95,
            valueDecimals: 0,
            tag1: "quality",
            tag2: "x402",
            endpoint: "https://agent.example/r",
            feedbackURI: "mem://fb",
            feedbackHash: feedbackHash
        });
    }

    function test_selfPaid_consumesTicketAndAuthorsFeedbackAsClient() public {
        uint256 ticketId = _mintTicket(keccak256("t1"));
        FeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));

        // Client delegates its EOA to the gateway and calls itself (self-paid).
        vm.signAndAttachDelegation(address(gateway), payerPk);
        vm.prank(payer);
        FeedbackGateway(payer).submitFeedback(address(wrapper), address(registry), ticketId, p);

        assertTrue(wrapper.tickets(ticketId).consumed);
        assertEq(registry.lastIndex(AGENT_ID, payer), 1, "feedback not attributed to client");
        (uint256 agentId, address client,,) = registry.feedbacks(0);
        assertEq(agentId, AGENT_ID);
        assertEq(client, payer);
    }

    function test_selfPaid_revertWhen_notSelf() public {
        uint256 ticketId = _mintTicket(keccak256("t1"));
        FeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));

        vm.signAndAttachDelegation(address(gateway), payerPk);
        // A stranger (not the delegated EOA) calls submitFeedback -> Unauthorized.
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.Unauthorized.selector);
        FeedbackGateway(payer).submitFeedback(address(wrapper), address(registry), ticketId, p);
    }

    function test_sponsored_relayerSubmitsClientSignedIntent() public {
        uint256 ticketId = _mintTicket(keccak256("t1"));
        FeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory sig = _signIntent(address(wrapper), address(registry), ticketId, p, nonce, deadline);

        // Relayer pays gas; client's signed intent authorizes the exact feedback.
        vm.signAndAttachDelegation(address(gateway), payerPk);
        vm.prank(relayer);
        FeedbackGateway(payer).submitFeedbackFor(
            address(wrapper), address(registry), ticketId, p, nonce, deadline, sig
        );

        assertTrue(wrapper.tickets(ticketId).consumed);
        assertEq(registry.lastIndex(AGENT_ID, payer), 1, "feedback not attributed to client");
    }

    function test_sponsored_revertWhen_badSignature() public {
        uint256 ticketId = _mintTicket(keccak256("t1"));
        FeedbackGateway.FeedbackParams memory p = _params(keccak256("fb1"));
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with the wrong key.
        uint256 wrongPk = 0xBAD;
        bytes32 digest = _intentDigest(address(wrapper), address(registry), ticketId, p, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.signAndAttachDelegation(address(gateway), payerPk);
        vm.prank(relayer);
        vm.expectRevert(FeedbackGateway.InvalidSignature.selector);
        FeedbackGateway(payer).submitFeedbackFor(
            address(wrapper), address(registry), ticketId, p, nonce, deadline, sig
        );
    }

    function _intentDigest(
        address wrapper_,
        address registry_,
        uint256 ticketId,
        FeedbackGateway.FeedbackParams memory p,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                FEEDBACK_INTENT_TYPEHASH,
                wrapper_,
                registry_,
                ticketId,
                p.value,
                p.valueDecimals,
                keccak256(bytes(p.tag1)),
                keccak256(bytes(p.tag2)),
                keccak256(bytes(p.endpoint)),
                keccak256(bytes(p.feedbackURI)),
                p.feedbackHash,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", gateway.domainSeparator(), structHash));
    }

    function _signIntent(
        address wrapper_,
        address registry_,
        uint256 ticketId,
        FeedbackGateway.FeedbackParams memory p,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = _intentDigest(wrapper_, registry_, ticketId, p, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        return abi.encodePacked(r, s, v);
    }
}
