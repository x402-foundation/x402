import { getAddress, isAddress, isAddressEqual, keccak256, toBytes } from "viem";

// Scheme identifier for the auth-capture payment scheme.
export const AUTH_CAPTURE_SCHEME = "auth-capture" as const;

// Canonical AuthCaptureEscrow + token collector deployments from
// base/commerce-payments (https://github.com/base/commerce-payments). These are
// the audited, live addresses listed in the upstream README and are the source
// of truth for this scheme. They are universal constants, not configurable per
// merchant. Two CREATE2 sets are specified; default exports point at v1.1.
export type AuthCaptureDeploymentVersion = "v1.0" | "v1.1";

export type AuthCaptureDeployment = {
  version: AuthCaptureDeploymentVersion;
  escrow: `0x${string}`;
  eip3009Collector: `0x${string}`;
  permit2Collector: `0x${string}`;
  operatorRefundCollector: `0x${string}`;
};

// commerce-payments v1.0 (tag v1.0.0)
export const AUTH_CAPTURE_ESCROW_V1_0_ADDRESS =
  "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff" as const satisfies `0x${string}`;
export const EIP3009_TOKEN_COLLECTOR_V1_0_ADDRESS =
  "0x0E3dF9510de65469C4518D7843919c0b8C7A7757" as const satisfies `0x${string}`;
export const PERMIT2_TOKEN_COLLECTOR_V1_0_ADDRESS =
  "0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26" as const satisfies `0x${string}`;
export const OPERATOR_REFUND_COLLECTOR_V1_0_ADDRESS =
  "0x934907bffd0901b6A21e398B9C53A4A38F02fa5d" as const satisfies `0x${string}`;

// commerce-payments v1.1 (default)
export const AUTH_CAPTURE_ESCROW_V1_1_ADDRESS =
  "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c" as const satisfies `0x${string}`;
export const EIP3009_TOKEN_COLLECTOR_V1_1_ADDRESS =
  "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88" as const satisfies `0x${string}`;
export const PERMIT2_TOKEN_COLLECTOR_V1_1_ADDRESS =
  "0xD69831Aed5bfe262067ec4c751f4F830EcdD446e" as const satisfies `0x${string}`;
export const OPERATOR_REFUND_COLLECTOR_V1_1_ADDRESS =
  "0x7a03443724d14798c4AB4622F1DAAcA761Fea486" as const satisfies `0x${string}`;

/** Default deployment aliases (v1.1). */
export const AUTH_CAPTURE_ESCROW_ADDRESS = AUTH_CAPTURE_ESCROW_V1_1_ADDRESS;
export const EIP3009_TOKEN_COLLECTOR_ADDRESS = EIP3009_TOKEN_COLLECTOR_V1_1_ADDRESS;
export const PERMIT2_TOKEN_COLLECTOR_ADDRESS = PERMIT2_TOKEN_COLLECTOR_V1_1_ADDRESS;
export const OPERATOR_REFUND_COLLECTOR_ADDRESS = OPERATOR_REFUND_COLLECTOR_V1_1_ADDRESS;

export const AUTH_CAPTURE_DEPLOYMENT_V1_0: AuthCaptureDeployment = {
  version: "v1.0",
  escrow: AUTH_CAPTURE_ESCROW_V1_0_ADDRESS,
  eip3009Collector: EIP3009_TOKEN_COLLECTOR_V1_0_ADDRESS,
  permit2Collector: PERMIT2_TOKEN_COLLECTOR_V1_0_ADDRESS,
  operatorRefundCollector: OPERATOR_REFUND_COLLECTOR_V1_0_ADDRESS,
};

export const AUTH_CAPTURE_DEPLOYMENT_V1_1: AuthCaptureDeployment = {
  version: "v1.1",
  escrow: AUTH_CAPTURE_ESCROW_V1_1_ADDRESS,
  eip3009Collector: EIP3009_TOKEN_COLLECTOR_V1_1_ADDRESS,
  permit2Collector: PERMIT2_TOKEN_COLLECTOR_V1_1_ADDRESS,
  operatorRefundCollector: OPERATOR_REFUND_COLLECTOR_V1_1_ADDRESS,
};

/**
 * Resolve the commerce-payments deployment from optional `extra.authCaptureEscrow`.
 * Absent or the v1.1 escrow selects v1.1; the v1.0 escrow selects v1.0.
 *
 * @param escrow - Optional escrow address from extra (`authCaptureEscrow`).
 * @returns Known v1.0 or v1.1 deployment, or undefined when the address is unknown.
 */
