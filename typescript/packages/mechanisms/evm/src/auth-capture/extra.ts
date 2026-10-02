import { getAddress, isAddress, isAddressEqual, zeroAddress } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import { getEvmChainId } from "../utils";
import { extraAddress, isNonZeroAddress } from "./nonce";
import type {
  AuthCaptureCaptureMode,
  AuthCaptureExtra,
  AuthCaptureFacilitatorConfig,
  AuthCapturePaymentFlow,
  OperatorAllowlistEntry,
} from "./types";
import { isAuthCaptureExtra } from "./types";
import * as Errors from "./errors";
import {
  type AuthCaptureDeployment,
  feeAmountFromBps,
  resolveAuthCaptureDeployment,
} from "./constants";

const MAX_FEE_BPS = 10_000;

export type NormalizedAuthCaptureExtra = AuthCaptureExtra & {
  paymentFlow: AuthCapturePaymentFlow;
  operatorType: "delegated" | "custom";
  assetTransferMethod: "eip3009" | "permit2";
  receiverAuthorizer: `0x${string}`;
  policy: `0x${string}`;
  captureMode: AuthCaptureCaptureMode;
  authCaptureEscrow: `0x${string}`;
  deployment: AuthCaptureDeployment;
};

export type SubmittedFeeV1_0 = {
  version: "v1.0";
  feeBps: number;
  feeReceiver: `0x${string}`;
};

export type SubmittedFeeV1_1 = {
  version: "v1.1";
  feeAmount: string;
  feeReceiver: `0x${string}`;
};

export type SubmittedFee = SubmittedFeeV1_0 | SubmittedFeeV1_1;

/**
 * Parse and validate `requirements.extra` into a normalized form with defaults
 * applied. Returns a stable invalidReason on any spec violation.
 *
 * @param extra - Untrusted `requirements.extra`.
 * @returns Normalized extra, or an error code.
 */
export function parseAuthCaptureExtra(
  extra: unknown,
): { extra: NormalizedAuthCaptureExtra } | { error: string } {
  if (!isAuthCaptureExtra(extra)) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }
  const raw = extra as AuthCaptureExtra & { autoCapture?: unknown };

  if (raw.autoCapture === true) {
    return { error: Errors.ErrUnsupportedPaymentFlow };
  }

  const deployment = resolveAuthCaptureDeployment(raw.authCaptureEscrow);
  if (!deployment) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  const paymentFlow = raw.paymentFlow ?? "escrow";
  if (paymentFlow !== "escrow" && paymentFlow !== "authorization") {
    return { error: Errors.ErrUnsupportedPaymentFlow };
  }

  const captureMode = raw.captureMode ?? "sync";
  if (captureMode !== "sync" && captureMode !== "deferred") {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  const operatorType = raw.operatorType ?? "delegated";
  if (operatorType === "policy") {
    return { error: Errors.ErrUnsupportedOperatorType };
  }
  if (operatorType !== "delegated" && operatorType !== "custom") {
    return { error: Errors.ErrUnsupportedOperatorType };
  }

  const assetTransferMethod = raw.assetTransferMethod ?? "eip3009";
  if (assetTransferMethod !== "eip3009" && assetTransferMethod !== "permit2") {
    return { error: Errors.ErrUnsupportedAssetTransferMethod };
  }

  if (
    !Number.isInteger(raw.minFeeBps) ||
    !Number.isInteger(raw.maxFeeBps) ||
    raw.minFeeBps < 0 ||
    raw.maxFeeBps < 0 ||
    raw.minFeeBps > MAX_FEE_BPS ||
    raw.maxFeeBps > MAX_FEE_BPS
  ) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }
  if (raw.minFeeBps > raw.maxFeeBps) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  if (!isAddress(raw.captureAuthorizer) || !isAddress(raw.feeRecipient)) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  const feeRecipient = getAddress(raw.feeRecipient);
  if (isAddressEqual(feeRecipient, zeroAddress) && (raw.minFeeBps !== 0 || raw.maxFeeBps !== 0)) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }
  const receiverAuthorizer = extraAddress(raw.receiverAuthorizer);
  if (paymentFlow === "authorization" && !isNonZeroAddress(receiverAuthorizer)) {
    return { error: Errors.ErrMissingReceiverAuthorizer };
  }

  return {
    extra: {
      ...raw,
      captureAuthorizer: getAddress(raw.captureAuthorizer),
      feeRecipient,
      paymentFlow,
      captureMode,
      operatorType,
      assetTransferMethod,
      receiverAuthorizer,
      policy: extraAddress(raw.policy),
      authCaptureEscrow: deployment.escrow,
      deployment,
    },
  };
}

