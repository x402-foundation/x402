import { BaseError, ContractFunctionRevertedError, isAddressEqual, type Log } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import { escrowAbiWithErrorsForDeployment } from "../abi";
import { ESCROW_VIEW_ABI } from "../abi";
import type { AuthCaptureDeployment } from "../constants";
import type { AuthCaptureCollectPayload, PaymentState } from "../types";
import { isEip3009Payload } from "../types";
import { ESCROW_ERROR_TO_INVALID_REASON, ErrSimulationFailed } from "../errors";

export const SAFETY_MARGIN_SECONDS = 6;

/**
 * Flatten and dedupe facilitator submitter addresses across a signer set.
 *
 * @param signers - Facilitator signers (each may expose one or more addresses).
 * @returns Unique addresses in first-seen order.
 */
export function facilitatorAddresses(
  signers: readonly FacilitatorEvmSigner[],
): readonly `0x${string}`[] {
  const seen: `0x${string}`[] = [];
  for (const signer of signers) {
    for (const address of signer.getAddresses()) {
      if (!seen.some(existing => isAddressEqual(existing, address))) {
        seen.push(address);
      }
    }
  }
  return seen;
}

/**
 * Find the signer that can submit from `address`.
 *
 * Comparison is checksum-insensitive so a parsed `extra.captureAuthorizer`
 * still matches a lowercase `getAddresses()` entry.
 *
 * @param signers - Facilitator signers to scan.
 * @param address - Submitter to look up.
 * @returns The owning signer, or undefined when no member controls `address`.
 */
export function selectSubmitter(
  signers: readonly FacilitatorEvmSigner[],
  address: `0x${string}`,
): FacilitatorEvmSigner | undefined {
  return signers.find(signer =>
    signer.getAddresses().some(owned => isAddressEqual(owned, address)),
  );
}

/**
 * Resolve the signer that will simulate and submit this request.
 * Delegated payments use `extra.captureAuthorizer`; custom operators may be
 * submitted by any facilitator address, so the first signer is used.
 *
 * @param signers - Facilitator signer set.
 * @param extra - Normalized extra after `verifyCommon`.
 * @param extra.operatorType - `"delegated"` or `"custom"`.
 * @param extra.captureAuthorizer - Operator address from extra.
 * @returns The submitter, or undefined when the set is empty.
 */
export function resolveSubmitter(
  signers: readonly FacilitatorEvmSigner[],
  extra: { operatorType: "delegated" | "custom"; captureAuthorizer: `0x${string}` },
): FacilitatorEvmSigner | undefined {
  if (extra.operatorType === "delegated") {
    return selectSubmitter(signers, extra.captureAuthorizer);
  }
  return signers[0];
}

/** Backoff delays between paymentState eth_call retries (RPC index lag after authorize). */
export const PAYMENT_STATE_RETRY_DELAYS_MS = [200, 400, 800, 1600] as const;

/** Initial read plus one attempt per retry delay. */
export const PAYMENT_STATE_MAX_ATTEMPTS = PAYMENT_STATE_RETRY_DELAYS_MS.length + 1;

/**
 * Walk a viem error chain looking for a decoded custom-error name, then map
 * known names to a stable `invalidReason` via `ESCROW_ERROR_TO_INVALID_REASON`.
 * Anything unmapped returns `ErrSimulationFailed` so the wire never leaks raw
 * selectors.
 *
 * @param err - The error thrown by `readContract` / `simulateContract`.
 * @returns A stable wire-level `invalidReason` string.
 */
export function decodeRevertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e): e is ContractFunctionRevertedError => e instanceof ContractFunctionRevertedError,
    );
    if (revert instanceof ContractFunctionRevertedError) {
      const errorName = revert.data?.errorName;
      if (errorName && errorName in ESCROW_ERROR_TO_INVALID_REASON) {
        return ESCROW_ERROR_TO_INVALID_REASON[errorName];
      }
    }
  }
  return ErrSimulationFailed;
}

/**
 * Collect-payload payer address.
 *
 * @param wirePayload - EIP-3009 or Permit2 collect payload.
 * @returns The `from` address.
 */
export function collectPayer(wirePayload: AuthCaptureCollectPayload): `0x${string}` {
  return isEip3009Payload(wirePayload)
    ? wirePayload.authorization.from
    : wirePayload.permit2Authorization.from;
}

