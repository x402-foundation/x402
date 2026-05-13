import { keccak256, toBytes } from "viem";

/** Scheme identifier for the batch-settlement payment scheme. */
export const BATCH_SETTLEMENT_SCHEME = "batch-settlement" as const;

/** Deployed address of the x402BatchSettlement contract. */
export const BATCH_SETTLEMENT_ADDRESS = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003" as const;

/** Deployed address of the ERC3009DepositCollector contract. */
export const ERC3009_DEPOSIT_COLLECTOR_ADDRESS =
  "0x4020806089470a89826cB9fB1f4059150b550004" as const;

/** Deployed address of the Permit2DepositCollector contract. */
export const PERMIT2_DEPOSIT_COLLECTOR_ADDRESS =
  "0x4020425FAf3B746C082C2f942b4E5159887B0005" as const;

/** Minimum withdraw delay in seconds (15 minutes), matching the onchain constant. */
export const MIN_WITHDRAW_DELAY = 900;

/** Maximum withdraw delay in seconds (30 days), matching the onchain constant. */
export const MAX_WITHDRAW_DELAY = 2_592_000;

/** EIP-712 domain fields shared across all batch-settlement typed-data signatures. */
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

/** EIP-712 type definition for ERC-3009 `ReceiveWithAuthorization` (used for gasless deposits). */
export const receiveAuthorizationTypes = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Permit2 typed data for channel-bound batch deposits. */
export const batchPermit2WitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "DepositWitness" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  DepositWitness: [{ name: "channelId", type: "bytes32" }],
} as const;
