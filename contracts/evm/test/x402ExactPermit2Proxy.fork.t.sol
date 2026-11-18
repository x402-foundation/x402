// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402BasePermit2Proxy} from "../src/x402BasePermit2Proxy.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title X402ExactPermit2ProxyForkTest
/// @notice Fork tests against real Permit2 deployment for exact amount transfers
/// @dev Run with: forge test --match-contract X402ExactPermit2ProxyForkTest --fork-url $RPC_URL
contract X402ExactPermit2ProxyForkTest is Test {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes32 constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 constant PERMIT_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)"
    );
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    x402ExactPermit2Proxy public proxy;
    MockERC20 public token;

    uint256 public payerKey;
    address public payer;
    address public recipient;

    uint256 constant MINT_AMOUNT = 10_000e6;
    uint256 constant TRANSFER_AMOUNT = 100e6;

    event Settled();

    function setUp() public {
        if (block.chainid == 31_337) return;
        require(PERMIT2.code.length > 0, "Permit2 not deployed");

        payerKey = uint256(keccak256("x402-test-payer"));
        payer = vm.addr(payerKey);
        recipient = makeAddr("recipient");

        proxy = new x402ExactPermit2Proxy(PERMIT2);
        token = new MockERC20("USDC", "USDC", 6);
        token.mint(payer, MINT_AMOUNT);

        vm.prank(payer);
        token.approve(PERMIT2, type(uint256).max);
    }

    modifier onlyFork() {
        if (block.chainid == 31_337) return;
        _;
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("Permit2"), block.chainid, PERMIT2));
    }

    function _nonce(
        uint256 salt
    ) internal view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(block.timestamp, block.number, salt)));
    }

    function _sign(
        address tokenAddr,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        x402ExactPermit2Proxy.Witness memory witness
    ) internal view returns (bytes memory) {
        bytes32 witnessHash = keccak256(abi.encode(proxy.WITNESS_TYPEHASH(), witness.to, witness.validAfter));

        bytes32 tokenHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, tokenAddr, amount));

        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, tokenHash, address(proxy), nonce, deadline, witnessHash));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_fork_settleWithRealPermit2() public onlyFork {
        uint256 t = block.timestamp;
        uint256 nonce = _nonce(1);
        uint256 deadline = t + 3600;

        x402ExactPermit2Proxy.Witness memory witness =
            x402ExactPermit2Proxy.Witness({to: recipient, validAfter: t - 60});

        bytes memory sig = _sign(address(token), TRANSFER_AMOUNT, nonce, deadline, witness);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: TRANSFER_AMOUNT}),
            nonce: nonce,
            deadline: deadline
        });

        uint256 balanceBefore = token.balanceOf(recipient);

        vm.expectEmit(false, false, false, false);
        emit Settled();

        proxy.settle(permit, payer, witness, sig);

        assertEq(token.balanceOf(recipient) - balanceBefore, TRANSFER_AMOUNT);
    }

    function test_fork_rejectsInvalidSignature() public onlyFork {
        uint256 t = block.timestamp;
        uint256 nonce = _nonce(2);

        x402ExactPermit2Proxy.Witness memory witness =
            x402ExactPermit2Proxy.Witness({to: recipient, validAfter: t - 60});

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: TRANSFER_AMOUNT}),
            nonce: nonce,
            deadline: t + 3600
        });

        bytes memory badSig = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));

        vm.expectRevert();
        proxy.settle(permit, payer, witness, badSig);
    }

    function test_fork_rejectsWrongSigner() public onlyFork {
        uint256 t = block.timestamp;
        uint256 nonce = _nonce(3);
        uint256 deadline = t + 3600;

        x402ExactPermit2Proxy.Witness memory witness =
            x402ExactPermit2Proxy.Witness({to: recipient, validAfter: t - 60});

        uint256 wrongKey = 0xdeadbeef;
        bytes32 witnessHash = keccak256(abi.encode(proxy.WITNESS_TYPEHASH(), witness.to, witness.validAfter));
        bytes32 tokenHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(token), TRANSFER_AMOUNT));
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, tokenHash, address(proxy), nonce, deadline, witnessHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, digest);
        bytes memory wrongSig = abi.encodePacked(r, s, v);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: TRANSFER_AMOUNT}),
            nonce: nonce,
            deadline: deadline
        });

        vm.expectRevert();
        proxy.settle(permit, payer, witness, wrongSig);
    }

    function test_fork_rejectsReplayedNonce() public onlyFork {
        uint256 t = block.timestamp;
        uint256 nonce = _nonce(4);
        uint256 deadline = t + 3600;

        x402ExactPermit2Proxy.Witness memory witness =
            x402ExactPermit2Proxy.Witness({to: recipient, validAfter: t - 60});

        bytes memory sig = _sign(address(token), TRANSFER_AMOUNT, nonce, deadline, witness);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: TRANSFER_AMOUNT}),
            nonce: nonce,
            deadline: deadline
        });

        proxy.settle(permit, payer, witness, sig);

        vm.expectRevert();
        proxy.settle(permit, payer, witness, sig);
    }

    function test_fork_rejectsExpiredDeadline() public onlyFork {
        uint256 t = block.timestamp;
        uint256 nonce = _nonce(5);
        uint256 deadline = t - 60; // expired (Permit2's deadline enforces the upper bound)

        x402ExactPermit2Proxy.Witness memory witness =
            x402ExactPermit2Proxy.Witness({to: recipient, validAfter: t - 120});

        bytes memory sig = _sign(address(token), TRANSFER_AMOUNT, nonce, deadline, witness);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: TRANSFER_AMOUNT}),
            nonce: nonce,
            deadline: deadline
        });

        vm.expectRevert();
        proxy.settle(permit, payer, witness, sig);
    }

    function test_fork_preventsDestinationTampering() public onlyFork {
        uint256 t = block.timestamp;
        uint256 nonce = _nonce(6);
        uint256 deadline = t + 3600;

        address attacker = makeAddr("attacker");

        x402ExactPermit2Proxy.Witness memory signedWitness =
            x402ExactPermit2Proxy.Witness({to: recipient, validAfter: t - 60});

        bytes memory sig = _sign(address(token), TRANSFER_AMOUNT, nonce, deadline, signedWitness);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: TRANSFER_AMOUNT}),
            nonce: nonce,
            deadline: deadline
        });

        x402ExactPermit2Proxy.Witness memory tamperedWitness =
            x402ExactPermit2Proxy.Witness({to: attacker, validAfter: signedWitness.validAfter});

        vm.expectRevert();
        proxy.settle(permit, payer, tamperedWitness, sig);
    }
}
