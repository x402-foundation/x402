// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {x402SwapSettler} from "../src/x402SwapSettler.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockERC3009NonceChecking} from "./mocks/MockERC3009NonceChecking.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {MaliciousReentrantSwapTarget} from "./mocks/MaliciousReentrantSwapTarget.sol";

contract X402SwapSettlerTest is Test {
    x402SwapSettler public settler;
    MockPermit2 public mockPermit2;
    MockERC20 public inputToken;
    MockERC20 public outputToken;
    MockSwapRouter public router;

    address public owner;
    address public facilitator;
    address public payer;
    uint256 public payerKey;
    address public payTo;

    // Cross-language golden vectors (shared with the TS extension and backend suites).
    // Derived from the spec's example accepts[] entry and quoteId "q_8f14e45fceea167a":
    //   requirementsHash = keccak256(jcs(requirements))
    //   quoteIdHash      = keccak256(utf8(quoteId))
    //   eip3009 nonce    = keccak256(abi.encode(quoteIdHash, requirementsHash))
    bytes32 constant GOLDEN_QUOTE_ID_HASH = 0x0ec5c6c5204979cad4df1caaebefd368acc5979cb6cca282942c65485cbcb9f9;
    bytes32 constant GOLDEN_REQUIREMENTS_HASH = 0x96e7f6618cfb269ac3e914ffaa2836a6c61befefd722909a8ff23df25a215861;
    bytes32 constant GOLDEN_EIP3009_NONCE = 0x70a9fff73f30c7fc0c32bf61e2cd3039b8a1aa0b7e82bb1d3cfdeb488ae01d1b;

    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // Local copy: calling settler.INTENT_TYPEHASH() inside helpers would consume
    // vm.prank/vm.expectRevert cheatcodes aimed at the settle call.
    bytes32 constant INTENT_TYPEHASH = keccak256(
        "SwapSettlementIntent(bytes32 quoteIdHash,bytes32 requirementsHash,address inputAsset,uint256 maxAmountIn,uint256 deadline)"
    );

    uint256 constant MINT_AMOUNT = 10e18;
    uint256 constant MAX_IN = 1e18;
    uint256 constant FEE = 0.01e18;
    uint256 constant SELL_CAP = MAX_IN - FEE; // 0.99e18
    uint256 constant SPEND = 0.9e18; // default route spend (< SELL_CAP)
    uint256 constant OUT = 10e6;

    event SwapSettled(
        bytes32 indexed quoteIdHash,
        address indexed payer,
        address inputAsset,
        uint256 amountIn,
        address outputAsset,
        uint256 amount,
        address payTo,
        uint256 facilitatorFee
    );
    event FacilitatorUpdated(address indexed facilitator, bool allowed);
    event SwapTargetUpdated(address indexed target, bool allowed);
    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);
    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);
    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    error OwnableUnauthorizedAccount(address account);
    error ReentrancyGuardReentrantCall();

    function setUp() public {
        vm.warp(1_000_000);

        owner = makeAddr("owner");
        facilitator = makeAddr("facilitator");
        (payer, payerKey) = makeAddrAndKey("payer");
        payTo = makeAddr("payTo");

        mockPermit2 = new MockPermit2();
        mockPermit2.setShouldActuallyTransfer(true);
        settler = new x402SwapSettler(address(mockPermit2), owner);
        inputToken = new MockERC20("Wrapped Ether", "WETH", 18);
        outputToken = new MockERC20("USD Coin", "USDC", 6);
        router = new MockSwapRouter();
        router.setBehavior(SPEND, OUT);

        vm.startPrank(owner);
        settler.setFacilitator(facilitator, true);
        settler.setSwapTarget(address(router), true);
        vm.stopPrank();

        inputToken.mint(payer, MINT_AMOUNT);
        outputToken.mint(address(router), 1_000_000e6);
        vm.prank(payer);
        inputToken.approve(address(mockPermit2), type(uint256).max);
    }

    // --- Helpers ---

    function _quote() internal view returns (x402SwapSettler.Quote memory) {
        return x402SwapSettler.Quote({
            quoteIdHash: GOLDEN_QUOTE_ID_HASH,
            requirementsHash: GOLDEN_REQUIREMENTS_HASH,
            payer: payer,
            inputAsset: address(inputToken),
            maxAmountIn: MAX_IN,
            facilitatorFee: FEE,
            outputAsset: address(outputToken),
            outputAmount: OUT,
            payTo: payTo,
            swapTarget: address(router),
            deadline: block.timestamp + 60
        });
    }

    function _routeData() internal view returns (bytes memory) {
        return abi.encodeCall(MockSwapRouter.swap, (address(inputToken), address(outputToken)));
    }

    function _permit2Auth() internal view returns (x402SwapSettler.Permit2WitnessAuth memory) {
        return x402SwapSettler.Permit2WitnessAuth({
            nonce: 1,
            deadline: block.timestamp + 60,
            signature: abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27))
        });
    }

    function _emptyPermit2Auth() internal pure returns (x402SwapSettler.Permit2WitnessAuth memory) {
        return x402SwapSettler.Permit2WitnessAuth({nonce: 0, deadline: 0, signature: ""});
    }

    function _eip2612Permit(
        uint256 value
    ) internal view returns (x402SwapSettler.EIP2612Permit memory) {
        return x402SwapSettler.EIP2612Permit({
            value: value,
            deadline: block.timestamp + 60,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2)),
            v: 27
        });
    }

    function _intentDigest(
        x402SwapSettler.Quote memory q,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("x402 swap-settlement"),
                keccak256("1"),
                block.chainid,
                address(settler)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(INTENT_TYPEHASH, q.quoteIdHash, q.requirementsHash, q.inputAsset, q.maxAmountIn, deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _intentAuth(
        x402SwapSettler.Quote memory q,
        uint256 signerKey
    ) internal view returns (x402SwapSettler.IntentAuth memory) {
        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _intentDigest(q, deadline));
        return x402SwapSettler.IntentAuth({deadline: deadline, signature: abi.encodePacked(r, s, v)});
    }

    function _settlePermit2(
        x402SwapSettler.Quote memory q
    ) internal {
        vm.prank(facilitator);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    // --- Constructor & admin ---

    function test_constructor_revertsOnZeroPermit2() public {
        vm.expectRevert(x402SwapSettler.InvalidPermit2Address.selector);
        new x402SwapSettler(address(0), owner);
    }

    function test_constructor_setsPermit2AndOwner() public view {
        assertEq(address(settler.PERMIT2()), address(mockPermit2));
        assertEq(settler.owner(), owner);
    }

    function test_constants_intentTypehashMatchesSpec() public view {
        assertEq(settler.INTENT_TYPEHASH(), INTENT_TYPEHASH);
    }

    function test_setFacilitator_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, address(this)));
        settler.setFacilitator(address(this), true);
    }

    function test_setSwapTarget_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(OwnableUnauthorizedAccount.selector, address(this)));
        settler.setSwapTarget(address(this), true);
    }

    function test_setFacilitator_togglesAndEmits() public {
        address f = makeAddr("newFacilitator");
        vm.expectEmit(true, false, false, true);
        emit FacilitatorUpdated(f, true);
        vm.prank(owner);
        settler.setFacilitator(f, true);
        assertTrue(settler.facilitators(f));

        vm.prank(owner);
        settler.setFacilitator(f, false);
        assertFalse(settler.facilitators(f));
    }

    function test_setSwapTarget_togglesAndEmits() public {
        address t = makeAddr("newTarget");
        vm.expectEmit(true, false, false, true);
        emit SwapTargetUpdated(t, true);
        vm.prank(owner);
        settler.setSwapTarget(t, true);
        assertTrue(settler.swapTargets(t));

        vm.prank(owner);
        settler.setSwapTarget(t, false);
        assertFalse(settler.swapTargets(t));
    }

    // --- Common validation (via settleWithPermit2) ---

    function test_settle_revertsForNonFacilitator() public {
        vm.expectRevert(x402SwapSettler.NotFacilitator.selector);
        settler.settleWithPermit2(_quote(), _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnExpiredQuoteDeadline() public {
        x402SwapSettler.Quote memory q = _quote();
        q.deadline = block.timestamp - 1;
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.QuoteDeadlineExpired.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnNonWhitelistedTarget() public {
        x402SwapSettler.Quote memory q = _quote();
        q.swapTarget = makeAddr("rogueTarget");
        vm.prank(facilitator);
        vm.expectRevert(abi.encodeWithSelector(x402SwapSettler.SwapTargetNotAllowed.selector, q.swapTarget));
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnZeroPayer() public {
        x402SwapSettler.Quote memory q = _quote();
        q.payer = address(0);
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnZeroPayTo() public {
        x402SwapSettler.Quote memory q = _quote();
        q.payTo = address(0);
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnZeroInputAsset() public {
        x402SwapSettler.Quote memory q = _quote();
        q.inputAsset = address(0);
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnZeroOutputAsset() public {
        x402SwapSettler.Quote memory q = _quote();
        q.outputAsset = address(0);
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnZeroMaxAmountIn() public {
        x402SwapSettler.Quote memory q = _quote();
        q.maxAmountIn = 0;
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnZeroOutputAmount() public {
        x402SwapSettler.Quote memory q = _quote();
        q.outputAmount = 0;
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsWhenFeeNotBelowMaxAmountIn() public {
        x402SwapSettler.Quote memory q = _quote();
        q.facilitatorFee = q.maxAmountIn;
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    function test_settle_revertsOnSameInputAndOutputAsset() public {
        x402SwapSettler.Quote memory q = _quote();
        q.outputAsset = q.inputAsset;
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidQuote.selector);
        settler.settleWithPermit2(q, _permit2Auth(), _routeData());
    }

    // --- settleWithPermit2 ---

    function test_settleWithPermit2_deliversExactOutputToPayTo() public {
        _settlePermit2(_quote());
        assertEq(outputToken.balanceOf(payTo), OUT);
    }

    function test_settleWithPermit2_refundsUnspentInputToPayer() public {
        _settlePermit2(_quote());
        // pulled MAX_IN, route spent SPEND, fee retained: refund = MAX_IN - SPEND - FEE
        assertEq(inputToken.balanceOf(payer), MINT_AMOUNT - SPEND - FEE);
    }

    function test_settleWithPermit2_paysFeeToCallingFacilitator() public {
        _settlePermit2(_quote());
        assertEq(inputToken.balanceOf(facilitator), FEE);
    }

    function test_settleWithPermit2_leavesNoBalanceOnSettler() public {
        _settlePermit2(_quote());
        assertEq(inputToken.balanceOf(address(settler)), 0);
        assertEq(outputToken.balanceOf(address(settler)), 0);
    }

    function test_settleWithPermit2_emitsSwapSettledWithComputedAmountIn() public {
        vm.expectEmit(true, true, false, true);
        emit SwapSettled(
            GOLDEN_QUOTE_ID_HASH, payer, address(inputToken), SPEND + FEE, address(outputToken), OUT, payTo, FEE
        );
        _settlePermit2(_quote());
    }

    function test_settleWithPermit2_marksQuoteConsumed() public {
        _settlePermit2(_quote());
        assertTrue(settler.consumedQuotes(GOLDEN_QUOTE_ID_HASH));
    }

    function test_settleWithPermit2_resetsRouterAllowance() public {
        _settlePermit2(_quote());
        assertEq(inputToken.allowance(address(settler), address(router)), 0);
    }

    function test_settleWithPermit2_refundsOutputSurplusToPayer() public {
        uint256 surplus = 5e6;
        router.setBehavior(SPEND, OUT + surplus);
        _settlePermit2(_quote());
        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(outputToken.balanceOf(payer), surplus);
    }

    function test_settleWithPermit2_revertsOnUnderDelivery() public {
        router.setBehavior(SPEND, OUT - 1);
        vm.prank(facilitator);
        vm.expectRevert(abi.encodeWithSelector(x402SwapSettler.InsufficientOutput.selector, OUT - 1, OUT));
        settler.settleWithPermit2(_quote(), _permit2Auth(), _routeData());
        // full revert: nothing moved, quote not consumed
        assertEq(outputToken.balanceOf(payTo), 0);
        assertEq(inputToken.balanceOf(facilitator), 0);
        assertFalse(settler.consumedQuotes(GOLDEN_QUOTE_ID_HASH));
    }

    function test_settleWithPermit2_revertsWhenRouteReverts() public {
        router.setShouldRevert(true);
        vm.prank(facilitator);
        vm.expectRevert(); // SwapCallFailed(bytes) wrapping the router revert
        settler.settleWithPermit2(_quote(), _permit2Auth(), _routeData());
    }

    function test_settleWithPermit2_feeCannotBeConsumedByRoute() public {
        // route tries to pull more than sellCap (MAX_IN - FEE): approval caps it, pull fails
        router.setBehavior(MAX_IN, OUT);
        vm.prank(facilitator);
        vm.expectRevert();
        settler.settleWithPermit2(_quote(), _permit2Auth(), _routeData());
    }

    function test_settleWithPermit2_toleratesInputDonatingRoute() public {
        // pathological route returns more input than it spends; amountIn clamps to fee
        uint256 donation = 2e18;
        inputToken.mint(address(router), donation);
        router.setDonateInput(donation);
        router.setBehavior(0, OUT);

        vm.expectEmit(true, true, false, true);
        emit SwapSettled(GOLDEN_QUOTE_ID_HASH, payer, address(inputToken), FEE, address(outputToken), OUT, payTo, FEE);
        _settlePermit2(_quote());

        // payer got everything back except the fee, plus the donation
        assertEq(inputToken.balanceOf(payer), MINT_AMOUNT - FEE + donation);
        assertEq(inputToken.balanceOf(address(settler)), 0);
    }

    function test_settleWithPermit2_dustTolerant() public {
        // pre-seeded balances must not skew delta accounting and must stay untouched
        uint256 inDust = 0.5e18;
        uint256 outDust = 3e6;
        inputToken.mint(address(settler), inDust);
        outputToken.mint(address(settler), outDust);

        _settlePermit2(_quote());

        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(inputToken.balanceOf(address(settler)), inDust);
        assertEq(outputToken.balanceOf(address(settler)), outDust);
    }

    function test_settleWithPermit2_zeroFeeQuote() public {
        x402SwapSettler.Quote memory q = _quote();
        q.facilitatorFee = 0;
        _settlePermit2(q);
        assertEq(inputToken.balanceOf(facilitator), 0);
        assertEq(inputToken.balanceOf(payer), MINT_AMOUNT - SPEND);
        assertEq(outputToken.balanceOf(payTo), OUT);
    }

    // --- Quote replay ---

    function test_replay_sameMethodReverts() public {
        _settlePermit2(_quote());
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.QuoteConsumed.selector);
        settler.settleWithPermit2(_quote(), _permit2Auth(), _routeData());
    }

    function test_replay_acrossMethodsReverts() public {
        _settlePermit2(_quote());
        x402SwapSettler.Quote memory q = _quote();
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.QuoteConsumed.selector);
        settler.settleWithAllowance(q, _intentAuth(q, payerKey), _routeData());
    }

    function test_replay_failedAttemptDoesNotConsume() public {
        router.setBehavior(SPEND, OUT - 1);
        vm.prank(facilitator);
        vm.expectRevert();
        settler.settleWithPermit2(_quote(), _permit2Auth(), _routeData());

        // consumed flag rolled back with the revert; a corrected attempt succeeds
        router.setBehavior(SPEND, OUT);
        _settlePermit2(_quote());
        assertEq(outputToken.balanceOf(payTo), OUT);
    }

    // --- settleWith3009 ---

    function test_settleWith3009_happyPathAndGoldenNonce() public {
        MockERC3009NonceChecking t3009 = new MockERC3009NonceChecking("cbBTC", "cbBTC", 8);
        t3009.mint(payer, MINT_AMOUNT);

        x402SwapSettler.Quote memory q = _quote();
        q.inputAsset = address(t3009);

        x402SwapSettler.EIP3009Auth memory a = x402SwapSettler.EIP3009Auth({
            validAfter: 0,
            validBefore: block.timestamp + 60,
            signature: abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27))
        });

        router.setBehavior(0, OUT); // route spends no input; only output delivery matters here
        bytes memory routeData = abi.encodeCall(MockSwapRouter.swap, (address(t3009), address(outputToken)));

        vm.prank(facilitator);
        settler.settleWith3009(q, a, routeData);

        // spec-normative nonce derivation, pinned to the cross-language golden vector
        assertEq(t3009.lastNonce(), keccak256(abi.encode(q.quoteIdHash, q.requirementsHash)));
        assertEq(t3009.lastNonce(), GOLDEN_EIP3009_NONCE);

        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(t3009.balanceOf(facilitator), FEE);
        assertEq(t3009.balanceOf(payer), MINT_AMOUNT - FEE); // route spent nothing
    }

    function test_settleWith3009_replayBlockedByConsumedSet() public {
        MockERC3009NonceChecking t3009 = new MockERC3009NonceChecking("cbBTC", "cbBTC", 8);
        t3009.mint(payer, MINT_AMOUNT);

        x402SwapSettler.Quote memory q = _quote();
        q.inputAsset = address(t3009);
        x402SwapSettler.EIP3009Auth memory a = x402SwapSettler.EIP3009Auth({
            validAfter: 0,
            validBefore: block.timestamp + 60,
            signature: ""
        });
        router.setBehavior(0, OUT);
        bytes memory routeData = abi.encodeCall(MockSwapRouter.swap, (address(t3009), address(outputToken)));

        vm.prank(facilitator);
        settler.settleWith3009(q, a, routeData);

        // the settler's consumed set fires before the token nonce is re-checked
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.QuoteConsumed.selector);
        settler.settleWith3009(q, a, routeData);
    }

    // --- settleWith2612 ---

    function _setup2612()
        internal
        returns (MockERC20Permit t2612, x402SwapSettler.Quote memory q, bytes memory routeData)
    {
        t2612 = new MockERC20Permit("Test Permit Token", "TPT", 18);
        t2612.mint(payer, MINT_AMOUNT);
        q = _quote();
        q.inputAsset = address(t2612);
        routeData = abi.encodeCall(MockSwapRouter.swap, (address(t2612), address(outputToken)));
        router.setBehavior(0, OUT);
    }

    function test_settleWith2612_bootstrapVariant() public {
        (MockERC20Permit t2612, x402SwapSettler.Quote memory q, bytes memory routeData) = _setup2612();

        // permit approves Permit2, acquisition runs through the witness-bound Permit2 path
        vm.prank(facilitator);
        settler.settleWith2612(q, _eip2612Permit(MAX_IN), _permit2Auth(), routeData);

        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(t2612.balanceOf(facilitator), FEE);
        assertEq(t2612.balanceOf(payer), MINT_AMOUNT - FEE);
    }

    function test_settleWith2612_directVariant() public {
        (MockERC20Permit t2612, x402SwapSettler.Quote memory q, bytes memory routeData) = _setup2612();

        // empty permit2 signature selects the direct-settler variant: permit approves the
        // settler, funds are pulled via transferFrom
        vm.prank(facilitator);
        settler.settleWith2612(q, _eip2612Permit(MAX_IN), _emptyPermit2Auth(), routeData);

        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(t2612.balanceOf(facilitator), FEE);
        assertEq(t2612.allowance(payer, address(settler)), 0); // exactly maxAmountIn approved and spent
    }

    function test_settleWith2612_revertsOnLowPermitValue() public {
        (, x402SwapSettler.Quote memory q, bytes memory routeData) = _setup2612();
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.PermitValueTooLow.selector);
        settler.settleWith2612(q, _eip2612Permit(MAX_IN - 1), _permit2Auth(), routeData);
    }

    function test_settleWith2612_toleratesPermitFrontRunning() public {
        (MockERC20Permit t2612, x402SwapSettler.Quote memory q, bytes memory routeData) = _setup2612();

        // allowance already exists (front-runner submitted the observed permit) and the
        // on-chain permit call now reverts — settlement MUST still proceed (spec)
        vm.prank(payer);
        t2612.approve(address(mockPermit2), MAX_IN);
        t2612.setPermitRevert(true, "ERC20Permit: invalid signature");

        vm.expectEmit(true, true, false, true);
        emit EIP2612PermitFailedWithReason(address(t2612), payer, "ERC20Permit: invalid signature");
        vm.prank(facilitator);
        settler.settleWith2612(q, _eip2612Permit(MAX_IN), _permit2Auth(), routeData);

        assertEq(outputToken.balanceOf(payTo), OUT);
    }

    function test_settleWith2612_emitsPermitFailedWithPanic() public {
        (MockERC20Permit t2612, x402SwapSettler.Quote memory q, bytes memory routeData) = _setup2612();
        vm.prank(payer);
        t2612.approve(address(mockPermit2), MAX_IN);
        t2612.setRevertMode(MockERC20Permit.RevertMode.Panic);

        vm.expectEmit(true, true, false, true);
        emit EIP2612PermitFailedWithPanic(address(t2612), payer, 0x12);
        vm.prank(facilitator);
        settler.settleWith2612(q, _eip2612Permit(MAX_IN), _permit2Auth(), routeData);
    }

    function test_settleWith2612_emitsPermitFailedWithData() public {
        (MockERC20Permit t2612, x402SwapSettler.Quote memory q, bytes memory routeData) = _setup2612();
        vm.prank(payer);
        t2612.approve(address(mockPermit2), MAX_IN);
        t2612.setRevertMode(MockERC20Permit.RevertMode.CustomError);

        vm.expectEmit(true, true, false, false);
        emit EIP2612PermitFailedWithData(address(t2612), payer, "");
        vm.prank(facilitator);
        settler.settleWith2612(q, _eip2612Permit(MAX_IN), _permit2Auth(), routeData);
    }

    function test_settleWith2612_revertsWhenPermitFailsAndNoAllowance() public {
        (MockERC20Permit t2612, x402SwapSettler.Quote memory q, bytes memory routeData) = _setup2612();
        t2612.setPermitRevert(true, "ERC20Permit: invalid signature");

        vm.prank(facilitator);
        vm.expectRevert();
        settler.settleWith2612(q, _eip2612Permit(MAX_IN), _permit2Auth(), routeData);
    }

    // --- settleWithAllowance ---

    function test_settleWithAllowance_happyPathECDSA() public {
        vm.prank(payer);
        inputToken.approve(address(settler), MAX_IN);

        x402SwapSettler.Quote memory q = _quote();
        vm.prank(facilitator);
        settler.settleWithAllowance(q, _intentAuth(q, payerKey), _routeData());

        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(inputToken.balanceOf(facilitator), FEE);
        assertEq(inputToken.balanceOf(payer), MINT_AMOUNT - SPEND - FEE);
    }

    function test_settleWithAllowance_revertsOnWrongSigner() public {
        vm.prank(payer);
        inputToken.approve(address(settler), MAX_IN);

        x402SwapSettler.Quote memory q = _quote();
        (, uint256 wrongKey) = makeAddrAndKey("wrongSigner");
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidIntentSignature.selector);
        settler.settleWithAllowance(q, _intentAuth(q, wrongKey), _routeData());
    }

    function test_settleWithAllowance_revertsOnTamperedQuoteBinding() public {
        vm.prank(payer);
        inputToken.approve(address(settler), MAX_IN);

        // intent signed for the golden quote, submitted with a different requirementsHash
        x402SwapSettler.Quote memory q = _quote();
        x402SwapSettler.IntentAuth memory a = _intentAuth(q, payerKey);
        q.requirementsHash = keccak256("tampered");
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidIntentSignature.selector);
        settler.settleWithAllowance(q, a, _routeData());
    }

    function test_settleWithAllowance_revertsOnExpiredIntent() public {
        x402SwapSettler.Quote memory q = _quote();
        x402SwapSettler.IntentAuth memory a = _intentAuth(q, payerKey);
        a.deadline = block.timestamp - 1;
        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.IntentDeadlineExpired.selector);
        settler.settleWithAllowance(q, a, _routeData());
    }

    function test_settleWithAllowance_revertsWithoutAllowance() public {
        x402SwapSettler.Quote memory q = _quote();
        vm.prank(facilitator);
        vm.expectRevert();
        settler.settleWithAllowance(q, _intentAuth(q, payerKey), _routeData());
    }

    function test_settleWithAllowance_acceptsERC1271Wallet() public {
        (address walletOwner, uint256 walletOwnerKey) = makeAddrAndKey("walletOwner");
        MockERC1271Wallet wallet = new MockERC1271Wallet(walletOwner);
        inputToken.mint(address(wallet), MINT_AMOUNT);
        wallet.approveToken(address(inputToken), address(settler), MAX_IN);

        x402SwapSettler.Quote memory q = _quote();
        q.payer = address(wallet);

        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletOwnerKey, _intentDigest(q, deadline));
        x402SwapSettler.IntentAuth memory a =
            x402SwapSettler.IntentAuth({deadline: deadline, signature: abi.encodePacked(r, s, v)});

        vm.prank(facilitator);
        settler.settleWithAllowance(q, a, _routeData());

        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(inputToken.balanceOf(address(wallet)), MINT_AMOUNT - SPEND - FEE);
    }

    function test_settleWithAllowance_rejectsERC1271WalletRefusal() public {
        (address walletOwner, uint256 walletOwnerKey) = makeAddrAndKey("walletOwner");
        MockERC1271Wallet wallet = new MockERC1271Wallet(walletOwner);
        inputToken.mint(address(wallet), MINT_AMOUNT);
        wallet.approveToken(address(inputToken), address(settler), MAX_IN);
        wallet.setAlwaysReject(true);

        x402SwapSettler.Quote memory q = _quote();
        q.payer = address(wallet);

        uint256 deadline = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(walletOwnerKey, _intentDigest(q, deadline));
        x402SwapSettler.IntentAuth memory a =
            x402SwapSettler.IntentAuth({deadline: deadline, signature: abi.encodePacked(r, s, v)});

        vm.prank(facilitator);
        vm.expectRevert(x402SwapSettler.InvalidIntentSignature.selector);
        settler.settleWithAllowance(q, a, _routeData());
    }

    // --- Reentrancy ---

    function test_reentrancy_blockedEvenForColludingFacilitator() public {
        MaliciousReentrantSwapTarget evil = new MaliciousReentrantSwapTarget();
        vm.startPrank(owner);
        settler.setSwapTarget(address(evil), true);
        settler.setFacilitator(address(evil), true); // colluding facilitator scenario
        vm.stopPrank();

        // inner quote uses a DIFFERENT quoteIdHash so the revert can only come from the
        // reentrancy guard, not the consumed set
        x402SwapSettler.Quote memory inner = _quote();
        inner.quoteIdHash = keccak256("inner-quote");
        evil.setAttack(
            address(settler),
            abi.encodeCall(settler.settleWithPermit2, (inner, _permit2Auth(), _routeData()))
        );

        x402SwapSettler.Quote memory outer = _quote();
        outer.swapTarget = address(evil);

        vm.prank(facilitator);
        vm.expectRevert(
            abi.encodeWithSelector(
                x402SwapSettler.SwapCallFailed.selector, abi.encodePacked(ReentrancyGuardReentrantCall.selector)
            )
        );
        settler.settleWithPermit2(outer, _permit2Auth(), _routeData());
    }
}