/**
 * Whether a wire payload uses the fee field expected for the resolved deployment.
 *
 * @param deployment - Resolved commerce-payments deployment.
 * @param fields - Candidate fee fields from the payload.
 * @param fields.feeBps - v1.0 basis-point fee, if present.
 * @param fields.feeAmount - v1.1 absolute fee, if present.
 * @returns True when the fee field matches the deployment ABI.
 */
export function feeFieldMatchesDeployment(
  deployment: AuthCaptureDeployment,
  fields: { feeBps?: unknown; feeAmount?: unknown },
): boolean {
  if (deployment.version === "v1.0") {
    return fields.feeBps !== undefined && fields.feeAmount === undefined;
  }
  return fields.feeAmount !== undefined && fields.feeBps === undefined;
}

/**
 * Validate submitted fee / feeReceiver against the client-signed extra bounds.
 * v1.0 checks `feeBps`; v1.1 checks absolute `feeAmount` against the bps bounds.
 *
 * @param extra - Normalized extra.
 * @param amount - Collect or capture amount in atomic token units.
 * @param fee - Submitted fee parameters (`feeBps` or `feeAmount` per deployment).
 * @returns An error code, or undefined when valid.
 */
export function validateSubmittedFee(
  extra: NormalizedAuthCaptureExtra,
  amount: bigint | string,
  fee: SubmittedFee,
): string | undefined {
  const amountBig = typeof amount === "bigint" ? amount : BigInt(amount);
  const feeReceiver = fee.feeReceiver;

  if (!isAddress(feeReceiver)) {
    return Errors.ErrInvalidFeeReceiver;
  }
  const receiver = getAddress(feeReceiver);
  if (!isAddressEqual(extra.feeRecipient, zeroAddress)) {
    if (!isAddressEqual(receiver, extra.feeRecipient)) {
      return Errors.ErrInvalidFeeReceiver;
    }
  }

  if (fee.version === "v1.0") {
    const feeBps = fee.feeBps;
    if (!Number.isInteger(feeBps) || feeBps < extra.minFeeBps || feeBps > extra.maxFeeBps) {
      return Errors.ErrFeeBpsOutOfRange;
    }
    if (isAddressEqual(receiver, zeroAddress) && feeBps !== 0) {
      return Errors.ErrZeroFeeReceiver;
    }
    return undefined;
  }

  let feeAmount: bigint;
  try {
    feeAmount = BigInt(fee.feeAmount);
  } catch {
    return Errors.ErrFeeBpsOutOfRange;
  }
  const minFee = feeAmountFromBps(amountBig, extra.minFeeBps);
  const maxFee = feeAmountFromBps(amountBig, extra.maxFeeBps);
  if (feeAmount < minFee || feeAmount > maxFee) {
    return Errors.ErrFeeBpsOutOfRange;
  }
  if (isAddressEqual(receiver, zeroAddress) && feeAmount !== 0n) {
    return Errors.ErrZeroFeeReceiver;
  }
  return undefined;
}

/**
 * Default submitted fee for server-authored signed operations: the minimum fee
 * and extra.feeRecipient. v1.0 returns `feeBps`; v1.1 returns absolute `feeAmount`.
 *
 * @param extra - Normalized extra.
 * @param amount - Collect or capture amount in atomic token units.
 * @returns Fee parameters to submit with charge/capture.
 */
export function defaultSubmittedFee(
  extra: NormalizedAuthCaptureExtra,
  amount: bigint | string,
): SubmittedFee {
  const amountBig = typeof amount === "bigint" ? amount : BigInt(amount);
  if (extra.deployment.version === "v1.0") {
    return { version: "v1.0", feeBps: extra.minFeeBps, feeReceiver: extra.feeRecipient };
  }
  return {
    version: "v1.1",
    feeAmount: feeAmountFromBps(amountBig, extra.minFeeBps).toString(),
    feeReceiver: extra.feeRecipient,
  };
}

/**
 * Absolute fee amount for balance-delta checks on charge/capture.
 *
 * @param fee - Submitted fee parameters.
 * @param amount - Settled amount.
 * @returns Fee in atomic token units.
 */
