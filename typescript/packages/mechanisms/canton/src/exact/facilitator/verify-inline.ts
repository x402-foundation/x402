/**
 * Inline transfer-factory VERIFY — the money-critical validation, on the
 * `@x402/core` wire types and the injected `FacilitatorCantonSigner`. Never
 * submits; never mutates.
 *
 * The payer signs a relay-prepared `TransferFactory_Transfer` and carries it
 * inline. This proves, from the SIGNED bytes alone: the proven payer (act_as),
 * amount/receiver/instrument/synchronizer/memo, single-root-exercise, the
 * deadline and the Ed25519 signature, and (see ledger-proofs.ts) the factory,
 * the direct delivery to the merchant and the input holdings covering the amount.
 * No Scan or registry read is involved.
 */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  assertDecodedTransferMatches,
  assertSynchronizerMatches,
  PreparedTransferMismatchError,
  decodePrepared,
  extractTransfer,
  type DecodedPrepared,
} from "../../prepared-transfer.js";
import { decodeInlinePaymentPayload, InlinePayloadError } from "../../inline-payload.js";
import { wireAmountToLedgerDecimal } from "../../amount.js";
import { CANTON_TRANSFER_METHOD } from "../../constants.js";
import type { CantonErrorCode } from "../../types.js";
import type { FacilitatorCantonSigner, CantonSchemeConfig } from "../../signer.js";
import { proveSettlementPath, type TransferKind } from "./ledger-proofs.js";

const EXECUTE_BEFORE_MARGIN_MS = 5_000;

/** A payload verify proved, with what settle needs to relay and reconcile it. */
export interface InlineVerifySuccess {
  ok: true;
  payer: string;
  preparedTransactionBytes: Buffer;
  signatureB64: string;
  hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
  /** The hash recomputed from the signed bytes, which the signature covers. */
  preparedTxHashHex: string;
  publishedProtocolKeys?: number;
  /** The instrument family verify proved the transfer settles through. */
  transferKind: TransferKind;
  /** The signed command id, used by settle to find the committed transaction. */
  commandId: string;
  /** The latest time (ms) the signed transaction may still commit at, before
   *  the synchronizer's ledger-time tolerance: the earliest of its
   *  `executeBefore`, `max_ledger_effective_time` and `max_record_time`. */
  commitDeadlineMs: number;
}

/** A payload verify refused, with the reason and the payer when it was proven. */
export interface InlineVerifyFailure {
  ok: false;
  reason: CantonErrorCode;
  payer: string;
}

export type InlineVerifyResult = InlineVerifySuccess | InlineVerifyFailure;

const fail = (reason: CantonErrorCode, payer = ""): InlineVerifyFailure => ({
  ok: false,
  reason,
  payer,
});

/**
 * True when a payload carries the inline carriage.
 *
 * @param payload
 */
export function isInlineCarriage(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)["preparedTransaction"] === "string"
  );
}

/**
 * Map the structural validator's message onto the scheme's error table.
 *
 * @param message
 */
export function classifyMismatch(message: string): CantonErrorCode {
  const m = message.toLowerCase();
  if (m.includes("amount")) return "invalid_exact_canton_amount_mismatch";
  if (m.includes("receiver")) return "invalid_exact_canton_merchant_mismatch";
  if (m.includes("instrument")) return "invalid_exact_canton_instrument_id_mismatch";
  if (m.includes("memo")) return "invalid_exact_canton_memo_mismatch";
  if (m.includes("input holding")) return "invalid_exact_canton_insufficient_inputs";
  if (
    m.includes("expire") ||
    m.includes("executebefore") ||
    m.includes("record_time") ||
    m.includes("effective_time") ||
    m.includes("already in the past")
  )
    return "invalid_exact_canton_expired";
  return "invalid_exact_canton_malformed_payload";
}

/**
 * Validate an inline transfer-factory payload against the merchant's
 * requirements, using injected ledger reads. Pure-async, no side effects.
 *
 * @param payload
 * @param requirements
 * @param signer
 * @param config
 * @param nowMsOverride
 */
