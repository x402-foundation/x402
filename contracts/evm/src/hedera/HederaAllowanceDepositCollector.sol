// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DepositCollector} from "../periphery/DepositCollector.sol";
import {IDepositCollector} from "../interfaces/IDepositCollector.sol";
import {HederaSystemContracts} from "./HederaSystemContracts.sol";

/// @title HederaAllowanceDepositCollector
/// @notice Collects `x402BatchSettlementHedera` deposits by pulling HTS tokens through an HTS allowance that the
///         payer granted to this collector, authorized per deposit by a raw Hedera account signature.
///
/// @dev The payer grants a fungible-token allowance to this contract once (`AccountAllowanceApproveTransaction`,
///      signed natively with any Hedera key type). Each deposit then carries `collectorData =
///      abi.encode(uint256 nonce, uint256 deadline, bytes signature)` where `signature` is the payer's raw
///      ED25519/ECDSA signature over `getDepositDigest(channelId, token, amount, nonce, deadline)`. The digest binds
///      the channel id, so an allowance can never be pulled into a channel the payer did not authorize. The
///      signature is validated through the Hedera Account Service (HIP-632 `isAuthorizedRaw`) and tokens move
///      directly from the payer to `x402BatchSettlement` via the HTS system contract `transferFrom` (HIP-906).
///
///      HTS amounts are `int64`; deposits above `type(int64).max` are rejected.
///
/// @author x402 Foundation
contract HederaAllowanceDepositCollector is DepositCollector {
    /// @notice Type hash for the deposit authorization digest (plain `abi.encode`, not EIP-712).
    bytes32 public constant DEPOSIT_TYPEHASH = keccak256(
        "HederaAllowanceDeposit(bytes32 channelId,address token,uint256 amount,uint256 nonce,uint256 deadline,address collector,uint256 chainId)"
    );

    /// @notice Nonces already consumed per payer; a used nonce can never authorize another deposit.
    mapping(address payer => mapping(uint256 nonce => bool used)) public usedNonces;

    /// @notice Thrown when `deadline` is in the past.
    error DepositAuthorizationExpired();

    /// @notice Thrown when the payer already used `nonce`.
    error NonceAlreadyUsed();

    /// @notice Thrown when HAS rejects the deposit authorization signature.
    error InvalidDepositSignature();

    /// @notice Thrown when the HTS transfer fails with a non-SUCCESS response code.
    error HtsTransferFailed(int64 responseCode);

    /// @notice Thrown when `amount` does not fit the HTS `int64` range.
    error AmountExceedsInt64();

    /// @notice Emitted after a successful pull.
    event DepositCollected(address indexed payer, address indexed token, bytes32 indexed channelId, uint256 amount, uint256 nonce);

    /// @param _x402BatchSettlement The `x402BatchSettlementHedera` contract that receives pulled tokens.
    constructor(address _x402BatchSettlement) DepositCollector(_x402BatchSettlement) {}

    /// @inheritdoc IDepositCollector
    ///
    /// @param payer The Hedera account (EVM address) that granted the HTS allowance and signed the authorization.
    /// @param token The HTS token EVM address.
    /// @param amount The exact amount to pull; must match the signed digest.
    /// @param channelId Bound into the signed digest for this deposit.
    /// @param collectorData `abi.encode(nonce, deadline, signature)`.
    function collect(
        address payer,
        address token,
        uint256 amount,
        bytes32 channelId,
        bytes calldata collectorData
    ) external override onlyx402BatchSettlement {
        (uint256 nonce, uint256 deadline, bytes memory signature) =
            abi.decode(collectorData, (uint256, uint256, bytes));

        if (block.timestamp > deadline) revert DepositAuthorizationExpired();
        if (amount > uint256(uint64(type(int64).max))) revert AmountExceedsInt64();
        if (usedNonces[payer][nonce]) revert NonceAlreadyUsed();
        usedNonces[payer][nonce] = true;

        bytes32 digest = getDepositDigest(channelId, token, amount, nonce, deadline);
        if (!HederaSystemContracts.isAuthorizedRaw(payer, digest, signature)) revert InvalidDepositSignature();

        int64 rc = HederaSystemContracts.transferFrom(token, payer, x402BatchSettlement, amount);
        if (rc != HederaSystemContracts.SUCCESS) revert HtsTransferFailed(rc);

        emit DepositCollected(payer, token, channelId, amount, nonce);
    }

    /// @notice Digest the payer signs to authorize one deposit through this collector on this chain.
    ///
    /// @param channelId The channel receiving the deposit.
    /// @param token The HTS token EVM address.
    /// @param amount The deposit amount.
    /// @param nonce Payer-chosen unique nonce.
    /// @param deadline Unix timestamp after which the authorization is invalid.
    /// @return The 32-byte digest (`keccak256(abi.encode(DEPOSIT_TYPEHASH, ..., address(this), block.chainid))`).
    function getDepositDigest(
        bytes32 channelId,
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return keccak256(abi.encode(DEPOSIT_TYPEHASH, channelId, token, amount, nonce, deadline, address(this), block.chainid));
    }
}
