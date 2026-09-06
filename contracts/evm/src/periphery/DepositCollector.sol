// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IDepositCollector} from "../interfaces/IDepositCollector.sol";

/// @title DepositCollector
/// @notice Abstract base for deposit collectors bound to a single `x402BatchSettlement` deployment.
///
/// @dev All collectors must inherit this so only `x402BatchSettlement` can call `collect`,
///      mitigating frontrunning and theft of user funds.
///
/// @author Coinbase
abstract contract DepositCollector is IDepositCollector {
    /// @notice The `x402BatchSettlement` deployment that may invoke `collect` on this collector.
    address public immutable x402BatchSettlement;

    /// @notice Thrown when `collect` is called by any address other than `x402BatchSettlement`.
    error OnlyX402BatchSettlement();

    /// @notice Thrown when the `x402BatchSettlement` address passed to the constructor is zero.
    error InvalidX402BatchSettlementAddress();

    /// @param _x402BatchSettlement The `x402BatchSettlement` instance this collector serves.
    constructor(
        address _x402BatchSettlement
    ) {
        if (_x402BatchSettlement == address(0)) revert InvalidX402BatchSettlementAddress();
        x402BatchSettlement = _x402BatchSettlement;
    }

    /// @dev Restricts the function body to calls originating from `x402BatchSettlement`.
    modifier onlyx402BatchSettlement() {
        if (msg.sender != x402BatchSettlement) revert OnlyX402BatchSettlement();
        _;
    }
}