export async function verifyInlineTransfer(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  signer: FacilitatorCantonSigner,
  config: CantonSchemeConfig & { synchronizerId?: string; networks: readonly string[] },
  nowMsOverride?: number,
): Promise<InlineVerifyResult> {
  const facilitatorParties = new Set(signer.getAddresses());

  // Rule 1 — scheme + network match. The payer's accepted requirements must
  // name the same scheme and network as the requirements being verified, and
  // that network must be one this facilitator serves.
  if (payload.accepted?.scheme !== "exact" || requirements.scheme !== "exact") {
    return fail("unsupported_scheme");
  }
  if (payload.accepted.network !== requirements.network) {
    return fail("invalid_network");
  }
  if (!config.networks.includes(requirements.network)) {
    return fail("invalid_network");
  }

  // Rule 2 — decode within the scheme's bounds (single-gzip framing + caps).
  let decoded;
  try {
    decoded = decodeInlinePaymentPayload(payload.payload);
  } catch (err) {
    if (err instanceof InlinePayloadError) return fail(err.code as CantonErrorCode);
    return fail("invalid_exact_canton_malformed_payload");
  }

  // Decoded ONCE; every check below reads this same parse.
  let pt: DecodedPrepared;
  try {
    pt = decodePrepared(decoded.preparedTransactionBytes.toString("base64"));
  } catch {
    return fail("invalid_exact_canton_malformed_payload");
  }

  // Rule 8 — the proven payer, read from the SIGNED metadata (single act_as).
  if (pt.actAs.length !== 1 || !pt.actAs[0]) {
    return fail("invalid_exact_canton_malformed_payload");
  }
  const payer = pt.actAs[0];

  // Rule 11 — self-payment guard.
  if (facilitatorParties.has(payer)) {
    return fail("invalid_exact_canton_self_payment", payer);
  }

  const req = readRequirements(requirements, facilitatorParties);
  if ("reason" in req) return fail(req.reason, payer);
  const { extra, expectedAmount } = req;

  // Synchronizer pin: this facilitator's own configured domain is authoritative;
  // the requirement's `extra.synchronizerId` is the fallback, and when both are
  // set the signed transaction must match both.
  const ownSynchronizer = config.synchronizerId || undefined;
  const expectedSynchronizer = ownSynchronizer ?? extra.synchronizerId;

  // Rules 4/5/6 — amount/receiver/instrument/synchronizer/memo + single-root
  // exercise, proven from the signed bytes.

  let declaredInputs: string[];
  let declaredExecuteBefore: number | undefined;
  let rootContractId: string | undefined;
  try {
    assertDecodedTransferMatches(pt, {
      sender: payer,
      receiver: requirements.payTo,
      amount: expectedAmount,
      instrumentId: extra.instrumentId.id,
      requireInputHoldings: true,
      instrumentAdmin: extra.instrumentId.admin,
      ...(config.registryTrustedParties?.[extra.instrumentId.admin]
        ? {
            trustedRegistryParties: new Set(
              config.registryTrustedParties[extra.instrumentId.admin],
            ),
          }
        : {}),
      ...(expectedSynchronizer !== undefined ? { synchronizerId: expectedSynchronizer } : {}),
      ...(typeof extra.memo === "string" && extra.memo.length > 0 ? { memo: extra.memo } : {}),
      ...(nowMsOverride !== undefined ? { nowMs: nowMsOverride } : {}),
    });
    if (ownSynchronizer !== undefined && extra.synchronizerId !== undefined) {
      assertSynchronizerMatches(pt.synchronizerId, extra.synchronizerId);
    }
    // The single root exercise assertDecodedTransferMatches just validated.
    const ex = pt.nodes.find(n => n.nodeId === pt.roots[0])?.exercise;
    const t = ex?.chosenValue ? extractTransfer(ex.chosenValue) : undefined;
    rootContractId = ex?.contractId;
    declaredInputs = t?.inputHoldingCids ?? [];
    declaredExecuteBefore = t?.executeBeforeMs;
  } catch (err) {
    if (err instanceof PreparedTransferMismatchError) {
      return fail(classifyMismatch(err.message), payer);
    }
    return fail("invalid_exact_canton_malformed_payload", payer);
  }

  // Rules 3, 7 and 13 — the factory, the direct delivery to the merchant and
  // the input holdings, all proven from the signed input contracts.
  if (!rootContractId) {
    return fail("invalid_exact_canton_malformed_payload", payer);
  }
  const nowMs = nowMsOverride ?? Date.now();
  const path = proveSettlementPath(pt, {
    payer,
    payTo: requirements.payTo,
    instrumentId: { admin: extra.instrumentId.admin, id: extra.instrumentId.id },
    amount: expectedAmount,
    inputHoldingCids: declaredInputs,
    rootContractId,
    trustedRegistrars: new Set(Object.keys(config.registryTrustedParties ?? {})),
    nowMs,
  });
  if (!path.ok) return fail(path.reason, payer);

  if (!merchantServed(config, requirements.payTo, path.preapprovalProvider, facilitatorParties)) {
    return fail("invalid_exact_canton_merchant_not_registered", payer);
  }

  // Rule 10 — deadline (floor + ceiling).
  if (declaredExecuteBefore === undefined) {
    return fail("invalid_exact_canton_expired", payer);
  }
  const deadlineReason = executeBeforeReason(
    declaredExecuteBefore,
    nowMs,
    config.maxExecuteBeforeSeconds,
  );
  if (deadlineReason) return fail(deadlineReason, payer);

  // Rule 3 — signature, last and fail-closed. Verify reads nothing else from
  // the network, so a payload error never surfaces as a ledger error.
  let proof: Awaited<ReturnType<FacilitatorCantonSigner["verifySignature"]>>;
  try {
    proof = await signer.verifySignature({
      preparedTransactionBytes: decoded.preparedTransactionBytes,
      claimedPreparedTxHash: decoded.claimedPreparedTxHash,
      signatureB64: decoded.signatureB64,
      payer,
      hashingSchemeVersion: decoded.hashingSchemeVersion,
    });
  } catch {
    // The payer's key could not be read: that says nothing about the payload.
    return fail("unexpected_canton_ledger_error", payer);
  }
  if (!proof.verified || proof.preparedTxHashHex === undefined) {
    return fail("invalid_exact_canton_signature_invalid", payer);
  }
  // The proto requires a command id; settle reconciles by it.
  if (pt.commandId === undefined) {
    return fail("invalid_exact_canton_malformed_payload", payer);
  }

  return {
    ok: true,
    payer,
    preparedTransactionBytes: decoded.preparedTransactionBytes,
    signatureB64: decoded.signatureB64,
    hashingSchemeVersion: decoded.hashingSchemeVersion,
    transferKind: path.kind,
    commandId: pt.commandId,
    commitDeadlineMs: Math.min(
      declaredExecuteBefore,
      ...[pt.maxLedgerEffectiveTime, pt.maxRecordTime]
        .filter((t): t is bigint => t !== undefined)
        .map(t => Number(t / 1000n)),
    ),
    ...(proof.publishedProtocolKeys !== undefined
      ? { publishedProtocolKeys: proof.publishedProtocolKeys }
      : {}),
    preparedTxHashHex: proof.preparedTxHashHex,
  };
}

