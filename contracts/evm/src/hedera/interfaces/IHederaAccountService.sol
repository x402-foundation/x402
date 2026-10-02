// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IHederaAccountService
/// @notice Minimal subset of the Hedera Account Service (HAS) system contract (HIP-632) used by x402.
///
/// @dev The system contract lives at `address(0x16a)` on every Hedera network. Only `isAuthorizedRaw` is
///      required: it validates a raw signature produced by the single primitive key (ED25519 or ECDSA
///      secp256k1) of a Hedera account, resolving the account from its EVM address (long-zero or alias).
interface IHederaAccountService {
    /// @notice Determines if `signature` is a valid signature over `messageHash` for `account`.
    ///
    /// @dev ECDSA secp256k1 signatures are 65 bytes (`r || s || v`) and `messageHash` must be the 32-byte
    ///      keccak-256 digest. ED25519 signatures are 64 bytes and `messageHash` is the exact byte string that
    ///      was signed (x402 always passes a 32-byte EIP-712 digest). Reverts on key-type mismatch.
    ///
    /// @param account The Hedera account EVM address to check the signature against.
    /// @param messageHash The bytes the signature covers.
    /// @param signature The raw signature blob.
    /// @return authorized True if the signature is valid for the account's key.
    function isAuthorizedRaw(
        address account,
        bytes memory messageHash,
        bytes memory signature
    ) external returns (bool authorized);
}
