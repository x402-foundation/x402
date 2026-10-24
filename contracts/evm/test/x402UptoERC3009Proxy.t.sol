// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {x402UptoERC3009Proxy} from "../src/x402UptoERC3009Proxy.sol";

import {MockValidatingERC3009Token} from "./mocks/MockValidatingERC3009Token.sol";

contract X402UptoERC3009ProxyTest is Test {
    uint256 internal constant PAYER_KEY = 0xA11CE;
    uint256 internal constant OTHER_KEY = 0xB0B;
    uint256 internal constant MINT_AMOUNT = 10_000e6;
    uint256 internal constant MAX_AMOUNT = 100e6;
    uint256 internal constant SETTLEMENT_AMOUNT = 60e6;

    x402UptoERC3009Proxy internal proxy;
    MockValidatingERC3009Token internal token;

    address internal payer;
    address internal payTo;
    address internal other;

    event Settled();

    function setUp() public {
        vm.warp(1_000_000);

        payer = vm.addr(PAYER_KEY);
        payTo = makeAddr("payTo");
        other = vm.addr(OTHER_KEY);

        proxy = new x402UptoERC3009Proxy();
        token = new MockValidatingERC3009Token();
        token.mint(payer, MINT_AMOUNT);
    }

    function _paymentInfo(
        address destination,
        address settler,
        bytes32 salt
    ) internal pure returns (x402UptoERC3009Proxy.PaymentInfo memory) {
        return x402UptoERC3009Proxy.PaymentInfo({payTo: destination, settler: settler, salt: salt});
    }

    function _authorization(
        uint256 value,
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo
    ) internal view returns (x402UptoERC3009Proxy.Authorization memory) {
        bytes32 nonce =
            keccak256(abi.encode(proxy.NONCE_TYPEHASH(), paymentInfo.payTo, paymentInfo.settler, paymentInfo.salt));
        return x402UptoERC3009Proxy.Authorization({
            from: payer,
            to: address(proxy),
            value: value,
            validAfter: block.timestamp - 1,
            validBefore: block.timestamp + 1 hours,
            nonce: nonce
        });
    }

    function _signature(
        x402UptoERC3009Proxy.Authorization memory authorization,
        uint256 signerKey
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                authorization.from,
                authorization.to,
                authorization.value,
                authorization.validAfter,
                authorization.validBefore,
                authorization.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _settle(
        uint256 amount,
        uint256 maximum,
        bytes32 salt
    ) internal returns (x402UptoERC3009Proxy.Authorization memory authorization) {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), salt);
        authorization = _authorization(maximum, paymentInfo);
        proxy.settle(address(token), amount, authorization, paymentInfo, _signature(authorization, PAYER_KEY));
    }

    function test_nonceTypehash_matchesSpecification() public view {
        assertEq(proxy.NONCE_TYPEHASH(), keccak256("x402UptoERC3009Nonce(address payTo,address settler,bytes32 salt)"));
    }

    function test_settle_reverts_whenTokenIsZero() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        bytes memory signature = _signature(authorization, PAYER_KEY);

        vm.expectRevert(x402UptoERC3009Proxy.InvalidToken.selector);
        proxy.settle(address(0), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);
    }

    function test_settle_reverts_whenOwnerIsZero() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        authorization.from = address(0);

        vm.expectRevert(x402UptoERC3009Proxy.InvalidOwner.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenAuthorizationReceiverIsNotProxy() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        authorization.to = other;

        vm.expectRevert(x402UptoERC3009Proxy.InvalidAuthorizationReceiver.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenDestinationIsZero() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(address(0), address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);

        vm.expectRevert(x402UptoERC3009Proxy.InvalidDestination.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenDestinationIsProxy() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo =
            _paymentInfo(address(proxy), address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);

        vm.expectRevert(x402UptoERC3009Proxy.InvalidDestination.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenSettlerIsZero() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(0), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);

        vm.expectRevert(x402UptoERC3009Proxy.InvalidSettler.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenCallerIsNotSettler() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);

        vm.prank(other);
        vm.expectRevert(x402UptoERC3009Proxy.UnauthorizedSettler.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenAmountIsZero() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);

        vm.expectRevert(x402UptoERC3009Proxy.InvalidAmount.selector);
        proxy.settle(address(token), 0, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenAmountExceedsAuthorization() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);

        vm.expectRevert(x402UptoERC3009Proxy.AmountExceedsAuthorization.selector);
        proxy.settle(address(token), MAX_AMOUNT + 1, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenPayToDoesNotMatchNonceCommitment() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        paymentInfo.payTo = other;

        vm.expectRevert(x402UptoERC3009Proxy.InvalidNonce.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenSettlerDoesNotMatchNonceCommitment() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        paymentInfo.settler = other;

        vm.prank(other);
        vm.expectRevert(x402UptoERC3009Proxy.InvalidNonce.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenSaltDoesNotMatchNonceCommitment() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        paymentInfo.salt = bytes32("different");

        vm.expectRevert(x402UptoERC3009Proxy.InvalidNonce.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, hex"");
    }

    function test_settle_reverts_whenSignatureIsInvalid() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        bytes memory signature = _signature(authorization, OTHER_KEY);

        vm.expectRevert(MockValidatingERC3009Token.InvalidSignature.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);
    }

    function test_settle_reverts_whenAuthorizationIsNotYetValid() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        authorization.validAfter = block.timestamp;
        bytes memory signature = _signature(authorization, PAYER_KEY);

        vm.expectRevert(MockValidatingERC3009Token.AuthorizationNotYetValid.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);
    }

    function test_settle_reverts_whenAuthorizationIsExpired() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        authorization.validBefore = block.timestamp;
        bytes memory signature = _signature(authorization, PAYER_KEY);

        vm.expectRevert(MockValidatingERC3009Token.AuthorizationExpired.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);
    }

    function test_settle_reverts_whenAuthorizationIsReplayed() public {
        bytes32 salt = bytes32("salt");
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), salt);
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        bytes memory signature = _signature(authorization, PAYER_KEY);

        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);

        vm.expectRevert(MockValidatingERC3009Token.AuthorizationUsed.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);
    }

    function test_gas_settle_partialAmountAndRefund() public {
        uint256 payerBefore = token.balanceOf(payer);

        _settle(SETTLEMENT_AMOUNT, MAX_AMOUNT, bytes32("salt"));

        assertEq(token.balanceOf(payTo), SETTLEMENT_AMOUNT);
        assertEq(token.balanceOf(payer), payerBefore - SETTLEMENT_AMOUNT);
        assertEq(token.balanceOf(address(proxy)), 0);
    }

    function test_gas_settle_fullAuthorizationWithoutRefund() public {
        uint256 payerBefore = token.balanceOf(payer);

        _settle(MAX_AMOUNT, MAX_AMOUNT, bytes32("salt"));

        assertEq(token.balanceOf(payTo), MAX_AMOUNT);
        assertEq(token.balanceOf(payer), payerBefore - MAX_AMOUNT);
        assertEq(token.balanceOf(address(proxy)), 0);
    }

    function test_settle_emitsSettled() public {
        vm.expectEmit(false, false, false, false);
        emit Settled();

        _settle(SETTLEMENT_AMOUNT, MAX_AMOUNT, bytes32("salt"));
    }

    function test_settle_preservesDonatedBalance() public {
        uint256 donation = 7e6;
        token.mint(address(proxy), donation);

        _settle(SETTLEMENT_AMOUNT, MAX_AMOUNT, bytes32("salt"));

        assertEq(token.balanceOf(address(proxy)), donation);
    }

    function test_settle_rollsBackWhenMerchantTransferFails() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        bytes memory signature = _signature(authorization, PAYER_KEY);
        uint256 payerBefore = token.balanceOf(payer);
        token.setFailedRecipient(payTo);

        vm.expectRevert(MockValidatingERC3009Token.TransferFailed.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);

        assertFalse(token.authorizationState(payer, authorization.nonce));
        assertEq(token.balanceOf(payer), payerBefore);
        assertEq(token.balanceOf(payTo), 0);
        assertEq(token.balanceOf(address(proxy)), 0);
    }

    function test_settle_rollsBackWhenRefundFails() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        bytes memory signature = _signature(authorization, PAYER_KEY);
        uint256 payerBefore = token.balanceOf(payer);
        token.setFailedRecipient(payer);

        vm.expectRevert(MockValidatingERC3009Token.TransferFailed.selector);
        proxy.settle(address(token), SETTLEMENT_AMOUNT, authorization, paymentInfo, signature);

        assertFalse(token.authorizationState(payer, authorization.nonce));
        assertEq(token.balanceOf(payer), payerBefore);
        assertEq(token.balanceOf(payTo), 0);
        assertEq(token.balanceOf(address(proxy)), 0);
    }

    function test_settle_blocksReentrancyWithIndependentAuthorization() public {
        x402UptoERC3009Proxy.PaymentInfo memory innerPaymentInfo = _paymentInfo(other, address(token), bytes32("inner"));
        x402UptoERC3009Proxy.Authorization memory innerAuthorization = _authorization(10e6, innerPaymentInfo);
        bytes memory innerSignature = _signature(innerAuthorization, PAYER_KEY);
        bytes memory reentryData =
            abi.encodeCall(proxy.settle, (address(token), 10e6, innerAuthorization, innerPaymentInfo, innerSignature));
        token.setReentry(address(proxy), reentryData);

        _settle(SETTLEMENT_AMOUNT, MAX_AMOUNT, bytes32("outer"));

        assertFalse(token.reentrySucceeded());
        assertFalse(token.authorizationState(payer, innerAuthorization.nonce));
        assertEq(token.balanceOf(other), 0);
    }

    function test_receiveWithAuthorization_reverts_whenCalledDirectlyByAttacker() public {
        x402UptoERC3009Proxy.PaymentInfo memory paymentInfo = _paymentInfo(payTo, address(this), bytes32("salt"));
        x402UptoERC3009Proxy.Authorization memory authorization = _authorization(MAX_AMOUNT, paymentInfo);
        bytes memory signature = _signature(authorization, PAYER_KEY);

        vm.prank(other);
        vm.expectRevert(MockValidatingERC3009Token.CallerMustBePayee.selector);
        token.receiveWithAuthorization(
            authorization.from,
            authorization.to,
            authorization.value,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            signature
        );
    }

    function testFuzz_settle_preservesValueAndPaysRequestedAmount(
        uint256 amount,
        uint256 maximum,
        bytes32 salt
    ) public {
        maximum = bound(maximum, 1, MINT_AMOUNT);
        amount = bound(amount, 1, maximum);
        uint256 payerBefore = token.balanceOf(payer);

        _settle(amount, maximum, salt);

        assertEq(token.balanceOf(payTo), amount);
        assertEq(token.balanceOf(payer), payerBefore - amount);
        assertEq(token.balanceOf(address(proxy)), 0);
    }
}
