// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IERC3009
 * @notice Minimal interface for EIP-3009 transferWithAuthorization / receiveWithAuthorization
 * @dev Used by tokens like USDC that support gasless transfers via signed authorizations.
 *      See https://eips.ethereum.org/EIPS/eip-3009
 */
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}
