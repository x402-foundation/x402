/**
 * ABI of the x402SwapSettler reference contract (contracts/evm/src/x402SwapSettler.sol).
 *
 * Unlike scheme-internal ABIs, this one is exported: facilitator implementations live
 * outside this package and encode settlement calls against it instead of hand-writing
 * the tuple layouts. The Quote struct field order is spec-normative
 * (specs/extensions/swap_settlement.md, "Reference Implementation").
 */

export const quoteComponents = [
  { name: "quoteIdHash", type: "bytes32" },
  { name: "requirementsHash", type: "bytes32" },
  { name: "payer", type: "address" },
  { name: "inputAsset", type: "address" },
  { name: "maxAmountIn", type: "uint256" },
  { name: "facilitatorFee", type: "uint256" },
  { name: "outputAsset", type: "address" },
  { name: "outputAmount", type: "uint256" },
  { name: "payTo", type: "address" },
  { name: "swapTarget", type: "address" },
  { name: "deadline", type: "uint256" },
] as const;

const permit2AuthComponents = [
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "signature", type: "bytes" },
] as const;

export const swapSettlerABI = [
  {
    type: "function",
    name: "settleWith3009",
    stateMutability: "nonpayable",
    inputs: [
      { name: "q", type: "tuple", components: quoteComponents },
      {
        name: "a",
        type: "tuple",
        components: [
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "routeData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleWithPermit2",
    stateMutability: "nonpayable",
    inputs: [
      { name: "q", type: "tuple", components: quoteComponents },
      { name: "a", type: "tuple", components: permit2AuthComponents },
      { name: "routeData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleWith2612",
    stateMutability: "nonpayable",
    inputs: [
      { name: "q", type: "tuple", components: quoteComponents },
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "value", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "r", type: "bytes32" },
          { name: "s", type: "bytes32" },
          { name: "v", type: "uint8" },
        ],
      },
      { name: "a", type: "tuple", components: permit2AuthComponents },
      { name: "routeData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "settleWithAllowance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "q", type: "tuple", components: quoteComponents },
      {
        name: "a",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
      { name: "routeData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "facilitators",
    stateMutability: "view",
    inputs: [{ name: "facilitator", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "swapTargets",
    stateMutability: "view",
    inputs: [{ name: "target", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "consumedQuotes",
    stateMutability: "view",
    inputs: [{ name: "quoteIdHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "setFacilitator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "facilitator", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setSwapTarget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "SwapSettled",
    inputs: [
      { name: "quoteIdHash", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "inputAsset", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "outputAsset", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "payTo", type: "address", indexed: false },
      { name: "facilitatorFee", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "NotFacilitator", inputs: [] },
  { type: "error", name: "QuoteConsumed", inputs: [] },
  { type: "error", name: "QuoteDeadlineExpired", inputs: [] },
  { type: "error", name: "SwapTargetNotAllowed", inputs: [{ name: "target", type: "address" }] },
  { type: "error", name: "InvalidQuote", inputs: [] },
  { type: "error", name: "SwapCallFailed", inputs: [{ name: "returnData", type: "bytes" }] },
  {
    type: "error",
    name: "InsufficientOutput",
    inputs: [
      { name: "received", type: "uint256" },
      { name: "required", type: "uint256" },
    ],
  },
  { type: "error", name: "PermitValueTooLow", inputs: [] },
  { type: "error", name: "InvalidIntentSignature", inputs: [] },
  { type: "error", name: "IntentDeadlineExpired", inputs: [] },
] as const;
