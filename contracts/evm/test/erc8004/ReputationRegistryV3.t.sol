// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {TicketMinter} from "../../src/erc8004/TicketMinter.sol";
import {ReputationRegistryV3} from "../../src/erc8004/ReputationRegistryV3.sol";
import {ITicketMinter} from "../../src/erc8004/interfaces/ITicketMinter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";

contract ReputationRegistryV3Test is Test {
    TicketMinter public minter;
    ReputationRegistryV3 public registry;
    MockIdentityRegistry public identity;
    MockERC20 public token;

    address public owner = makeAddr("owner");
    address public facilitator = makeAddr("facilitator");
    address public payer = makeAddr("payer");
    address public agentOwner = makeAddr("agentOwner");
    address public payTo = makeAddr("payTo");

    uint256 public constant AGENT_ID = 7;
    bytes32 public constant REQUEST_HASH = keccak256("request");
    bytes32 public constant INTERACTION_HASH = keccak256("interaction");
    bytes32 public constant FEEDBACK_HASH = keccak256("feedback");

    uint256 payerPrivateKey = 0xA11CE;

    function setUp() public {
        payer = vm.addr(payerPrivateKey);

        minter = new TicketMinter(owner, address(0));
        identity = new MockIdentityRegistry();
        registry = new ReputationRegistryV3(address(identity), address(minter));
        token = new MockERC20("USDC", "USDC", 6);

        identity.setOwner(AGENT_ID, agentOwner);

        vm.startPrank(owner);
        minter.setFacilitator(facilitator, true);
        minter.setReputationRegistry(address(registry));
        vm.stopPrank();

        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(minter), type(uint256).max);
    }

    function _mintTicket() internal returns (uint256 ticketId) {
        ITicketMinter.SettlePayment memory payment =
            ITicketMinter.SettlePayment({token: address(token), payTo: payTo, amount: 10e6});

        vm.prank(facilitator);
        ticketId = minter.settleAndMintTicket(
            payer, AGENT_ID, REQUEST_HASH, INTERACTION_HASH, "https://agent.example/r", payment
        );
    }

    function test_giveFeedbackWithTicket_consumesTicket() public {
        uint256 ticketId = _mintTicket();

        vm.prank(payer);
        registry.giveFeedbackWithTicket(ticketId, 100, 0, "quality", "", "https://agent.example/r", "", FEEDBACK_HASH);

        assertEq(uint256(minter.tickets(ticketId).status), uint256(ITicketMinter.TicketStatus.CONSUMED));
        assertEq(registry.getLastIndex(AGENT_ID, payer), 1);
    }

    function test_giveFeedback_reverts() public {
        vm.expectRevert(ReputationRegistryV3.LegacyGiveFeedbackDisabled.selector);
        registry.giveFeedback(AGENT_ID, 1, 0, "", "", "", "", bytes32(0));
    }

    function test_revertWhen_reuseConsumedTicket() public {
        uint256 ticketId = _mintTicket();

        vm.startPrank(payer);
        registry.giveFeedbackWithTicket(ticketId, 100, 0, "q", "", "/r", "", FEEDBACK_HASH);
        vm.expectRevert(ReputationRegistryV3.InvalidTicket.selector);
        registry.giveFeedbackWithTicket(ticketId, 50, 0, "q", "", "/r", "", keccak256("other"));
        vm.stopPrank();
    }

    function test_revertWhen_duplicateFeedbackHash() public {
        uint256 ticketId = _mintTicket();

        vm.startPrank(payer);
        registry.giveFeedbackWithTicket(ticketId, 100, 0, "q", "", "/r", "", FEEDBACK_HASH);
        vm.stopPrank();

        uint256 ticketId2 = _mintTicket();

        vm.prank(payer);
        vm.expectRevert(ReputationRegistryV3.FeedbackHashAlreadyUsed.selector);
        registry.giveFeedbackWithTicket(ticketId2, 50, 0, "q", "", "/r", "", FEEDBACK_HASH);
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

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", registry.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPrivateKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        registry.giveFeedbackWithTicketFor(
            ReputationRegistryV3.FeedbackSubmission({
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

        assertEq(uint256(minter.tickets(ticketId).status), uint256(ITicketMinter.TicketStatus.CONSUMED));
    }

    function test_disputeFeedback_agentOnly() public {
        uint256 ticketId = _mintTicket();

        vm.prank(payer);
        registry.giveFeedbackWithTicket(ticketId, 100, 0, "q", "", "/r", "", FEEDBACK_HASH);

        vm.prank(agentOwner);
        registry.disputeFeedback(AGENT_ID, payer, 1);

        (,,,,, bool isDisputed) = registry.readFeedback(AGENT_ID, payer, 1);
        assertTrue(isDisputed);
    }
}