/** The requirement fields verify reads, once validated. */
interface CheckedRequirements {
  extra: {
    instrumentId: { admin: string; id: string };
    synchronizerId?: string;
    memo?: string;
  };
  /** `requirements.amount` as a ledger Decimal. */
  expectedAmount: string;
}

/**
 * Rules 9 and 6 and the transfer method: the requirements must name this
 * facilitator as fee payer, the transfer-factory method, a full instrument id
 * and an atomic amount.
 *
 * @param requirements - The merchant's payment requirements.
 * @param facilitatorParties - This facilitator's relaying parties.
 * @returns The validated fields, or the failure reason.
 */
function readRequirements(
  requirements: PaymentRequirements,
  facilitatorParties: ReadonlySet<string>,
): CheckedRequirements | { reason: CantonErrorCode } {
  const extra = (requirements.extra ?? {}) as {
    instrumentId?: { admin?: string; id?: string };
    synchronizerId?: string;
    feePayer?: string;
    memo?: string;
    assetTransferMethod?: string;
  };
  // Rule 9 — fee payer must be THIS facilitator (absent is a mismatch).
  if (typeof extra.feePayer !== "string" || !facilitatorParties.has(extra.feePayer)) {
    return { reason: "invalid_exact_canton_fee_payer_mismatch" };
  }
  // The scheme settles through the transfer factory only.
  if (extra.assetTransferMethod !== CANTON_TRANSFER_METHOD) {
    return { reason: "invalid_exact_canton_malformed_payload" };
  }
  // Rule 6 — the instrument must be pinned, both halves.
  const admin = extra.instrumentId?.admin;
  const id = extra.instrumentId?.id;
  if (
    typeof admin !== "string" ||
    admin.length === 0 ||
    typeof id !== "string" ||
    id.length === 0
  ) {
    return { reason: "invalid_exact_canton_instrument_id_mismatch" };
  }
  let expectedAmount: string;
  try {
    expectedAmount = wireAmountToLedgerDecimal(requirements.scheme, requirements.amount);
  } catch {
    return { reason: "invalid_exact_canton_amount_mismatch" };
  }
  return {
    extra: {
      instrumentId: { admin, id },
      ...(extra.synchronizerId !== undefined ? { synchronizerId: extra.synchronizerId } : {}),
      ...(typeof extra.memo === "string" ? { memo: extra.memo } : {}),
    },
    expectedAmount,
  };
}