export function resolveAuthCaptureDeployment(escrow?: string): AuthCaptureDeployment | undefined {
  if (escrow === undefined || escrow === "") {
    return AUTH_CAPTURE_DEPLOYMENT_V1_1;
  }
  if (!isAddress(escrow)) {
    return undefined;
  }
  const normalized = getAddress(escrow);
  if (
    isAddressEqual(normalized, AUTH_CAPTURE_ESCROW_V1_1_ADDRESS) ||
    isAddressEqual(normalized, AUTH_CAPTURE_ESCROW_ADDRESS)
  ) {
    return AUTH_CAPTURE_DEPLOYMENT_V1_1;
  }
  if (isAddressEqual(normalized, AUTH_CAPTURE_ESCROW_V1_0_ADDRESS)) {
    return AUTH_CAPTURE_DEPLOYMENT_V1_0;
  }
  return undefined;
}

/** Default max gas for a custom-operator collect relay (`authorize` or `charge`). */
export const DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT = 1_000_000n;

// Domain tag for the bound-salt derivation. Encoded as the first word of
// `abi.encode(SALT_BINDING_TYPEHASH, receiverAuthorizer, policy, saltNonce)`
// so a value produced as a salt commitment can never be read as a signature nonce.
export const SALT_BINDING_TYPEHASH = keccak256(
  toBytes(
    "x402AuthCaptureSaltBinding(address receiverAuthorizer,address policy,uint256 saltNonce)",
  ),
);

// Shared EIP-712 domain for every operator type. `verifyingContract` is the
// capture authorizer (PaymentInfo.operator), not a scheme-wide address.
export const OPERATOR_EIP712_DOMAIN = {
  name: "x402 Auth Capture Operator",
  version: "1",
} as const;

// ERC-3009 ReceiveWithAuthorization EIP-712 types
export const RECEIVE_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Uniswap Permit2 PermitTransferFrom EIP-712 types
export const PERMIT2_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

// Operator EIP-712 types for facilitator-relayed charge and lifecycle.
// v1.0 operator EIP-712 types (feeBps on charge/capture).
export const CHARGE_TYPES_V1_0 = {
  Charge: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "tokenCollector", type: "address" },
    { name: "collectorDataHash", type: "bytes32" },
    { name: "feeBps", type: "uint16" },
    { name: "feeReceiver", type: "address" },
  ],
} as const;

export const CAPTURE_TYPES_V1_0 = {
  Capture: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "feeReceiver", type: "address" },
    { name: "expectedCapturableAmount", type: "uint256" },
    { name: "expectedRefundableAmount", type: "uint256" },
  ],
} as const;

// v1.1 operator EIP-712 types (absolute feeAmount on charge/capture).
export const CHARGE_TYPES_V1_1 = {
  Charge: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "tokenCollector", type: "address" },
    { name: "collectorDataHash", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeReceiver", type: "address" },
  ],
} as const;

export const CAPTURE_TYPES_V1_1 = {
  Capture: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "feeAmount", type: "uint256" },
    { name: "feeReceiver", type: "address" },
    { name: "expectedCapturableAmount", type: "uint256" },
    { name: "expectedRefundableAmount", type: "uint256" },
  ],
} as const;

/** Default v1.1 charge/capture EIP-712 types. */
export const CHARGE_TYPES = CHARGE_TYPES_V1_1;
export const CAPTURE_TYPES = CAPTURE_TYPES_V1_1;

export const VOID_TYPES = {
  Void: [{ name: "paymentInfoHash", type: "bytes32" }],
} as const;

export const REFUND_TYPES = {
  Refund: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "tokenCollector", type: "address" },
    { name: "expectedCapturableAmount", type: "uint256" },
    { name: "expectedRefundableAmount", type: "uint256" },
  ],
} as const;

/**
 * Operator Charge EIP-712 types for a resolved deployment.
 *
 * @param deployment - Resolved escrow addresses and version.
 * @returns Charge typed-data fields matching the deployment fee encoding.
 */
export function chargeTypesForDeployment(deployment: AuthCaptureDeployment) {
  return deployment.version === "v1.0" ? CHARGE_TYPES_V1_0 : CHARGE_TYPES_V1_1;
}

/**
 * Operator Capture EIP-712 types for a resolved deployment.
 *
 * @param deployment - Resolved escrow addresses and version.
 * @returns Capture typed-data fields matching the deployment fee encoding.
 */
export function captureTypesForDeployment(deployment: AuthCaptureDeployment) {
  return deployment.version === "v1.0" ? CAPTURE_TYPES_V1_0 : CAPTURE_TYPES_V1_1;
}

/**
 * Integer fee from amount and bps (same division the escrow uses).
 *
 * @param amount - Principal amount in atomic token units.
 * @param feeBps - Fee in basis points.
 * @returns Absolute fee amount using escrow integer division.
 */
export function feeAmountFromBps(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / 10_000n;
}