/**
 * Simulate an escrow call via `eth_call` as the facilitator submitter.
 *
 * @param signer - Facilitator signer.
 * @param target - Escrow or custom operator.
 * @param functionName - Escrow ABI function.
 * @param args - Encoded arguments.
 * @param account - msg.sender for the eth_call.
 * @param deployment - Resolved escrow addresses and version.
 * @returns `"ok"` or a stable invalidReason.
 */
export async function simulateEscrowCall(
  signer: FacilitatorEvmSigner,
  target: `0x${string}`,
  functionName: "authorize" | "charge" | "capture" | "void" | "refund",
  args: readonly unknown[],
  account: `0x${string}`,
  deployment: AuthCaptureDeployment,
): Promise<"ok" | string> {
  try {
    await signer.readContract({
      address: target,
      abi: escrowAbiWithErrorsForDeployment(deployment),
      functionName,
      args,
      account,
    });
    return "ok";
  } catch (err) {
    return decodeRevertReason(err);
  }
}

/**
 * Broadcast an escrow call without waiting for confirmation.
 *
 * @param signer - Facilitator signer.
 * @param target - Contract to call.
 * @param functionName - Escrow ABI function.
 * @param args - Encoded arguments.
 * @param deployment - Resolved escrow addresses and version.
 * @param options - Optional gas cap and extension calldata suffix.
 * @param options.gas - Hard gas limit for the write.
 * @param options.dataSuffix - Builder-code suffix appended to calldata.
 * @returns Transaction hash, or a write failure reason with no hash.
 */
export async function writeEscrowCall(
  signer: FacilitatorEvmSigner,
  target: `0x${string}`,
  functionName: "authorize" | "charge" | "capture" | "void" | "refund",
  args: readonly unknown[],
  deployment: AuthCaptureDeployment,
  options?: { gas?: bigint; dataSuffix?: `0x${string}` },
): Promise<{ txHash: `0x${string}` } | { error: string }> {
  try {
    const txHash = await signer.writeContract({
      address: target,
      abi: escrowAbiWithErrorsForDeployment(deployment),
      functionName,
      args,
      gas: options?.gas,
      dataSuffix: options?.dataSuffix,
    });
    return { txHash };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Settlement failed" };
  }
}

/**
 * Broadcast an escrow call and wait for a successful receipt. Used for
 * best-effort trailing lifecycle calls whose outcome is ignored.
 *
 * @param signer - Facilitator signer.
 * @param target - Contract to call.
 * @param functionName - Escrow ABI function.
 * @param args - Encoded arguments.
 * @param deployment - Resolved escrow addresses and version.
 * @param options - Optional gas cap and extension calldata suffix.
 * @param options.gas - Hard gas limit for the write.
 * @param options.dataSuffix - Builder-code suffix appended to calldata.
 * @returns Transaction hash, or a failure reason.
 */
export async function submitEscrowCall(
  signer: FacilitatorEvmSigner,
  target: `0x${string}`,
  functionName: "authorize" | "charge" | "capture" | "void" | "refund",
  args: readonly unknown[],
  deployment: AuthCaptureDeployment,
  options?: { gas?: bigint; dataSuffix?: `0x${string}` },
): Promise<
  { txHash: `0x${string}`; logs?: readonly Log[] } | { error: string; txHash?: `0x${string}` }
> {
  const written = await writeEscrowCall(signer, target, functionName, args, deployment, options);
  if ("error" in written) {
    return { error: written.error };
  }

  try {
    const receipt = await signer.waitForTransactionReceipt({ hash: written.txHash });
    if (receipt.status !== "success") {
      return { error: "reverted", txHash: written.txHash };
    }
    return { txHash: written.txHash, logs: receipt.logs };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Settlement failed" };
  }
}

/**
 * Normalize viem `paymentState` return shapes to a flat PaymentState.
 *
 * @param raw - Value from `readContract(paymentState)`.
 * @returns Parsed state, or undefined when unrecognized.
 */
