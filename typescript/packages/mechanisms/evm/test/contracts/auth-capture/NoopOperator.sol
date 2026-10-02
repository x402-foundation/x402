// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title NoopOperator
/// @notice Integration-test only. Not audited. Do not use in production.
/// @dev Adversarial custom operator: matching collect selectors, empty body.
///      Verify should fail (success with no canonical escrow event).
///      Bytecode artifact: `artifacts/NoopOperator.json`.
///      Regenerate: `forge build` in this directory, then copy `out/NoopOperator.sol/NoopOperator.json`
///      `abi` and `bytecode.object` into the artifact.
contract NoopOperator {
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

    function authorize(
        PaymentInfo calldata,
        uint256,
        address,
        bytes calldata
    ) external {}

    function charge(
        PaymentInfo calldata,
        uint256,
        address,
        bytes calldata,
        uint16,
        address
    ) external {}
}
