// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IERC3009} from "./interfaces/IERC3009.sol";
import {IERC3009VRS} from "./interfaces/IERC3009VRS.sol";

/// @title x402UptoERC3009Proxy
/// @notice Settles usage-based ERC-3009 payments and refunds the unused authorization amount.
/// @author Coinbase
contract x402UptoERC3009Proxy is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Typehash used to bind the payment recipient and settler into the ERC-3009 nonce.
    bytes32 public constant NONCE_TYPEHASH =
        keccak256("x402UptoERC3009Nonce(address payTo,address settler,bytes32 salt)");

    /// @notice Emitted after a payment is settled and its remainder is refunded.
    event Settled();

    /// @notice Thrown when the settlement amount exceeds the signed authorization value.
    error AmountExceedsAuthorization();

    /// @notice Thrown when a settlement leg does not change the recipient balance by the exact amount.
    error ReceivedAmountMismatch();

    /// @notice Thrown when the ERC-3009 authorization does not name this proxy as its receiver.
    error InvalidAuthorizationReceiver();

    /// @notice Thrown when the settlement amount is zero.
    error InvalidAmount();

    /// @notice Thrown when the payment destination is zero or this proxy.
    error InvalidDestination();

    /// @notice Thrown when the authorization nonce does not match the payment information.
    error InvalidNonce();

    /// @notice Thrown when the token owner is zero.
    error InvalidOwner();

    /// @notice Thrown when the bound settler is zero.
    error InvalidSettler();

    /// @notice Thrown when the token is zero.
    error InvalidToken();

    /// @notice Thrown when the caller is not the bound settler.
    error UnauthorizedSettler();

    /// @notice ERC-3009 authorization signed by the token owner.
    struct Authorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    /// @notice Payment fields committed through `Authorization.nonce`.
    struct PaymentInfo {
        address payTo;
        address settler;
        bytes32 salt;
    }

    /// @notice Pulls the signed maximum, pays the metered amount, and refunds the remainder.
    ///
    /// @dev Reverts with `InvalidToken` when `token == address(0)`.
    /// @dev Reverts with `InvalidOwner` when `authorization.from == address(0)`.
    /// @dev Reverts with `InvalidAuthorizationReceiver` when `authorization.to != address(this)`.
    /// @dev Reverts with `InvalidDestination` when `paymentInfo.payTo` is zero or this proxy.
    /// @dev Reverts with `InvalidSettler` when `paymentInfo.settler == address(0)`.
    /// @dev Reverts with `UnauthorizedSettler` when the caller is not `paymentInfo.settler`.
    /// @dev Reverts with `InvalidAmount` when `amount == 0`.
    /// @dev Reverts with `AmountExceedsAuthorization` when `amount > authorization.value`.
    /// @dev Reverts with `InvalidNonce` when the nonce does not commit to `paymentInfo`.
    /// @dev Reverts with `ReceivedAmountMismatch` when the proxy, recipient, or payer does not
    ///      receive the exact token amount for that leg.
    /// @dev Reverts with the token's reason when authorization receipt or either transfer fails.
    ///
    /// @param token ERC-3009 token to settle.
    /// @param amount Amount paid to `paymentInfo.payTo`.
    /// @param authorization Token authorization for the maximum payment amount.
    /// @param paymentInfo Recipient, settler, and salt committed through the nonce.
    /// @param signature Token owner's `ReceiveWithAuthorization` signature.
    function settle(
        address token,
        uint256 amount,
        Authorization calldata authorization,
        PaymentInfo calldata paymentInfo,
        bytes calldata signature
    ) external nonReentrant {
        if (token == address(0)) revert InvalidToken();
        if (authorization.from == address(0)) revert InvalidOwner();
        if (authorization.to != address(this)) revert InvalidAuthorizationReceiver();
        if (paymentInfo.payTo == address(0) || paymentInfo.payTo == address(this)) revert InvalidDestination();
        if (paymentInfo.settler == address(0)) revert InvalidSettler();
        if (msg.sender != paymentInfo.settler) revert UnauthorizedSettler();
        if (amount == 0) revert InvalidAmount();
        if (amount > authorization.value) revert AmountExceedsAuthorization();

        bytes32 expectedNonce =
            keccak256(abi.encode(NONCE_TYPEHASH, paymentInfo.payTo, paymentInfo.settler, paymentInfo.salt));
        if (authorization.nonce != expectedNonce) revert InvalidNonce();

        IERC20 asset = IERC20(token);
        uint256 balanceBefore = asset.balanceOf(address(this));

        _receiveWithAuthorization(token, authorization, signature);

        uint256 balanceAfter = asset.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != authorization.value) {
            revert ReceivedAmountMismatch();
        }

        uint256 payToBefore = asset.balanceOf(paymentInfo.payTo);
        asset.safeTransfer(paymentInfo.payTo, amount);
        uint256 payToAfter = asset.balanceOf(paymentInfo.payTo);
        if (payToAfter < payToBefore || payToAfter - payToBefore != amount) revert ReceivedAmountMismatch();

        uint256 refundAmount = authorization.value - amount;
        if (refundAmount != 0) {
            uint256 payerBefore = asset.balanceOf(authorization.from);
            asset.safeTransfer(authorization.from, refundAmount);
            uint256 payerAfter = asset.balanceOf(authorization.from);
            if (payerAfter < payerBefore || payerAfter - payerBefore != refundAmount) revert ReceivedAmountMismatch();
        }

        emit Settled();
    }

    /// @dev Uses the smart-wallet-compatible bytes overload when available, then falls back to
    ///      the normative ERC-3009 split-signature overload for 65-byte ECDSA signatures.
    function _receiveWithAuthorization(
        address token,
        Authorization calldata authorization,
        bytes calldata signature
    ) private {
        try IERC3009(token)
            .receiveWithAuthorization({
            from: authorization.from,
            to: authorization.to,
            value: authorization.value,
            validAfter: authorization.validAfter,
            validBefore: authorization.validBefore,
            nonce: authorization.nonce,
            signature: signature
        }) {}
        catch (bytes memory bytesReason) {
            if (signature.length != 65) {
                _revertWithReason(bytesReason);
            }

            (uint8 v, bytes32 r, bytes32 s) = _splitSignature(signature);
            try IERC3009VRS(token)
                .receiveWithAuthorization({
                from: authorization.from,
                to: authorization.to,
                value: authorization.value,
                validAfter: authorization.validAfter,
                validBefore: authorization.validBefore,
                nonce: authorization.nonce,
                v: v,
                r: r,
                s: s
            }) {}
            catch (bytes memory vrsReason) {
                _revertWithReason(vrsReason.length == 0 ? bytesReason : vrsReason);
            }
        }
    }

    /// @dev Splits an `r || s || v` ECDSA signature and accepts either `0/1` or `27/28` for `v`.
    function _splitSignature(
        bytes calldata signature
    ) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        r = bytes32(signature[:32]);
        s = bytes32(signature[32:64]);
        v = uint8(signature[64]);
        if (v < 27) v += 27;
    }

    /// @dev Reverts with the original token return data without adding a proxy error to the ABI.
    function _revertWithReason(
        bytes memory reason
    ) private pure {
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}