export function normalizePaymentState(raw: unknown): PaymentState | undefined {
  if (raw === null || raw === undefined) return undefined;

  if (typeof raw === "object" && !Array.isArray(raw) && "state" in raw) {
    return normalizePaymentState((raw as { state: unknown }).state);
  }

  if (Array.isArray(raw)) {
    if (raw.length < 3) return undefined;
    return {
      hasCollectedPayment: Boolean(raw[0]),
      capturableAmount: BigInt(raw[1] as bigint | number | string),
      refundableAmount: BigInt(raw[2] as bigint | number | string),
    };
  }

  if (typeof raw === "object") {
    const s = raw as Record<string, unknown>;
    if (
      s.capturableAmount === undefined &&
      s.refundableAmount === undefined &&
      s.hasCollectedPayment === undefined
    ) {
      return undefined;
    }
    return {
      hasCollectedPayment: Boolean(s.hasCollectedPayment),
      capturableAmount: BigInt(s.capturableAmount as bigint | number | string),
      refundableAmount: BigInt(s.refundableAmount as bigint | number | string),
    };
  }

  return undefined;
}

/**
 * Read AuthCaptureEscrow.paymentState once.
 *
 * @param signer - Facilitator signer.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param escrowAddress - AuthCaptureEscrow to query.
 * @returns Onchain balances, or undefined when the read fails.
 */
export async function readPaymentStateOnce(
  signer: FacilitatorEvmSigner,
  paymentInfoHash: `0x${string}`,
  escrowAddress: `0x${string}`,
): Promise<PaymentState | undefined> {
  try {
    const raw = await signer.readContract({
      address: escrowAddress,
      abi: ESCROW_VIEW_ABI,
      functionName: "paymentState",
      args: [paymentInfoHash],
    });
    return normalizePaymentState(raw);
  } catch {
    return undefined;
  }
}

/**
 * Delay for a fixed duration (paymentState RPC retry backoff).
 *
 * @param ms - Sleep duration in milliseconds.
 * @returns A promise that resolves after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Compare onchain paymentState balances to signed lifecycle expectations.
 *
 * @param state - Escrow paymentState read from chain.
 * @param expectedCapturable - Signed expected capturable balance.
 * @param expectedRefundable - Signed expected refundable balance.
 * @returns True when both balances match exactly.
 */
function paymentStateBalancesMatch(
  state: PaymentState,
  expectedCapturable: bigint,
  expectedRefundable: bigint,
): boolean {
  return (
    state.capturableAmount === expectedCapturable && state.refundableAmount === expectedRefundable
  );
}

/**
 * Detect empty paymentState that likely reflects RPC index lag after collect.
 *
 * Authorize expects a capturable hold; charge expects a refundable balance.
 * Public RPCs often still return the uncollected zero struct right after the
 * receipt, so both cases retry rather than treating zeros as a genuine mismatch.
 *
 * @param state - Escrow paymentState read from chain.
 * @param expectedCapturable - Signed expected capturable balance.
 * @param expectedRefundable - Signed expected refundable balance.
 * @returns True when the read looks like a stale zero state despite an expected collect.
 */
function isLikelyStalePaymentState(
  state: PaymentState,
  expectedCapturable: bigint,
  expectedRefundable: bigint,
): boolean {
  return (
    (expectedCapturable > 0n || expectedRefundable > 0n) &&
    !state.hasCollectedPayment &&
    state.capturableAmount === 0n &&
    state.refundableAmount === 0n
  );
}

/**
 * Read paymentState with exponential backoff when the RPC may not yet reflect a fresh collect.
 *
 * @param signer - Facilitator signer.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param expectedCapturable - Signed expected capturable balance.
 * @param expectedRefundable - Signed expected refundable balance.
 * @param escrowAddress - AuthCaptureEscrow to query.
 * @returns Parsed state and read metadata.
 */
export async function readPaymentStateForBalances(
  signer: FacilitatorEvmSigner,
  paymentInfoHash: `0x${string}`,
  expectedCapturable: bigint,
  expectedRefundable: bigint,
  escrowAddress: `0x${string}`,
): Promise<{ state?: PaymentState; readFailed: boolean; attempts: number }> {
  for (let attempt = 0; ; attempt++) {
    const state = await readPaymentStateOnce(signer, paymentInfoHash, escrowAddress);

    if (state && paymentStateBalancesMatch(state, expectedCapturable, expectedRefundable)) {
      return { state, readFailed: false, attempts: attempt + 1 };
    }

    if (state && !isLikelyStalePaymentState(state, expectedCapturable, expectedRefundable)) {
      return { state, readFailed: false, attempts: attempt + 1 };
    }

    if (attempt === PAYMENT_STATE_RETRY_DELAYS_MS.length) {
      return { readFailed: true, attempts: attempt + 1 };
    }

    await sleep(PAYMENT_STATE_RETRY_DELAYS_MS[attempt]!);
  }
}
