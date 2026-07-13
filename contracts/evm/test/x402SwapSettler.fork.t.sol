// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {x402SwapSettler} from "../src/x402SwapSettler.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";

/// @title X402SwapSettlerForkTest
/// @notice Fork tests against the real Permit2 deployment: witness binding, nonce replay,
///         and the normative typestring reconstruction.
/// @dev Run with: forge test --match-contract X402SwapSettlerForkTest --fork-url $RPC_URL
contract X402SwapSettlerForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    // Permit2 reconstructs the full typehash as
    //   "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,"
    //   + witnessTypeString
    // with the spec-normative witnessTypeString for SwapWitness appended.
    bytes32 constant PERMIT_WITNESS_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,SwapWitness witness)SwapWitness(bytes32 quoteIdHash,bytes32 requirementsHash,address payTo,address outputAsset,uint256 outputAmount)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 constant WITNESS_TYPEHASH = keccak256(
        "SwapWitness(bytes32 quoteIdHash,bytes32 requirementsHash,address payTo,address outputAsset,uint256 outputAmount)"
    );

    x402SwapSettler public settler;
    MockERC20 public inputToken;
    MockERC20 public outputToken;
    MockSwapRouter public router;

    uint256 public payerKey;
    address public payer;
    address public payTo;

    uint256 constant MINT_AMOUNT = 10e18;
    uint256 constant MAX_IN = 1e18;
    uint256 constant FEE = 0.01e18;
    uint256 constant SPEND = 0.9e18;
    uint256 constant OUT = 10e6;

    function setUp() public {
        if (block.chainid == 31_337) return;
        require(PERMIT2.code.length > 0, "Permit2 not deployed");

        payerKey = uint256(keccak256("x402-swap-test-payer"));
        payer = vm.addr(payerKey);
        payTo = makeAddr("payTo");

        settler = new x402SwapSettler(PERMIT2, address(this));
        settler.setFacilitator(address(this), true);

        inputToken = new MockERC20("Wrapped Ether", "WETH", 18);
        outputToken = new MockERC20("USD Coin", "USDC", 6);
        router = new MockSwapRouter();
        router.setBehavior(SPEND, OUT);
        outputToken.mint(address(router), 1_000_000e6);
        settler.setSwapTarget(address(router), true);

        inputToken.mint(payer, MINT_AMOUNT);
        vm.prank(payer);
        inputToken.approve(PERMIT2, type(uint256).max);
    }

    modifier onlyFork() {
        if (block.chainid == 31_337) return;
        _;
    }

    // --- Helpers ---

    function _quote(
        bytes32 quoteIdHash
    ) internal view returns (x402SwapSettler.Quote memory) {
        return x402SwapSettler.Quote({
            quoteIdHash: quoteIdHash,
            requirementsHash: keccak256("requirements"),
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

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, PERMIT2));
    }

    /// @dev Signs PermitWitnessTransferFrom over explicit witness fields so tests can sign
    ///      one thing and submit another (witness-mismatch cases).
    function _sign(
        x402SwapSettler.Quote memory signed,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 witnessHash = keccak256(
            abi.encode(
                WITNESS_TYPEHASH,
                signed.quoteIdHash,
                signed.requirementsHash,
                signed.payTo,
                signed.outputAsset,
                signed.outputAmount
            )
        );
        bytes32 tokenHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, signed.inputAsset, signed.maxAmountIn));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_WITNESS_TYPEHASH, tokenHash, address(settler), nonce, deadline, witnessHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _auth(
        uint256 nonce,
        uint256 deadline,
        bytes memory sig
    ) internal pure returns (x402SwapSettler.Permit2WitnessAuth memory) {
        return x402SwapSettler.Permit2WitnessAuth({nonce: nonce, deadline: deadline, signature: sig});
    }

    // --- Tests ---

    function test_fork_typestringMatchesPermit2Reconstruction() public onlyFork {
        assertEq(
            keccak256(
                abi.encodePacked(
                    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                    settler.WITNESS_TYPE_STRING()
                )
            ),
            PERMIT_WITNESS_TYPEHASH
        );
    }

    function test_fork_settleWithRealPermit2() public onlyFork {
        x402SwapSettler.Quote memory q = _quote(keccak256("q1"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(q, 1, deadline);

        settler.settleWithPermit2(q, _auth(1, deadline, sig), _routeData());

        assertEq(outputToken.balanceOf(payTo), OUT);
        assertEq(inputToken.balanceOf(payer), MINT_AMOUNT - SPEND - FEE);
        assertEq(inputToken.balanceOf(address(this)), FEE);
        assertEq(inputToken.balanceOf(address(settler)), 0);
    }

    function test_fork_rejectsTamperedQuoteIdHash() public onlyFork {
        x402SwapSettler.Quote memory signed = _quote(keccak256("q2"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(signed, 2, deadline);

        x402SwapSettler.Quote memory submitted = signed;
        submitted.quoteIdHash = keccak256("tampered");
        vm.expectRevert();
        settler.settleWithPermit2(submitted, _auth(2, deadline, sig), _routeData());
    }

    function test_fork_rejectsTamperedRequirementsHash() public onlyFork {
        x402SwapSettler.Quote memory signed = _quote(keccak256("q3"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(signed, 3, deadline);

        x402SwapSettler.Quote memory submitted = signed;
        submitted.requirementsHash = keccak256("tampered");
        vm.expectRevert();
        settler.settleWithPermit2(submitted, _auth(3, deadline, sig), _routeData());
    }

    function test_fork_rejectsTamperedPayTo() public onlyFork {
        x402SwapSettler.Quote memory signed = _quote(keccak256("q4"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(signed, 4, deadline);

        x402SwapSettler.Quote memory submitted = signed;
        submitted.payTo = makeAddr("attacker");
        vm.expectRevert();
        settler.settleWithPermit2(submitted, _auth(4, deadline, sig), _routeData());
    }

    function test_fork_rejectsTamperedOutputAsset() public onlyFork {
        x402SwapSettler.Quote memory signed = _quote(keccak256("q5"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(signed, 5, deadline);

        x402SwapSettler.Quote memory submitted = signed;
        submitted.outputAsset = address(new MockERC20("Fake", "FAKE", 6));
        vm.expectRevert();
        settler.settleWithPermit2(submitted, _auth(5, deadline, sig), _routeData());
    }

    function test_fork_rejectsTamperedOutputAmount() public onlyFork {
        x402SwapSettler.Quote memory signed = _quote(keccak256("q6"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(signed, 6, deadline);

        x402SwapSettler.Quote memory submitted = signed;
        submitted.outputAmount = OUT - 1;
        vm.expectRevert();
        settler.settleWithPermit2(submitted, _auth(6, deadline, sig), _routeData());
    }

    function test_fork_rejectsTamperedMaxAmountIn() public onlyFork {
        // permitted.amount is reconstructed from q.maxAmountIn — inflating it invalidates the signature
        x402SwapSettler.Quote memory signed = _quote(keccak256("q7"));
        uint256 deadline = block.timestamp + 3600;
        bytes memory sig = _sign(signed, 7, deadline);

        x402SwapSettler.Quote memory submitted = signed;
        submitted.maxAmountIn = MAX_IN * 2;
        vm.expectRevert();
        settler.settleWithPermit2(submitted, _auth(7, deadline, sig), _routeData());
    }

    function test_fork_rejectsReplayedPermit2Nonce() public onlyFork {
        x402SwapSettler.Quote memory q1 = _quote(keccak256("q8"));
        uint256 deadline = block.timestamp + 3600;
        settler.settleWithPermit2(q1, _auth(8, deadline, _sign(q1, 8, deadline)), _routeData());

        // fresh quote (different quoteIdHash so the consumed set stays out of the way),
        // same Permit2 nonce — Permit2's nonce bitmap must reject it
        x402SwapSettler.Quote memory q2 = _quote(keccak256("q9"));
        bytes memory sig2 = _sign(q2, 8, deadline);
        vm.expectRevert();
        settler.settleWithPermit2(q2, _auth(8, deadline, sig2), _routeData());
    }

    function test_fork_rejectsWrongSigner() public onlyFork {
        x402SwapSettler.Quote memory q = _quote(keccak256("q10"));
        uint256 deadline = block.timestamp + 3600;

        uint256 wrongKey = 0xdeadbeef;
        bytes32 witnessHash = keccak256(
            abi.encode(WITNESS_TYPEHASH, q.quoteIdHash, q.requirementsHash, q.payTo, q.outputAsset, q.outputAmount)
        );
        bytes32 tokenHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, q.inputAsset, q.maxAmountIn));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_WITNESS_TYPEHASH, tokenHash, address(settler), 10, deadline, witnessHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, digest);

        vm.expectRevert();
        settler.settleWithPermit2(q, _auth(10, deadline, abi.encodePacked(r, s, v)), _routeData());
    }
}