export function submittedFeeAmount(fee: SubmittedFee, amount: bigint): bigint {
  if (fee.version === "v1.0") {
    return feeAmountFromBps(amount, fee.feeBps);
  }
  return BigInt(fee.feeAmount);
}

/**
 * Check operator-type, policy, allowlist, and lifecycle-relay rules.
 *
 * @param extra - Normalized extra.
 * @param submitters - Facilitator signer addresses.
 * @param config - Facilitator config (allowlist).
 * @param isLifecycle - True when the payload is capture/void/refund.
 * @returns An error code, or undefined when admitted.
 */
export function validateOperator(
  extra: NormalizedAuthCaptureExtra,
  submitters: readonly `0x${string}`[],
  config: AuthCaptureFacilitatorConfig | undefined,
  isLifecycle: boolean,
): string | undefined {
  if (isNonZeroAddress(extra.policy)) {
    return Errors.ErrInvalidPolicy;
  }

  if (extra.operatorType === "custom") {
    if (!isOperatorAdmitted(extra.captureAuthorizer, config?.operators)) {
      return Errors.ErrOperatorNotAdmitted;
    }
    if (isLifecycle) {
      return Errors.ErrLifecycleNotRelayed;
    }
    return undefined;
  }

  // delegated
  if (!isSubmitter(extra.captureAuthorizer, submitters)) {
    return Errors.ErrOperatorNotAdmitted;
  }
  if (isLifecycle && !isNonZeroAddress(extra.receiverAuthorizer)) {
    return Errors.ErrLifecycleNotRelayed;
  }
  return undefined;
}

/**
 * Whether `address` is one of the facilitator's submitters.
 *
 * @param address - Candidate operator address.
 * @param submitters - Facilitator signer addresses.
 * @returns True when the address is a submitter.
 */
function isSubmitter(address: `0x${string}`, submitters: readonly `0x${string}`[]): boolean {
  return submitters.some(s => isAddressEqual(s, address));
}

/**
 * Whether a custom operator is on the facilitator's allowlist.
 *
 * @param address - extra.captureAuthorizer.
 * @param operators - Allowlist from facilitator config.
 * @returns True when admitted as `"custom"`.
 */
function isOperatorAdmitted(
  address: `0x${string}`,
  operators: OperatorAllowlistEntry[] | undefined,
): boolean {
  if (!operators || operators.length === 0) return false;
  return operators.some(entry => {
    if (entry.operatorType !== "custom") return false;
    if (entry.address === "*") return true;
    return isAddress(entry.address) && isAddressEqual(entry.address, address);
  });
}

/**
 * Resolve the onchain target for a settle call from operatorType, not bytecode.
 * `"delegated"` always calls the resolved escrow; `"custom"` calls
 * extra.captureAuthorizer.
 *
 * @param extra - Normalized extra.
 * @returns Address to pass to writeContract / simulate.
 */
export function resolveSettleTarget(extra: NormalizedAuthCaptureExtra): `0x${string}` {
  return extra.operatorType === "custom" ? extra.captureAuthorizer : extra.deployment.escrow;
}

/**
 * Common scheme / network / extra / operator checks (spec verification
 * steps 2–5). Returns the normalized extra on success.
 *
 * @param payloadScheme - payload.accepted.scheme.
 * @param payloadNetwork - payload.accepted.network.
 * @param requirements - Published requirements.
 * @param scheme - Expected scheme id.
 * @param submitters - Facilitator signer addresses.
 * @param config - Facilitator config.
 * @param isLifecycle - True for capture/void/refund payloads.
 * @returns Normalized extra, or an invalidReason.
 */
export function verifyCommon(
  payloadScheme: string,
  payloadNetwork: string,
  requirements: PaymentRequirements,
  scheme: string,
  submitters: readonly `0x${string}`[],
  config: AuthCaptureFacilitatorConfig | undefined,
  isLifecycle: boolean,
): { extra: NormalizedAuthCaptureExtra } | { error: string } {
  if (payloadScheme !== scheme || requirements.scheme !== scheme) {
    return { error: Errors.ErrUnsupportedScheme };
  }
  if (payloadNetwork !== requirements.network) {
    return { error: Errors.ErrNetworkMismatch };
  }
  try {
    getEvmChainId(requirements.network);
  } catch {
    return { error: Errors.ErrInvalidNetwork };
  }
  const parsed = parseAuthCaptureExtra(requirements.extra);
  if ("error" in parsed) {
    return parsed;
  }
  const operatorError = validateOperator(parsed.extra, submitters, config, isLifecycle);
  if (operatorError) {
    return { error: operatorError };
  }
  return parsed;
}

