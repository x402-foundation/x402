// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IHederaTokenService
/// @notice Minimal subset of the Hedera Token Service (HTS) system contract used by x402.
///
/// @dev The system contract lives at `address(0x167)` on every Hedera network. Response codes follow
///      `HederaResponseCodes` (SUCCESS is 22, TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT is 194).
interface IHederaTokenService {
    /// @notice Associates `account` with `token` so the account can hold it. The calling contract may only
    ///         associate itself (`account == address(this)`) unless it holds the account's key.
    function associateToken(address account, address token) external returns (int64 responseCode);

    /// @notice Transfers `amount` of fungible `token` from `from` to `to` using the HTS allowance that `from`
    ///         granted to the calling contract (HIP-906 spender semantics; the caller is the spender).
    function transferFrom(address token, address from, address to, uint256 amount)
        external
        returns (int64 responseCode);

    /// @notice Returns the remaining fungible-token allowance `owner` granted to `spender`.
    function allowance(address token, address owner, address spender)
        external
        returns (int64 responseCode, uint256 allowance);
}
