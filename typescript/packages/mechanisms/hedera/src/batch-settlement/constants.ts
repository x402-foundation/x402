import { keccak256, toBytes } from "viem";
import { HEDERA_MAINNET_CAIP2, HEDERA_TESTNET_CAIP2 } from "../constants";

/** Scheme identifier for the batch-settlement payment scheme. */
export const BATCH_SETTLEMENT_SCHEME = "batch-settlement" as const;

/** The only asset transfer method on Hedera: HTS allowance + signed deposit authorization. */
export const HTS_ALLOWANCE_TRANSFER_METHOD = "hts-allowance" as const;

/** EVM chain ids Hedera reports via `block.chainid`, keyed by CAIP-2 network. */
export const HEDERA_CHAIN_IDS: Readonly<Record<string, number>> = {
  [HEDERA_MAINNET_CAIP2]: 295,
  [HEDERA_TESTNET_CAIP2]: 296,
};

/** Hedera Account Service (HIP-632) system contract address. */
export const HEDERA_ACCOUNT_SERVICE_ADDRESS = "0x000000000000000000000000000000000000016a" as const;

/** Hedera Token Service system contract address. */
export const HEDERA_TOKEN_SERVICE_ADDRESS = "0x0000000000000000000000000000000000000167" as const;

/** Largest amount representable by HTS (`int64`). */
export const HTS_INT64_MAX = 2n ** 63n - 1n;

/** Deployed `x402BatchSettlementHedera` + `HederaAllowanceDepositCollector` pair for one network. */
export type BatchSettlementDeployment = {
  /** Escrow contract EVM address (long-zero form of `settlementId`). */
  settlement: `0x${string}`;
  /** Escrow contract Hedera entity id (`0.0.x`). */
  settlementId: string;
  /** Deposit collector EVM address (long-zero form of `collectorId`). */
  collector: `0x${string}`;
  /** Deposit collector Hedera entity id (`0.0.x`); the HTS allowance spender. */
  collectorId: string;
};

const deployments: Record<string, BatchSettlementDeployment | undefined> = {
  // Deployed 2026-09-10 with scripts/deploy-batch-settlement.ts (operator 0.0.10463136).
  [HEDERA_TESTNET_CAIP2]: {
    settlement: "0x00000000000000000000000000000000009FaA67",
    settlementId: "0.0.10463847",
    collector: "0x00000000000000000000000000000000009FAA6B",
    collectorId: "0.0.10463851",
  },
  [HEDERA_MAINNET_CAIP2]: undefined,
};

/** Known deployments by CAIP-2 network (read-only view; use {@link registerBatchSettlementDeployment} to add). */
export const BATCH_SETTLEMENT_DEPLOYMENTS: Readonly<
  Record<string, BatchSettlementDeployment | undefined>
> = deployments;

/**
 * Registers (or overrides) the contract deployment used for a network.
 *
 * @param network - CAIP-2 Hedera network (`hedera:testnet` / `hedera:mainnet`).
 * @param deployment - Escrow + collector addresses/ids.
 */
export function registerBatchSettlementDeployment(
  network: string,
  deployment: BatchSettlementDeployment,
): void {
  deployments[network] = deployment;
}

/**
 * Resolves the deployment for a network, throwing when none is configured.
 *
 * @param network - CAIP-2 Hedera network.
 * @returns The deployment record.
 */
export function getBatchSettlementDeployment(network: string): BatchSettlementDeployment {
  const deployment = deployments[network];
  if (!deployment) {
    throw new Error(
      `No batch-settlement deployment configured for ${network}; call registerBatchSettlementDeployment()`,
    );
  }
  return deployment;
}

/**
 * Explicit gas limits for facilitator-submitted contract calls. Hedera system-contract calls
 * (HAS signature checks, HTS transfers) cost more than plain EVM ops and `eth_estimateGas` is
 * unavailable on the HAPI path, so fixed limits are used; unspent gas is refunded.
 */
export const HEDERA_GAS = {
  deposit: 1_500_000n,
  claimBase: 400_000n,
  claimPerVoucher: 250_000n,
  settle: 600_000n,
  refund: 1_200_000n,
  associate: 900_000n,
} as const;

/** Mirror Node ingestion lags consensus by a few seconds; post-write polling bounds. */
export const CHANNEL_STATE_POLL_MS = 10_000;
export const CHANNEL_STATE_POLL_INTERVAL_MS = 500;

/** Default server SDK multiplier for `extra.minDeposit` when no floor is configured. */
export const DEFAULT_SERVER_MIN_DEPOSIT_MULTIPLIER = 10;

/** Minimum withdraw delay in seconds (15 minutes), matching the onchain constant. */
export const MIN_WITHDRAW_DELAY = 900;

/** Maximum withdraw delay in seconds (30 days), matching the onchain constant. */
export const MAX_WITHDRAW_DELAY = 2_592_000;

/** EIP-712 domain fields shared across all batch-settlement typed-data digests (same as EVM). */
export const BATCH_SETTLEMENT_DOMAIN = {
  name: "x402 Batch Settlement",
  version: "1",
} as const;

/** EIP-712 type hash for channel identity. */
export const CHANNEL_CONFIG_TYPEHASH = keccak256(
  toBytes(
    "ChannelConfig(address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)",
  ),
);

/** Type hash for the HTS-allowance deposit authorization digest (plain `abi.encode`, not EIP-712). */
export const HEDERA_ALLOWANCE_DEPOSIT_TYPEHASH = keccak256(
  toBytes(
    "HederaAllowanceDeposit(bytes32 channelId,address token,uint256 amount,uint256 nonce,uint256 deadline,address collector,uint256 chainId)",
  ),
);

/** EIP-712 type definition for a channel configuration. */
export const channelConfigTypes = {
  ChannelConfig: [
    { name: "payer", type: "address" },
    { name: "payerAuthorizer", type: "address" },
    { name: "receiver", type: "address" },
    { name: "receiverAuthorizer", type: "address" },
    { name: "token", type: "address" },
    { name: "withdrawDelay", type: "uint40" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

/** EIP-712 type definition for a cumulative voucher: `Voucher(bytes32 channelId, uint128 maxClaimableAmount)`. */
export const voucherTypes = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "maxClaimableAmount", type: "uint128" },
  ],
} as const;

/** EIP-712 type definition for cooperative refund: `Refund(bytes32 channelId, uint256 nonce, uint128 amount)`. */
export const refundTypes = {
  Refund: [
    { name: "channelId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "amount", type: "uint128" },
  ],
} as const;

/** EIP-712 type definitions for a receiver-authorizer claim batch (nested ClaimEntry). */
export const claimBatchTypes = {
  ClaimBatch: [{ name: "claims", type: "ClaimEntry[]" }],
  ClaimEntry: [
    { name: "channelId", type: "bytes32" },
    { name: "maxClaimableAmount", type: "uint128" },
    { name: "totalClaimed", type: "uint128" },
  ],
} as const;
