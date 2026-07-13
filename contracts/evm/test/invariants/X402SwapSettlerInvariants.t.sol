// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {x402SwapSettler} from "../../src/x402SwapSettler.sol";
import {MockPermit2} from "../mocks/MockPermit2.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";

contract X402SwapSettlerHandler is Test {
    x402SwapSettler public settler;
    MockERC20 public inputToken;
    MockERC20 public outputToken;
    MockSwapRouter public router;

    address public payer;
    address public payTo;
    address public facilitator;

    // Ghost accounting over successful settlements only
    uint256 public totalDelivered;
    uint256 public totalMaxIn;
    uint256 public totalFees;
    uint256 public settleCallCount;
    uint256 internal quoteSeq;

    constructor(
        x402SwapSettler _settler,
        MockERC20 _inputToken,
        MockERC20 _outputToken,
        MockSwapRouter _router,
        address _payer,
        address _payTo,
        address _facilitator
    ) {
        settler = _settler;
        inputToken = _inputToken;
        outputToken = _outputToken;
        router = _router;
        payer = _payer;
        payTo = _payTo;
        facilitator = _facilitator;
    }

    function settle(uint256 maxIn, uint256 fee, uint256 outAmount, uint256 spend, uint256 give) external {
        maxIn = bound(maxIn, 0, inputToken.balanceOf(payer));
        if (maxIn < 2) return;
        fee = bound(fee, 0, maxIn - 1);
        outAmount = bound(outAmount, 1, 1000e6);
        spend = bound(spend, 0, maxIn - fee);
        // exercise under-delivery, exact and surplus paths
        give = bound(give, outAmount > 2 ? outAmount - 2 : 0, outAmount + 5e6);
        if (give > outputToken.balanceOf(address(router))) return;

        router.setBehavior(spend, give);
        quoteSeq++;

        x402SwapSettler.Quote memory q = x402SwapSettler.Quote({
            quoteIdHash: keccak256(abi.encode("invariant-quote", quoteSeq)),
            requirementsHash: keccak256("requirements"),
            payer: payer,
            inputAsset: address(inputToken),
            maxAmountIn: maxIn,
            facilitatorFee: fee,
            outputAsset: address(outputToken),
            outputAmount: outAmount,
            payTo: payTo,
            swapTarget: address(router),
            deadline: block.timestamp + 60
        });

        x402SwapSettler.Permit2WitnessAuth memory a = x402SwapSettler.Permit2WitnessAuth({
            nonce: quoteSeq,
            deadline: block.timestamp + 60,
            signature: abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27))
        });

        vm.prank(facilitator);
        try settler.settleWithPermit2(
            q, a, abi.encodeCall(MockSwapRouter.swap, (address(inputToken), address(outputToken)))
        ) {
            totalDelivered += outAmount;
            totalMaxIn += maxIn;
            totalFees += fee;
            settleCallCount++;
        } catch {}
    }
}

contract X402SwapSettlerInvariantsTest is Test {
    x402SwapSettler public settler;
    MockPermit2 public mockPermit2;
    MockERC20 public inputToken;
    MockERC20 public outputToken;
    MockSwapRouter public router;
    X402SwapSettlerHandler public handler;

    address public payer;
    address public payTo;
    address public facilitator;

    uint256 constant INPUT_MINT = 1_000_000e18;
    uint256 constant OUTPUT_MINT = 100_000_000e6;

    function setUp() public {
        vm.warp(1_000_000);

        payer = makeAddr("payer");
        payTo = makeAddr("payTo");
        facilitator = makeAddr("facilitator");

        mockPermit2 = new MockPermit2();
        mockPermit2.setShouldActuallyTransfer(true);
        settler = new x402SwapSettler(address(mockPermit2), address(this));
        inputToken = new MockERC20("Wrapped Ether", "WETH", 18);
        outputToken = new MockERC20("USD Coin", "USDC", 6);
        router = new MockSwapRouter();

        settler.setFacilitator(facilitator, true);
        settler.setSwapTarget(address(router), true);

        inputToken.mint(payer, INPUT_MINT);
        outputToken.mint(address(router), OUTPUT_MINT);
        vm.prank(payer);
        inputToken.approve(address(mockPermit2), type(uint256).max);

        handler =
            new X402SwapSettlerHandler(settler, inputToken, outputToken, router, payer, payTo, facilitator);
        targetContract(address(handler));
    }

    /// @notice payTo receives exactly the sum of quoted output amounts — never more, never less
    function invariant_payToReceivesExactlyQuotedOutput() public view {
        assertEq(outputToken.balanceOf(payTo), handler.totalDelivered());
    }

    /// @notice The payer's input-asset loss is bounded by the sum of maxAmountIn across settlements
    function invariant_payerLossBoundedByMaxAmountIn() public view {
        assertLe(INPUT_MINT - inputToken.balanceOf(payer), handler.totalMaxIn());
    }

    /// @notice The facilitator earns exactly the quoted fees — fee inflation is impossible
    function invariant_facilitatorGainEqualsQuotedFees() public view {
        assertEq(inputToken.balanceOf(facilitator), handler.totalFees());
    }

    /// @notice The settler never accumulates balance in either asset
    function invariant_settlerHoldsNothing() public view {
        assertEq(inputToken.balanceOf(address(settler)), 0);
        assertEq(outputToken.balanceOf(address(settler)), 0);
    }

    /// @notice Input-token conservation across all participants
    function invariant_inputTokenConservation() public view {
        uint256 total = inputToken.balanceOf(payer) + inputToken.balanceOf(facilitator)
            + inputToken.balanceOf(address(router)) + inputToken.balanceOf(address(settler));
        assertEq(total, INPUT_MINT);
    }

    /// @notice Output-token conservation across all participants (payer receives surpluses)
    function invariant_outputTokenConservation() public view {
        uint256 total = outputToken.balanceOf(address(router)) + outputToken.balanceOf(payTo)
            + outputToken.balanceOf(payer) + outputToken.balanceOf(address(settler));
        assertEq(total, OUTPUT_MINT);
    }
}
