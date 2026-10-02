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
    type: "function",
    name: "associateToken",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "TokenAssociated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "responseCode", type: "int64", indexed: false },
    ],
    anonymous: false,
  },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "InvalidChannel", inputs: [] },
  { type: "error", name: "InvalidCollector", inputs: [] },
  { type: "error", name: "ZeroDeposit", inputs: [] },
  { type: "error", name: "DepositOverflow", inputs: [] },
  { type: "error", name: "DepositCollectionFailed", inputs: [] },
  { type: "error", name: "WithdrawDelayOutOfRange", inputs: [] },
  { type: "error", name: "EmptyBatch", inputs: [] },
  { type: "error", name: "NotReceiverAuthorizer", inputs: [] },
  { type: "error", name: "NotAuthorizedToClaim", inputs: [] },
  { type: "error", name: "NotAuthorizedToRefund", inputs: [] },
  { type: "error", name: "ClaimExceedsCeiling", inputs: [] },
  { type: "error", name: "ClaimExceedsBalance", inputs: [] },
  { type: "error", name: "InvalidRefundNonce", inputs: [] },
  { type: "error", name: "ZeroRefund", inputs: [] },
  {
    type: "error",
    name: "TokenAssociationFailed",
    inputs: [{ name: "responseCode", type: "int64" }],
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

/** `HederaAllowanceDepositCollector` ABI subset used by the client and facilitator. */
export const hederaAllowanceDepositCollectorABI = [
  {
    type: "function",
    name: "usedNonces",
    inputs: [
      { name: "payer", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "used", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getDepositDigest",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "DEPOSIT_TYPEHASH",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "x402BatchSettlement",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  { type: "error", name: "DepositAuthorizationExpired", inputs: [] },
  { type: "error", name: "NonceAlreadyUsed", inputs: [] },
  { type: "error", name: "InvalidDepositSignature", inputs: [] },
  { type: "error", name: "HtsTransferFailed", inputs: [{ name: "responseCode", type: "int64" }] },
  { type: "error", name: "AmountExceedsInt64", inputs: [] },
  { type: "error", name: "OnlyX402BatchSettlement", inputs: [] },
] as const;

/** HTS token ERC-20 facade subset (`allowance` is also available through the facade). */
export const erc20AllowanceABI = [
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;
