// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DepositCollector} from "./DepositCollector.sol";
import {IDepositCollector} from "../interfaces/IDepositCollector.sol";
import {IERC3009} from "../interfaces/IERC3009.sol";

/// @title ERC3009DepositCollector
/// @notice Collects deposits via ERC-3009 `receiveWithAuthorization` for gasless pulls into escrow.
///
/// @dev ERC-3009 requires `msg.sender == to`, so tokens arrive at this contract and are forwarded to
///      `x402BatchSettlement`. The authorization nonce is `keccak256(abi.encode(channelId, salt))` where `salt`
///      is supplied in `collectorData`.
///
/// @author Coinbase
contract ERC3009DepositCollector is DepositCollector {
    using SafeERC20 for IERC20;

    /// @param _x402BatchSettlement The `x402BatchSettlement` contract that receives pulled tokens.
    constructor(
        address _x402BatchSettlement
    ) DepositCollector(_x402BatchSettlement) {}

    /// @inheritdoc IDepositCollector
    ///
    /// @param payer The token owner authorizing the transfer.
    /// @param token The ERC-20 implementing ERC-3009.
    /// @param amount The amount to collect.
    /// @param channelId The channel identifier (hashed into the ERC-3009 nonce).
    /// @param collectorData `abi.encode(validAfter, validBefore, salt, signature)` for `receiveWithAuthorization`.
    function collect(
        address payer,
        address token,
        uint256 amount,
        bytes32 channelId,
        bytes calldata collectorData
    ) external override onlyx402BatchSettlement {
        (uint256 validAfter, uint256 validBefore, uint256 salt, bytes memory signature) =
            abi.decode(collectorData, (uint256, uint256, uint256, bytes));

        bytes32 expectedNonce = keccak256(abi.encode(channelId, salt));

        IERC3009(token).receiveWithAuthorization(
            payer, address(this), amount, validAfter, validBefore, expectedNonce, signature
        );

        IERC20(token).safeTransfer(x402BatchSettlement, amount);
    }
}