/**
 * Resolve and canonicalize `authCaptureEscrow` for publication.
 *
 * @param value - Merchant-provided escrow pin, if any.
 * @returns Known escrow address for the wire.
 */
export function canonicalAuthCaptureEscrow(value: string | undefined): `0x${string}` {
  const deployment = resolveAuthCaptureDeployment(value);
  return (deployment ?? resolveAuthCaptureDeployment(undefined)!).escrow;
}

/**
 * Read the submitted capture fee from a lifecycle payload.
 *
 * @param extra - Normalized extra.
 * @param wirePayload - Capture envelope.
 * @param wirePayload.feeBps - v1.0 basis-point fee, if present.
 * @param wirePayload.feeAmount - v1.1 absolute fee, if present.
 * @param wirePayload.feeReceiver - Fee recipient on the capture call.
 * @returns Submitted fee, or undefined when fields mismatch the deployment.
 */
export function captureFeeFromPayload(
  extra: NormalizedAuthCaptureExtra,
  wirePayload: { feeBps?: number; feeAmount?: string; feeReceiver: `0x${string}` },
): SubmittedFee | undefined {
  if (!feeFieldMatchesDeployment(extra.deployment, wirePayload)) {
    return undefined;
  }
  if (extra.deployment.version === "v1.0") {
    return {
      version: "v1.0",
      feeBps: wirePayload.feeBps as number,
      feeReceiver: wirePayload.feeReceiver,
    };
  }
  return {
    version: "v1.1",
    feeAmount: wirePayload.feeAmount as string,
    feeReceiver: wirePayload.feeReceiver,
  };
}

/**
 * Encode capture() arguments for the resolved deployment.
 *
 * @param tuple - PaymentInfo struct tuple for the escrow call.
 * @param amount - Capture amount in atomic token units.
 * @param fee - Submitted fee matching the deployment version.
 * @returns Positional arguments for `capture`.
 */
export function captureEscrowArgs(
  tuple: ReturnType<typeof import("./utils").paymentInfoToContractTuple>,
  amount: bigint,
  fee: SubmittedFee,
): readonly unknown[] {
  if (fee.version === "v1.0") {
    return [tuple, amount, fee.feeBps, fee.feeReceiver] as const;
  }
  return [tuple, amount, BigInt(fee.feeAmount), fee.feeReceiver] as const;
}

/**
 * Encode charge() arguments for the resolved deployment.
 *
 * @param tuple - PaymentInfo struct tuple for the escrow call.
 * @param amount - Charge amount in atomic token units.
 * @param tokenCollector - Collector contract used for this charge.
 * @param collectorData - Collector-specific calldata.
 * @param fee - Submitted fee matching the deployment version.
 * @returns Positional arguments for `charge`.
 */
export function chargeEscrowArgs(
  tuple: ReturnType<typeof import("./utils").paymentInfoToContractTuple>,
  amount: bigint,
  tokenCollector: `0x${string}`,
  collectorData: `0x${string}`,
  fee: SubmittedFee,
): readonly unknown[] {
  if (fee.version === "v1.0") {
    return [tuple, amount, tokenCollector, collectorData, fee.feeBps, fee.feeReceiver] as const;
  }
  return [
    tuple,
    amount,
    tokenCollector,
    collectorData,
    BigInt(fee.feeAmount),
    fee.feeReceiver,
  ] as const;
}

/**
 * Read charge-completion fee fields from a collect payload.
 *
 * @param extra - Normalized extra (deployment and fee bounds).
 * @param wirePayload - Collect payload fields including fee and feeReceiver.
 * @returns Submitted fee, or undefined when fields mismatch the deployment.
 */
export function chargeFeeFromCollectPayload(
  extra: NormalizedAuthCaptureExtra,
  wirePayload: Record<string, unknown>,
): SubmittedFee | undefined {
  if (!feeFieldMatchesDeployment(extra.deployment, wirePayload)) {
    return undefined;
  }
  if (extra.deployment.version === "v1.0") {
    return {
      version: "v1.0",
      feeBps: wirePayload.feeBps as number,
      feeReceiver: wirePayload.feeReceiver as `0x${string}`,
    };
  }
  return {
    version: "v1.1",
    feeAmount: wirePayload.feeAmount as string,
    feeReceiver: wirePayload.feeReceiver as `0x${string}`,
  };
}
