// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IHederaAccountService} from "./interfaces/IHederaAccountService.sol";
import {IHederaTokenService} from "./interfaces/IHederaTokenService.sol";

/// @title HederaSystemContracts
/// @notice Addresses, response codes, and safe wrappers for the Hedera system contracts used by x402.
///
/// @dev `isAuthorizedRaw` on the Hedera Account Service reverts (instead of returning `false`) when the
///      signature length does not match the account's key type, and would revert for other malformed inputs.
///      The wrapper below performs a low-level call and maps *any* failure to `false`, so a bad signature can
///      never bypass a check and callers can uniformly `revert InvalidSignature()`.
library HederaSystemContracts {
    /// @notice Hedera Account Service (HAS, HIP-632) system contract address.
    address internal constant HAS = address(0x16a);

    /// @notice Hedera Token Service (HTS) system contract address.
    address internal constant HTS = address(0x167);

    /// @notice `HederaResponseCodes.SUCCESS`.
    int64 internal constant SUCCESS = 22;

    /// @notice `HederaResponseCodes.TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT`.
    int64 internal constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    /// @dev Returns true iff HAS confirms `signature` is a valid raw signature over `digest` for `account`.
    ///      Any revert or malformed return from the system contract is treated as `false`.
    function isAuthorizedRaw(address account, bytes32 digest, bytes memory signature) internal returns (bool) {
        (bool ok, bytes memory ret) = HAS.call(
            abi.encodeCall(IHederaAccountService.isAuthorizedRaw, (account, abi.encodePacked(digest), signature))
        );
        if (!ok || ret.length < 32) return false;
        return abi.decode(ret, (bool));
    }

    /// @dev Associates the calling contract with `token`. Returns the HTS response code.
    function associateSelf(address token) internal returns (int64) {
        return IHederaTokenService(HTS).associateToken(address(this), token);
    }

    /// @dev Pulls `amount` of `token` from `from` to `to` using the allowance `from` granted to the caller.
    function transferFrom(address token, address from, address to, uint256 amount) internal returns (int64) {
        return IHederaTokenService(HTS).transferFrom(token, from, to, amount);
    }
}
