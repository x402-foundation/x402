/**
 * Inline transfer-factory VERIFY — the money-critical validation, ported from the
 * FTP facilitator's proven implementation and adapted to the `@x402/core` wire
 * types + the injected `FacilitatorCantonSigner`. Never submits; never mutates.
 *
 * The payer signs a relay-prepared `TransferFactory_Transfer` and carries it
 * inline. This proves, from the SIGNED bytes alone: the proven payer (act_as),
 * amount/receiver/instrument/synchronizer/memo, single-root-exercise, input
 * holdings, the deadline, and the Ed25519 signature — then confirms the merchant
 * holds a live preapproval (Amulet) or the transfer resolves `direct` (registry).
 */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
  decodePrepared,
  extractTransfer,
} from "../../prepared-transfer.js";
import { decodeInlinePaymentPayload, InlinePayloadError } from "../../inline-payload.js";
import { wireAmountToLedgerDecimal } from "../../amount.js";
import type { CantonErrorCode } from "../../types.js";
import type { FacilitatorCantonSigner, CantonSchemeConfig } from "../../signer.js";

const EXECUTE_BEFORE_MARGIN_MS = 5_000;

export interface InlineVerifyResult {
  ok: boolean;
  reason?: CantonErrorCode;
  payer: string;
  preparedTransactionBytes?: Buffer;
  signatureB64?: string;
  hashingSchemeVersion?: "HASHING_SCHEME_VERSION_V1" | "HASHING_SCHEME_VERSION_V2";
  preparedTxHashHex?: string;
  publishedProtocolKeys?: number;
}