/**
 * Whether this facilitator relays for the merchant (it pays the traffic): any
 * merchant under the open policy, else one whose preapproval it provides or one
 * on its allowlist, as the policy says.
 *
 * @param config - The facilitator's policy and allowlist.
 * @param payTo - The merchant.
 * @param provider - The provider of the merchant's preapproval, when proven.
 * @param facilitatorParties - This facilitator's relaying parties.
 * @returns Whether the merchant is served.
 */
function merchantServed(
  config: CantonSchemeConfig,
  payTo: string,
  provider: string | undefined,
  facilitatorParties: ReadonlySet<string>,
): boolean {
  const policy = config.merchantPolicy ?? "open";
  if (policy === "open") return true;
  const byProvider =
    (policy === "provider" || policy === "provider-or-allowlist") &&
    provider !== undefined &&
    facilitatorParties.has(provider);
  const byAllowlist =
    (policy === "allowlist" || policy === "provider-or-allowlist") &&
    (config.merchantAllowlist ?? []).includes(payTo);
  return byProvider || byAllowlist;
}

/**
 * Rule 10: the transfer's executeBefore must leave a safety margin and must not
 * sit further ahead than the facilitator allows.
 *
 * @param executeBeforeMs - The signed executeBefore.
 * @param nowMs - The verification time.
 * @param maxAheadSeconds - The facilitator's ceiling, if any.
 * @returns The failure reason, or undefined when the deadline is acceptable.
 */
function executeBeforeReason(
  executeBeforeMs: number,
  nowMs: number,
  maxAheadSeconds: number | undefined,
): CantonErrorCode | undefined {
  if (executeBeforeMs <= nowMs + EXECUTE_BEFORE_MARGIN_MS) return "invalid_exact_canton_expired";
  if (
    maxAheadSeconds !== undefined &&
    maxAheadSeconds > 0 &&
    executeBeforeMs > nowMs + maxAheadSeconds * 1000
  ) {
    return "invalid_exact_canton_execute_before_too_far";
  }
  return undefined;
}
