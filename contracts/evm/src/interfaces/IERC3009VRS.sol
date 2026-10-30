// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IERC3009VRS
/// @notice ERC-3009 authorization receipt using the normative split-signature interface.
interface IERC3009VRS {
    /// @notice Transfers an authorized amount to the caller, which must equal `to`.
    ///
    /// @param from Token owner that signed the authorization.
    /// @param to Authorization recipient and required caller.
    /// @param value Authorized transfer amount.
    /// @param validAfter Earliest valid timestamp, exclusive.
    /// @param validBefore Latest valid timestamp, exclusive.
    /// @param nonce Unique authorization nonce.
    /// @param v ECDSA recovery identifier.
    /// @param r ECDSA signature `r`.
    /// @param s ECDSA signature `s`.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
