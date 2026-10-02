import type { AuthCaptureDeployment, AuthCaptureDeploymentVersion } from "./constants";

// PaymentInfo struct for AuthCaptureEscrow (matches base/commerce-payments contract).
// Field names are canonical Solidity; do not rename. Spec-level field renames
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

const ESCROW_SHARED_ABI = [
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
    name: "void",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: PAYMENT_INFO_COMPONENTS,
      },
    ],
    outputs: [],
  },
  {
    name: "refund",
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
] as const;

const CHARGE_V1_0_ABI = {
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
} as const;

const CAPTURE_V1_0_ABI = {
  name: "capture",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "paymentInfo",
      type: "tuple",
      components: PAYMENT_INFO_COMPONENTS,
    },
    { name: "amount", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "feeReceiver", type: "address" },
  ],
  outputs: [],
} as const;

const CHARGE_V1_1_ABI = {
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
    { name: "feeAmount", type: "uint256" },
    { name: "feeReceiver", type: "address" },
  ],
  outputs: [],
} as const;

const CAPTURE_V1_1_ABI = {
  name: "capture",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "paymentInfo",
      type: "tuple",
      components: PAYMENT_INFO_COMPONENTS,
    },
    { name: "amount", type: "uint256" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeReceiver", type: "address" },
  ],
  outputs: [],
} as const;

export const ESCROW_ABI_V1_0 = [
  ...ESCROW_SHARED_ABI.slice(0, 1),
  CHARGE_V1_0_ABI,
  CAPTURE_V1_0_ABI,
  ...ESCROW_SHARED_ABI.slice(1),
] as const;

export const ESCROW_ABI_V1_1 = [
  ...ESCROW_SHARED_ABI.slice(0, 1),
  CHARGE_V1_1_ABI,
  CAPTURE_V1_1_ABI,
  ...ESCROW_SHARED_ABI.slice(1),
] as const;

/** Default escrow ABI (v1.1). */
export const ESCROW_ABI = ESCROW_ABI_V1_1;

/**
 * Escrow function ABI for a commerce-payments protocol version.
 *
 * @param version - Deployment version (`v1.0` or `v1.1`).
 * @returns Charge/capture ABI matching that version's fee encoding.
 */
export function escrowAbiForVersion(version: AuthCaptureDeploymentVersion) {
  return version === "v1.0" ? ESCROW_ABI_V1_0 : ESCROW_ABI_V1_1;
}

/**
 * Escrow function ABI for a resolved commerce-payments deployment.
 *
 * @param deployment - Resolved escrow addresses and version.
 * @returns Charge/capture ABI matching the deployment version.
 */
export function escrowAbiForDeployment(deployment: AuthCaptureDeployment) {
  return escrowAbiForVersion(deployment.version);
}

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

const PAYMENT_AUTHORIZED_EVENT = {
  type: "event",
  name: "PaymentAuthorized",
  inputs: [
    { name: "paymentInfoHash", type: "bytes32", indexed: true },
    {
      name: "paymentInfo",
      type: "tuple",
      components: PAYMENT_INFO_COMPONENTS,
    },
    { name: "amount", type: "uint256", indexed: false },
    { name: "tokenCollector", type: "address", indexed: false },
  ],
} as const;

export const ESCROW_EVENTS_ABI_V1_0 = [
  PAYMENT_AUTHORIZED_EVENT,
  {
    type: "event",
    name: "PaymentCharged",
    inputs: [
      { name: "paymentInfoHash", type: "bytes32", indexed: true },
      {
        name: "paymentInfo",
        type: "tuple",
        components: PAYMENT_INFO_COMPONENTS,
      },
      { name: "amount", type: "uint256", indexed: false },
      { name: "tokenCollector", type: "address", indexed: false },
      { name: "feeBps", type: "uint16", indexed: false },
      { name: "feeReceiver", type: "address", indexed: false },
    ],
  },
] as const;

export const ESCROW_EVENTS_ABI_V1_1 = [
  PAYMENT_AUTHORIZED_EVENT,
  {
    type: "event",
    name: "PaymentCharged",
    inputs: [
      { name: "paymentInfoHash", type: "bytes32", indexed: true },
      {
        name: "paymentInfo",
        type: "tuple",
        components: PAYMENT_INFO_COMPONENTS,
      },
      { name: "amount", type: "uint256", indexed: false },
      { name: "tokenCollector", type: "address", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
      { name: "feeReceiver", type: "address", indexed: false },
    ],
  },
] as const;

/** Default escrow events ABI (v1.1). */
export const ESCROW_EVENTS_ABI = ESCROW_EVENTS_ABI_V1_1;

/**
 * Escrow event ABI for a resolved commerce-payments deployment.
 *
 * @param deployment - Resolved escrow addresses and version.
 * @returns PaymentCharged event ABI matching the deployment version.
 */
export function escrowEventsAbiForDeployment(deployment: AuthCaptureDeployment) {
  return deployment.version === "v1.0" ? ESCROW_EVENTS_ABI_V1_0 : ESCROW_EVENTS_ABI_V1_1;
}

// View functions on AuthCaptureEscrow used by verify (paymentState single-use
// checks) and tests / introspection.
export const ESCROW_VIEW_ABI = [
  {
    name: "getTokenStore",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "operator", type: "address" }],
    outputs: [{ type: "address" }],
  },
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
  {
    type: "error",
    name: "FeeAmountOutOfRange",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
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
  {
    type: "error",
    name: "AfterRefundExpiry",
    inputs: [{ type: "uint48" }, { type: "uint48" }],
  },
  {
    type: "error",
    name: "RefundExceedsCapture",
    inputs: [{ type: "uint256" }, { type: "uint256" }],
  },
] as const;

export const ESCROW_ABI_WITH_ERRORS_V1_0 = [...ESCROW_ABI_V1_0, ...ESCROW_ERRORS_ABI] as const;
export const ESCROW_ABI_WITH_ERRORS_V1_1 = [...ESCROW_ABI_V1_1, ...ESCROW_ERRORS_ABI] as const;

/** Default escrow ABI with errors (v1.1). */
export const ESCROW_ABI_WITH_ERRORS = ESCROW_ABI_WITH_ERRORS_V1_1;

/**
 * Escrow ABI including custom errors for a resolved deployment.
 *
 * @param deployment - Resolved escrow addresses and version.
 * @returns Function plus error ABI matching the deployment version.
 */
export function escrowAbiWithErrorsForDeployment(deployment: AuthCaptureDeployment) {
  return deployment.version === "v1.0" ? ESCROW_ABI_WITH_ERRORS_V1_0 : ESCROW_ABI_WITH_ERRORS_V1_1;
}
