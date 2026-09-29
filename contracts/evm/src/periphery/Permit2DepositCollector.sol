// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {DepositCollector} from "./DepositCollector.sol";
import {IDepositCollector} from "../interfaces/IDepositCollector.sol";
import {ISignatureTransfer} from "../interfaces/ISignatureTransfer.sol";

/// @title Permit2DepositCollector
/// @notice Collects deposits using Permit2 `permitWitnessTransferFrom` with a channel-bound witness.
///
/// @dev Tokens move directly from the payer to `x402BatchSettlement` through Permit2.
///      `collectorData` is `abi.encode(nonce, deadline, permit2Signature, eip2612PermitData)`.
///      The token and amount on the `collect` call must match the signed Permit2 transfer.
///      If `eip2612PermitData` is empty, no EIP-2612 `permit` is attempted. If non-empty, it must be
///      `abi.encode(value, permitDeadline, v, r, s)` and `IERC20Permit.permit(owner, Permit2, ...)` runs
///      before the Permit2 transfer (failures are logged, then execution continues).
///
/// @author Coinbase
contract Permit2DepositCollector is DepositCollector {
    /// @notice Uniswap Permit2 `SignatureTransfer` singleton used for witness transfers.
    ISignatureTransfer public immutable PERMIT2;

    /// @notice String passed to Permit2 for EIP-712 witness typing of `DepositWitness`.
    ///
    /// @dev Referenced struct definitions must follow EIP-712 `encodeType`: alphabetically by struct name
    ///      (`DepositWitness` before `TokenPermissions`). Matches wallets that reconstruct the stub via sorted types.
    string public constant DEPOSIT_WITNESS_TYPE_STRING =
        "DepositWitness witness)DepositWitness(bytes32 channelId)TokenPermissions(address token,uint256 amount)";

    /// @notice Typehash for the `DepositWitness` struct bound to each transfer.
    bytes32 public constant DEPOSIT_WITNESS_TYPEHASH = keccak256("DepositWitness(bytes32 channelId)");

    /// @notice Thrown when `_permit2` in the constructor is the zero address.
    error InvalidPermit2Address();

    /// @notice Thrown when optional EIP-2612 `permit` `value` does not match `collect` `amount`.
    error Permit2612AmountMismatch();

    /// @notice Logged when an optional EIP-2612 `permit` reverts with a string reason.
    ///
    /// @param token The ERC-20 `permit` was called on.
    /// @param owner The owner passed to `permit`.
    /// @param reason The revert string from the token.
    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);

    /// @notice Logged when an optional EIP-2612 `permit` reverts with a panic code.
    ///
    /// @param token The ERC-20 `permit` was called on.
    /// @param owner The owner passed to `permit`.
    /// @param errorCode The panic code.
    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);

    /// @notice Logged when an optional EIP-2612 `permit` reverts with arbitrary data.
    ///
    /// @param token The ERC-20 `permit` was called on.
    /// @param owner The owner passed to `permit`.
    /// @param data Low-level revert data.
    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    /// @param _x402BatchSettlement The `x402BatchSettlement` contract that receives Permit2 transfers.
    /// @param _permit2 The canonical Permit2 `SignatureTransfer` contract.
    constructor(address _x402BatchSettlement, address _permit2) DepositCollector(_x402BatchSettlement) {
        if (_permit2 == address(0)) revert InvalidPermit2Address();
        PERMIT2 = ISignatureTransfer(_permit2);
    }

    /// @inheritdoc IDepositCollector
    ///
    /// @param payer The owner of the Permit2 transfer.
    /// @param token The ERC-20 being transferred.
    /// @param amount The amount; must match the signed Permit2 permit and optional EIP-2612 segment.
    /// @param channelId Bound into the Permit2 witness for this deposit.
    /// @param collectorData `abi.encode(nonce, deadline, permit2Signature, eip2612PermitData)`.
    function collect(
        address payer,
        address token,
        uint256 amount,
        bytes32 channelId,
        bytes calldata collectorData
    ) external override onlyx402BatchSettlement {
        (uint256 nonce, uint256 deadline, bytes memory permit2Signature, bytes memory eip2612PermitData) =
            abi.decode(collectorData, (uint256, uint256, bytes, bytes));

        if (eip2612PermitData.length > 0) {
            _tryEip2612Permit(payer, token, amount, eip2612PermitData);
        }

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
            nonce: nonce,
            deadline: deadline
        });

        _executePermit2Transfer(payer, amount, channelId, permit, permit2Signature);
    }

    /// @dev Performs `permitWitnessTransferFrom` to pull from `payer` into `x402BatchSettlement` with `channelId` in the witness.
    function _executePermit2Transfer(
        address payer,
        uint256 amount,
        bytes32 channelId,
        ISignatureTransfer.PermitTransferFrom memory permit,
        bytes memory signature
    ) internal {
        bytes32 witnessHash = keccak256(abi.encode(DEPOSIT_WITNESS_TYPEHASH, channelId));

        PERMIT2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: x402BatchSettlement, requestedAmount: amount}),
            payer,
            witnessHash,
            DEPOSIT_WITNESS_TYPE_STRING,
            signature
        );
    }

    /// @dev Best-effort EIP-2612 `permit` helper; failures emit one of the `EIP2612PermitFailed*` events.
    function _tryEip2612Permit(address payer, address token, uint256 amount, bytes memory eip2612PermitData) private {
        (uint256 permitValue, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) =
            abi.decode(eip2612PermitData, (uint256, uint256, uint8, bytes32, bytes32));
        if (permitValue != amount) revert Permit2612AmountMismatch();

        try IERC20Permit(token).permit(payer, address(PERMIT2), permitValue, permitDeadline, v, r, s) {}
        catch Error(string memory reason) {
            emit EIP2612PermitFailedWithReason(token, payer, reason);
        } catch Panic(uint256 code) {
            emit EIP2612PermitFailedWithPanic(token, payer, code);
        } catch (bytes memory lowLevelData) {
            emit EIP2612PermitFailedWithData(token, payer, lowLevelData);
        }
    }
}
