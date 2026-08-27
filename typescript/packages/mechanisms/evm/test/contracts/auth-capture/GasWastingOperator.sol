// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GasWastingOperator
/// @notice Integration-test only. Not audited. Do not use in production.
/// @dev Adversarial custom operator: burns well over the facilitator collect
///      gas cap, then returns without calling escrow.
///      Bytecode artifact: `artifacts/GasWastingOperator.json`.
///      Regenerate: `forge build` in this directory, then copy `out/GasWastingOperator.sol/GasWastingOperator.json`
///      `abi` and `bytecode.object` into the artifact.
contract GasWastingOperator {
    struct PaymentInfo {
        address operator;
        address payer;
        address receiver;
        address token;
        uint120 maxAmount;
        uint48 preApprovalExpiry;
        uint48 authorizationExpiry;
        uint48 refundExpiry;
        uint16 minFeeBps;
        uint16 maxFeeBps;
        address feeReceiver;
        uint256 salt;
    }

    /// @dev Storage sink so the optimizer cannot drop the burn loop.
    uint256 public sink;

    function authorize(
        PaymentInfo calldata,
        uint256,
        address,
        bytes calldata
    ) external {
        _waste();
    }

    function charge(
        PaymentInfo calldata,
        uint256,
        address,
        bytes calldata,
        uint16,
        address
    ) external {
        _waste();
    }

    function _waste() private {
        uint256 n = sink;
        // Far above DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT (1_000_000).
        unchecked {
            for (uint256 i; i < 50_000; ++i) {
                n = uint256(keccak256(abi.encode(n, i)));
            }
        }
        sink = n;
    }
}
