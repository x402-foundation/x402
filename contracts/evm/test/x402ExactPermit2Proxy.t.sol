// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402BasePermit2Proxy} from "../src/x402BasePermit2Proxy.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";
import {MaliciousReentrantExact} from "./mocks/MaliciousReentrantExact.sol";

contract X402ExactPermit2ProxyTest is Test {
    x402ExactPermit2Proxy public proxy;
    MockPermit2 public mockPermit2;
    MockERC20 public token;

    address public payer;
    address public recipient;

    uint256 constant MINT_AMOUNT = 10_000e6;
    uint256 constant TRANSFER_AMOUNT = 100e6;

    event Settled();
    event SettledWithPermit();
    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);
    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);
    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    function setUp() public {
        vm.warp(1_000_000);

        payer = makeAddr("payer");
        recipient = makeAddr("recipient");

        mockPermit2 = new MockPermit2();
        proxy = new x402ExactPermit2Proxy(address(mockPermit2));
        token = new MockERC20("USDC", "USDC", 6);

        token.mint(payer, MINT_AMOUNT);
        vm.prank(payer);
        token.approve(address(mockPermit2), type(uint256).max);
        mockPermit2.setShouldActuallyTransfer(true);
    }

    function _permit(
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (ISignatureTransfer.PermitTransferFrom memory) {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(token), amount: amount}),
            nonce: nonce,
            deadline: deadline
        });
    }

    function _witness(address to, uint256 validAfter) internal pure returns (x402ExactPermit2Proxy.Witness memory) {
        return x402ExactPermit2Proxy.Witness({to: to, validAfter: validAfter});
    }

    function _sig() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
    }

    // --- Constructor ---

    function test_constructor_revertsOnZeroPermit2() public {
        vm.expectRevert(x402BasePermit2Proxy.InvalidPermit2Address.selector);
        new x402ExactPermit2Proxy(address(0));
    }

    function test_constructor_setsPermit2() public view {
        assertEq(address(proxy.PERMIT2()), address(mockPermit2));
    }

    // --- settle() validation ---

    function test_settle_revertsOnZeroOwner() public {
        uint256 t = block.timestamp;
        vm.expectRevert(x402BasePermit2Proxy.InvalidOwner.selector);
        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), address(0), _witness(recipient, t - 60), _sig());
    }

    function test_settle_revertsOnZeroDestination() public {
        uint256 t = block.timestamp;
        vm.expectRevert(x402BasePermit2Proxy.InvalidDestination.selector);
        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), payer, _witness(address(0), t - 60), _sig());
    }

    function test_settle_revertsBeforeValidAfter() public {
        uint256 t = block.timestamp;
        vm.expectRevert(x402BasePermit2Proxy.PaymentTooEarly.selector);
        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), payer, _witness(recipient, t + 60), _sig());
    }

    function test_settle_revertsOnZeroAmount() public {
        uint256 t = block.timestamp;
        vm.expectRevert(x402BasePermit2Proxy.InvalidAmount.selector);
        proxy.settle(_permit(0, 0, t + 3600), payer, _witness(recipient, t - 60), _sig());
    }

    // Note: validBefore was removed - upper time bound is enforced by Permit2's deadline

    // --- settle() success paths ---

    function test_settle_transfersExactPermittedAmount() public {
        uint256 t = block.timestamp;
        uint256 balanceBefore = token.balanceOf(recipient);

        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), payer, _witness(recipient, t - 60), _sig());

        assertEq(token.balanceOf(recipient) - balanceBefore, TRANSFER_AMOUNT);
    }

    function test_settle_emitsSettled() public {
        uint256 t = block.timestamp;

        vm.expectEmit(false, false, false, false);
        emit Settled();

        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), payer, _witness(recipient, t - 60), _sig());
    }

    function test_settle_atExactValidAfter() public {
        uint256 t = block.timestamp;
        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), payer, _witness(recipient, t), _sig());
        assertEq(token.balanceOf(recipient), TRANSFER_AMOUNT);
    }

    // --- Security: Permissionless settlement ---

    function test_settle_anyoneCanSettle() public {
        uint256 t = block.timestamp;
        address anyone = makeAddr("anyone");

        vm.prank(anyone);
        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), payer, _witness(recipient, t - 60), _sig());

        assertEq(token.balanceOf(recipient), TRANSFER_AMOUNT);
    }

    // --- Security: Reentrancy ---

    function test_settle_blocksReentrancy() public {
        MaliciousReentrantExact maliciousPermit2 = new MaliciousReentrantExact();
        x402ExactPermit2Proxy vulnerableProxy = new x402ExactPermit2Proxy(address(maliciousPermit2));
        maliciousPermit2.setTarget(address(vulnerableProxy));

        MockERC20 testToken = new MockERC20("Test", "TST", 6);
        testToken.mint(payer, MINT_AMOUNT);
        vm.prank(payer);
        testToken.approve(address(maliciousPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(testToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });
        x402ExactPermit2Proxy.Witness memory witness = _witness(recipient, t - 60);

        maliciousPermit2.setAttemptReentry(true);
        maliciousPermit2.setAttackParams(permit, payer, witness, _sig());

        vm.expectRevert();
        vulnerableProxy.settle(permit, payer, witness, _sig());
    }

    // --- Security: Proxy never holds funds ---

    function test_settle_proxyNeverHoldsTokens() public {
        uint256 t = block.timestamp;
        proxy.settle(_permit(TRANSFER_AMOUNT, 0, t + 3600), payer, _witness(recipient, t - 60), _sig());
        assertEq(token.balanceOf(address(proxy)), 0);
    }

    // --- settleWithPermit() ---

    function test_settleWithPermit_transfersTokens() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);
        vm.prank(payer);
        permitToken.approve(address(mockPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });

        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.expectEmit(false, false, false, false);
        emit SettledWithPermit();

        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());

        assertEq(permitToken.balanceOf(recipient), TRANSFER_AMOUNT);
    }

    function test_settleWithPermit_succeedsWhenPermitFails() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);
        permitToken.setPermitRevert(true, "Permit failed");

        vm.prank(payer);
        permitToken.approve(address(mockPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });

        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());

        assertEq(permitToken.balanceOf(recipient), TRANSFER_AMOUNT);
    }

    function test_settleWithPermit_emitsPermitFailedWithReason() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);
        permitToken.setPermitRevert(true, "Permit failed");
        vm.prank(payer);
        permitToken.approve(address(mockPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });
        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.expectEmit(true, true, false, true);
        emit EIP2612PermitFailedWithReason(address(permitToken), payer, "Permit failed");
        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());
    }

    function test_settleWithPermit_emitsPermitFailedWithPanic() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);
        permitToken.setRevertMode(MockERC20Permit.RevertMode.Panic);
        vm.prank(payer);
        permitToken.approve(address(mockPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });
        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.expectEmit(true, true, false, true);
        emit EIP2612PermitFailedWithPanic(address(permitToken), payer, 0x12);
        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());
    }

    function test_settleWithPermit_emitsPermitFailedWithData() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);
        permitToken.setRevertMode(MockERC20Permit.RevertMode.CustomError);
        vm.prank(payer);
        permitToken.approve(address(mockPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });
        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.expectEmit(true, true, false, false);
        emit EIP2612PermitFailedWithData(address(permitToken), payer, "");
        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());
    }

    function test_settleWithPermit_doesNotEmitPermitFailedOnSuccess() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);
        vm.prank(payer);
        permitToken.approve(address(mockPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });
        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.recordLogs();
        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());

        VmSafe.Log[] memory entries = vm.getRecordedLogs();
        bytes32 reasonSig = keccak256("EIP2612PermitFailedWithReason(address,address,string)");
        bytes32 panicSig = keccak256("EIP2612PermitFailedWithPanic(address,address,uint256)");
        bytes32 dataSig = keccak256("EIP2612PermitFailedWithData(address,address,bytes)");
        for (uint256 i = 0; i < entries.length; i++) {
            bytes32 topic = entries[i].topics[0];
            assertTrue(
                topic != reasonSig && topic != panicSig && topic != dataSig,
                "No permit failure event should be emitted on success"
            );
        }
    }

    function test_settleWithPermit_revertsOnZeroAmount() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);
        vm.prank(payer);
        permitToken.approve(address(mockPermit2), type(uint256).max);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: 0}),
            nonce: 0,
            deadline: t + 3600
        });

        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: 0,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.expectRevert(x402BasePermit2Proxy.InvalidAmount.selector);
        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());
    }

    function test_settleWithPermit_revertsWhenPermit2612ValueTooSmall() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });

        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT - 1,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.expectRevert(x402BasePermit2Proxy.Permit2612AmountMismatch.selector);
        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());
    }

    function test_settleWithPermit_revertsWhenPermit2612ValueTooLarge() public {
        MockERC20Permit permitToken = new MockERC20Permit("USDC", "USDC", 6);
        permitToken.mint(payer, MINT_AMOUNT);

        uint256 t = block.timestamp;
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: address(permitToken), amount: TRANSFER_AMOUNT}),
            nonce: 0,
            deadline: t + 3600
        });

        x402BasePermit2Proxy.EIP2612Permit memory permit2612 = x402BasePermit2Proxy.EIP2612Permit({
            value: TRANSFER_AMOUNT + 1,
            deadline: t + 3600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.expectRevert(x402BasePermit2Proxy.Permit2612AmountMismatch.selector);
        proxy.settleWithPermit(permit2612, permit, payer, _witness(recipient, t - 60), _sig());
    }

    // --- Fuzz: Time window ---

    function testFuzz_settle_afterValidAfter(uint256 validAfter, uint256 currentTime) public {
        validAfter = bound(validAfter, 0, type(uint64).max - 3601);
        currentTime = bound(currentTime, validAfter, type(uint64).max - 3601);

        vm.warp(currentTime);

        proxy.settle(_permit(TRANSFER_AMOUNT, 0, currentTime + 3600), payer, _witness(recipient, validAfter), _sig());

        assertEq(token.balanceOf(recipient), TRANSFER_AMOUNT);
    }

    function testFuzz_settle_revertsBeforeValidAfter(uint256 validAfter, uint256 currentTime) public {
        validAfter = bound(validAfter, 1000, type(uint64).max - 1000);
        currentTime = bound(currentTime, 0, validAfter - 1);

        vm.warp(currentTime);

        vm.expectRevert();
        proxy.settle(_permit(TRANSFER_AMOUNT, 0, currentTime + 3600), payer, _witness(recipient, validAfter), _sig());
    }

    // --- Fuzz: Amount (exact always transfers full permitted amount) ---

    function testFuzz_settle_alwaysTransfersExactPermittedAmount(
        uint256 permitted
    ) public {
        permitted = bound(permitted, 1, MINT_AMOUNT);

        uint256 t = block.timestamp;

        proxy.settle(_permit(permitted, 0, t + 3600), payer, _witness(recipient, t - 60), _sig());

        assertEq(token.balanceOf(recipient), permitted);
    }
}
