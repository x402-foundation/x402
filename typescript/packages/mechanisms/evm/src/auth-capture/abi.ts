// PaymentInfo struct for AuthCaptureEscrow (matches base/commerce-payments contract).
// Field names are canonical Solidity — do not rename. Spec-level field renames
// (captureAuthorizer, captureDeadline, refundDeadline, feeRecipient) live at the
// extra/wire layer; this struct preserves the canonical EIP-712 typehash.
export const PAYMENT_INFO_COMPONENTS = [
  { name: "operator", type: "address" },
  { name: "payer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "token", type: "address" },
  { name: "maxAmount", type: "uint120" },
  { name: "preApprovalExpiry", type: "uint48" },
  { name: "authorizationExpiry", type: "uint48" },
  { name: "refundExpiry", type: "uint48" },
  { name: "minFeeBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" },
  { name: "feeReceiver", type: "address" },
  { name: "salt", type: "uint256" },
] as const;

export const ESCROW_ABI = [
  {
    name: "authorize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: PAYMENT_INFO_COMPONENTS,
      },
      { name: "amount", type: "uint256" },
      { name: "tokenCollector", type: "address" },
      { name: "collectorData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "charge",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: PAYMENT_INFO_COMPONENTS,
      },
      { name: "amount", type: "uint256" },
      { name: "tokenCollector", type: "address" },
      { name: "collectorData", type: "bytes" },
      { name: "feeBps", type: "uint16" },
      { name: "feeReceiver", type: "address" },
    ],
    outputs: [],
  },
] as const;

// ERC-20 balanceOf ABI for balance checks
export const ERC20_BALANCE_OF_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

// View functions on AuthCaptureEscrow used by tests / introspection. Not part
// of ESCROW_ABI because settle/simulate paths only need authorize + charge.
export const ESCROW_VIEW_ABI = [
  {
    name: "getHash",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: PAYMENT_INFO_COMPONENTS,
      },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "paymentState",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "paymentInfoHash", type: "bytes32" }],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: [
          { name: "hasCollectedPayment", type: "bool" },
          { name: "capturableAmount", type: "uint120" },
          { name: "refundableAmount", type: "uint120" },
        ],
      },
    ],
  },
] as const;

// AuthCaptureEscrow custom errors. Spliced into the ABI passed to simulateContract
// so viem can decode `ContractFunctionRevertedError.data.errorName` instead of
// falling back to an opaque hex selector. Names mirror the Solidity definitions
// at base/commerce-payments/src/AuthCaptureEscrow.sol.
export const ESCROW_ERRORS_ABI = [
  { type: "error", name: "InvalidSender", inputs: [{ type: "address" }, { type: "address" }] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "AmountOverflow", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "ExceedsMaxAmount", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  {
    type: "error",
    name: "AfterPreApprovalExpiry",
    inputs: [{ type: "uint48" }, { type: "uint48" }],
  },
  {
    type: "error",
    name: "InvalidExpiries",
    inputs: [{ type: "uint48" }, { type: "uint48" }, { type: "uint48" }],
  },
  { type: "error", name: "FeeBpsOverflow", inputs: [{ type: "uint16" }] },
  { type: "error", name: "InvalidFeeBpsRange", inputs: [{ type: "uint16" }, { type: "uint16" }] },
  {
    type: "error",
    name: "FeeBpsOutOfRange",
    inputs: [{ type: "uint16" }, { type: "uint16" }, { type: "uint16" }],
  },
  { type: "error", name: "ZeroFeeReceiver", inputs: [] },
  { type: "error", name: "InvalidFeeReceiver", inputs: [{ type: "address" }, { type: "address" }] },
  { type: "error", name: "InvalidCollectorForOperation", inputs: [] },
  { type: "error", name: "TokenCollectionFailed", inputs: [] },
  { type: "error", name: "PaymentAlreadyCollected", inputs: [{ type: "bytes32" }] },
  {
    type: "error",
    name: "AfterAuthorizationExpiry",
    inputs: [{ type: "uint48" }, { type: "uint48" }],
  },
  {
    type: "error",
    name: "InsufficientAuthorization",
    inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
  },
  { type: "error", name: "ZeroAuthorization", inputs: [{ type: "bytes32" }] },
] as const;
