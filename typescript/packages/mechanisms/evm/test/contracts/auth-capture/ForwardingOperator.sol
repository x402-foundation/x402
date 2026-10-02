// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ForwardingOperator
/// @notice Integration-test only. Not audited. Do not use in production.
/// @dev Spec-minimum custom operator: permissionless collect wrappers that
///      forward 1:1 to AuthCaptureEscrow. Bytecode artifact: `artifacts/ForwardingOperator.json`.
///      Regenerate: `forge build` in this directory, then copy `out/ForwardingOperator.sol/ForwardingOperator.json`
///      `abi` and `bytecode.object` into the artifact.
interface IAuthCaptureEscrow {
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
    PaymentInfo calldata paymentInfo,
    uint256 amount,
    address tokenCollector,
    bytes calldata collectorData
  ) external;

  function charge(
    PaymentInfo calldata paymentInfo,
    uint256 amount,
    address tokenCollector,
    bytes calldata collectorData,
    uint16 feeBps,
    address feeReceiver
  ) external;
}

contract ForwardingOperator {
  IAuthCaptureEscrow public immutable escrow;

  constructor(address escrow_) {
    escrow = IAuthCaptureEscrow(escrow_);
  }

  function authorize(
    IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
    uint256 amount,
    address tokenCollector,
    bytes calldata collectorData
  ) external {
    escrow.authorize(paymentInfo, amount, tokenCollector, collectorData);
  }

  function charge(
    IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
    uint256 amount,
    address tokenCollector,
    bytes calldata collectorData,
    uint16 feeBps,
    address feeReceiver
  ) external {
    escrow.charge(paymentInfo, amount, tokenCollector, collectorData, feeBps, feeReceiver);
  }
}