const fail = (reason: CantonErrorCode, payer = ""): InlineVerifyResult => ({
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
 * Ledger Decimal ("0.0100000000") → atomic units (1 CC = 1e10), exact.
 *
 * @param value
 */
function ledgerDecimalToAtomic(value: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > 10) return null;
  return BigInt(whole + frac.padEnd(10, "0"));
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
  config: CantonSchemeConfig = {},
  nowMsOverride?: number,
): Promise<InlineVerifyResult> {
  const facilitatorParties = new Set(signer.getAddresses());

  // Rule 2 — decode within the scheme's bounds (single-gzip framing + caps).
  let decoded;
  try {
    decoded = decodeInlinePaymentPayload(payload.payload);
  } catch (err) {
    if (err instanceof InlinePayloadError) return fail(err.code as CantonErrorCode);
    return fail("invalid_exact_canton_malformed_payload");
  }

  const preparedB64 = decoded.preparedTransactionBytes.toString("base64");

  // Rule 8 — the proven payer, read from the SIGNED metadata (single act_as).
  let payer: string;
  try {
    const pt = decodePrepared(preparedB64);
    if (pt.actAs.length !== 1 || !pt.actAs[0]) {
      return fail("invalid_exact_canton_malformed_payload");
    }
    payer = pt.actAs[0];
  } catch {
    return fail("invalid_exact_canton_malformed_payload");
  }

  // Rule 11 — self-payment guard.
  if (facilitatorParties.has(payer)) {
    return fail("invalid_exact_canton_self_payment", payer);
  }

  const extra = (requirements.extra ?? {}) as {
    instrumentId?: { admin?: string; id?: string };
    synchronizerId?: string;
    feePayer?: string;
    memo?: string;
  };

  // Rule 9 — fee payer must be THIS facilitator (absent is a mismatch).
  if (typeof extra.feePayer !== "string" || !facilitatorParties.has(extra.feePayer)) {
    return fail("invalid_exact_canton_fee_payer_mismatch", payer);
  }

  // Rule 6 — the instrument must be pinned, both halves.
  if (
    typeof extra.instrumentId?.admin !== "string" ||
    extra.instrumentId.admin.length === 0 ||
    typeof extra.instrumentId.id !== "string" ||
    extra.instrumentId.id.length === 0
  ) {
    return fail("invalid_exact_canton_instrument_id_mismatch", payer);
  }

  // Rules 4/5/6 — amount/receiver/instrument/synchronizer/memo + single-root
  // exercise, proven from the signed bytes.
  let expectedAmount: string;
  try {
    expectedAmount = wireAmountToLedgerDecimal(requirements.scheme, requirements.amount);
  } catch {
    return fail("invalid_exact_canton_amount_mismatch", payer);
  }

  let declaredInputs: string[];
  let declaredExecuteBefore: number | undefined;
  let registryDirectDelivery = false;
  try {
    assertPreparedTransferMatches(preparedB64, {
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
      ...(extra.synchronizerId !== undefined ? { synchronizerId: extra.synchronizerId } : {}),
      ...(typeof extra.memo === "string" && extra.memo.length > 0 ? { memo: extra.memo } : {}),
      ...(nowMsOverride !== undefined ? { nowMs: nowMsOverride } : {}),
    });
    const pt = decodePrepared(preparedB64);
    const ex = pt.exercises.find(e => /TransferFactory_Transfer/.test(e.choiceId));
    const t = ex?.chosenValue ? extractTransfer(ex.chosenValue) : undefined;
    declaredInputs = t?.inputHoldingCids ?? [];
    declaredExecuteBefore = t?.executeBeforeMs;
    registryDirectDelivery = pt.exercises.some(
      e =>
        e.choiceId === "TransferRule_DirectTransfer" &&
        e.templateQualifiedName === "Utility.Registry.V0.Rule.Transfer:TransferRule",
    );
  } catch (err) {
    if (err instanceof PreparedTransferMismatchError) {
      return fail(classifyMismatch(err.message), payer);
    }
    return fail("invalid_exact_canton_malformed_payload", payer);
  }

  // Rule 7 — merchant must hold a live preapproval (Amulet), or the registry
  // transfer must resolve `direct` (read structurally from the signed bytes).
  const utilRegistry = config.tokenRegistries?.[extra.instrumentId.admin];
  if (utilRegistry) {
    if (!registryDirectDelivery) {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    const policy = config.merchantPolicy ?? "open";
    if (policy !== "open") {
      const byAllowlist =
        (policy === "allowlist" || policy === "provider-or-allowlist") &&
        (config.merchantAllowlist ?? []).includes(requirements.payTo);
      if (!byAllowlist) {
        return fail("invalid_exact_canton_merchant_not_registered", payer);
      }
    }
  } else {
    let pre;
    try {
      pre = await signer.fetchPreapproval(requirements.payTo);
    } catch {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    if (!pre) return fail("invalid_exact_canton_preapproval_missing", payer);
    // Bind it: right receiver + right instrument admin.
    if (pre.receiver !== requirements.payTo || pre.dso !== extra.instrumentId.admin) {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
    const policy = config.merchantPolicy ?? "open";
    if (policy !== "open") {
      const byProvider =
        (policy === "provider" || policy === "provider-or-allowlist") &&
        pre.provider !== undefined &&
        facilitatorParties.has(pre.provider);
      const byAllowlist =
        (policy === "allowlist" || policy === "provider-or-allowlist") &&
        (config.merchantAllowlist ?? []).includes(requirements.payTo);
      if (!byProvider && !byAllowlist) {
        return fail("invalid_exact_canton_merchant_not_registered", payer);
      }
    }
    if (pre.validFrom !== undefined) {
      const fromMs = Date.parse(pre.validFrom);
      if (!Number.isFinite(fromMs) || fromMs > (nowMsOverride ?? Date.now())) {
        return fail("invalid_exact_canton_preapproval_missing", payer);
      }
    }
    const expiryMs = Date.parse(pre.expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= (nowMsOverride ?? Date.now())) {
      return fail("invalid_exact_canton_preapproval_missing", payer);
    }
  }

  // Rule 10 — deadline (floor + ceiling).
  if (declaredExecuteBefore === undefined) {
    return fail("invalid_exact_canton_expired", payer);
  }
  const nowMs = nowMsOverride ?? Date.now();
  if (declaredExecuteBefore <= nowMs + EXECUTE_BEFORE_MARGIN_MS) {
    return fail("invalid_exact_canton_expired", payer);
  }
  const maxAhead = config.maxExecuteBeforeSeconds;
  if (maxAhead !== undefined && maxAhead > 0 && declaredExecuteBefore > nowMs + maxAhead * 1000) {
    return fail("invalid_exact_canton_execute_before_too_far", payer);
  }

  // Rule 13, second half — declared inputs must cover the amount, IF this
  // facilitator has an authoritative view of the payer's holdings.
  let owned: Map<string, string> | undefined;
  try {
    owned = signer.fetchOwnedHoldingAmounts
      ? await signer.fetchOwnedHoldingAmounts(payer)
      : undefined;
  } catch {
    owned = undefined;
  }
  const authoritative = owned !== undefined && declaredInputs.every(cid => owned!.has(cid));
  if (authoritative && owned) {
    let total = 0n;
    for (const cid of declaredInputs) {
      const units = ledgerDecimalToAtomic(owned.get(cid) ?? "");
      if (units === null) return fail("invalid_exact_canton_insufficient_inputs", payer);
      total += units;
    }
    const needed = ledgerDecimalToAtomic(expectedAmount);
    if (needed === null || total < needed) {
      return fail("invalid_exact_canton_insufficient_inputs", payer);
    }
  }

  // Rule 3 — signature, LAST and fail-closed.
  let proof: {
    verified: boolean;
    preparedTxHashHex?: string;
    publishedProtocolKeys?: number;
  } = { verified: false };
  try {
    proof = await signer.verifySignature({
      preparedTransactionBytes: decoded.preparedTransactionBytes,
      claimedPreparedTxHash: decoded.claimedPreparedTxHash,
      signatureB64: decoded.signatureB64,
      payer,
      hashingSchemeVersion: decoded.hashingSchemeVersion,
    });
  } catch {
    proof = { verified: false };
  }
  if (!proof.verified) {
    return fail("invalid_exact_canton_signature_invalid", payer);
  }

  return {
    ok: true,
    payer,
    preparedTransactionBytes: decoded.preparedTransactionBytes,
    signatureB64: decoded.signatureB64,
    hashingSchemeVersion: decoded.hashingSchemeVersion,
    ...(proof.publishedProtocolKeys !== undefined
      ? { publishedProtocolKeys: proof.publishedProtocolKeys }
      : {}),
    ...(proof.preparedTxHashHex !== undefined
      ? { preparedTxHashHex: proof.preparedTxHashHex }
      : {}),
  };
}
