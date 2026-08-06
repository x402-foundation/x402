export const channelConfigComponents = [
  { name: "payer", type: "address" },
  { name: "payerAuthorizer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "receiverAuthorizer", type: "address" },
  { name: "token", type: "address" },
  { name: "withdrawDelay", type: "uint40" },
  { name: "salt", type: "bytes32" },
] as const;

const voucherClaimComponents = [
  {
    name: "voucher",
    type: "tuple",
    components: [
      {
        name: "channel",
        type: "tuple",
        components: channelConfigComponents,
      },
      { name: "maxClaimableAmount", type: "uint128" },
    ],
  },
  { name: "signature", type: "bytes" },
  { name: "totalClaimed", type: "uint128" },
] as const;

export const batchSettlementABI = [
  {
    type: "function",
    name: "multicall",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "config", type: "tuple", components: channelConfigComponents },
      { name: "amount", type: "uint128" },
      { name: "collector", type: "address" },
      { name: "collectorData", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claim",
    inputs: [{ name: "voucherClaims", type: "tuple[]", components: voucherClaimComponents }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimWithSignature",
    inputs: [
      { name: "voucherClaims", type: "tuple[]", components: voucherClaimComponents },
      { name: "authorizerSignature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "settle",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "initiateWithdraw",
    inputs: [
      { name: "config", type: "tuple", components: channelConfigComponents },
      { name: "amount", type: "uint128" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "finalizeWithdraw",
    inputs: [{ name: "config", type: "tuple", components: channelConfigComponents }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "refund",
    inputs: [
      { name: "config", type: "tuple", components: channelConfigComponents },
      { name: "amount", type: "uint128" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "refundWithSignature",
    inputs: [
      { name: "config", type: "tuple", components: channelConfigComponents },
      { name: "amount", type: "uint128" },
      { name: "nonce", type: "uint256" },
      { name: "receiverAuthorizerSignature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getChannelId",
    inputs: [{ name: "config", type: "tuple", components: channelConfigComponents }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "CHANNEL_CONFIG_TYPEHASH",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "channels",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      { name: "balance", type: "uint128" },
      { name: "totalClaimed", type: "uint128" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingWithdrawals",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      { name: "amount", type: "uint128" },
      { name: "initiatedAt", type: "uint40" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "receivers",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "totalClaimed", type: "uint128" },
      { name: "totalSettled", type: "uint128" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getVoucherDigest",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "maxClaimableAmount", type: "uint128" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getRefundDigest",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "amount", type: "uint128" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundNonce",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getClaimBatchDigest",
    inputs: [{ name: "voucherClaims", type: "tuple[]", components: voucherClaimComponents }],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Settled",
    inputs: [
      { name: "receiver", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
    ],
    anonymous: false,
  },
] as const;

export const erc20BalanceOfABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
