import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import * as Errors from "../errors";
import type {
  BatchSettlementPaymentRequirementsExtra,
  BatchSettlementRefundPayload,
} from "../types";
import { computeChannelId } from "../utils";
import { type BatchSettlementClientDeps, buildChannelConfig, recoverChannel } from "./channel";
import { createBatchSettlementClientHooks } from "./hooks";
import { signVoucher } from "./voucher";

/**
 * Refund-specific server errors that the client cannot recover from automatically.
 * Seeing any of these means the user should adjust their request (or accept that the
 * channel has nothing left to refund) — retrying will not help.
 */
const NON_RECOVERABLE_REFUND_ERRORS: ReadonlySet<string> = new Set([
  Errors.ErrRefundNoBalance,
  Errors.ErrRefundAmountInvalid,
]);

interface RefundRequirementsProbe {
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
}

/**
 * Caller-facing options for {@link refundChannel}.
 */
export interface RefundOptions {
  /** Token base units to refund; omit for a full refund (drains remaining balance). */
  amount?: string;
  /** Custom fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
}

/**
 * Sends a cooperative refund request to the channel that backs `url`.
 *
 * Flow:
 * 1. Probe the URL with `GET` (no payment) to obtain the route's payment requirements.
 * 2. Build the `ChannelConfig` and resolve the local session (or recover it).
 * 3. Sign a zero-charge refund voucher (`maxClaimableAmount = chargedCumulativeAmount`).
 * 4. Send the voucher via `PAYMENT-SIGNATURE`. On a corrective 402, run the
 *    standard recovery path and retry once.
 * 5. Return the parsed `SettleResponse` from the server.
 *
 * @param ctx - Identity inputs (storage, signers, salt, payerAuthorizer).
 * @param url - Any protected route on the channel to refund (the resource handler is bypassed).
 * @param options - Optional `amount` (partial refund) and `fetch` override.
 * @returns The settle response describing the refund outcome.
 * @throws When the probe fails, the receiver lacks an authorizer, or recovery fails.
 */
export async function refundChannel(
  ctx: BatchSettlementClientDeps,
  url: string,
  options?: RefundOptions,
): Promise<SettleResponse> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("refund requires a fetch implementation (globalThis.fetch unavailable)");
  }

  const refundAmount = normalizeRefundAmount(options?.amount);
  const probe = await probeRefundRequirements(url, fetchImpl);
  return executeRefund(ctx, url, probe, refundAmount, fetchImpl);
}

/**
 * Probes a URL with an unauthenticated GET to retrieve batch-settlement payment
 * requirements via the 402 PAYMENT-REQUIRED header.
 *
 * @param url - The protected URL to probe.
 * @param fetchImpl - Fetch implementation used for the probe.
 * @returns Matching batch-settlement payment requirements for the route.
 */
async function probeRefundRequirements(
  url: string,
  fetchImpl: typeof fetch,
): Promise<RefundRequirementsProbe> {
  const probe = await fetchImpl(url, { method: "GET" });
  if (probe.status !== 402) {
    throw new Error(`Refund probe expected 402, got ${probe.status}`);
  }

  const header = probe.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    throw new Error("Refund probe response missing PAYMENT-REQUIRED header");
  }

  const paymentRequired = decodePaymentRequiredHeader(header);
  const requirements = paymentRequired.accepts.find(a => a.scheme === BATCH_SETTLEMENT_SCHEME);
  if (!requirements) {
    throw new Error(`No ${BATCH_SETTLEMENT_SCHEME} payment option at ${url}`);
  }

  const extra = requirements.extra as Partial<BatchSettlementPaymentRequirementsExtra> | undefined;
  if (!extra?.receiverAuthorizer) {
    throw new Error("Refund requires a configured receiverAuthorizer on the receiver");
  }

  return { paymentRequired, requirements };
}

/**
 * Builds and submits the refund voucher, retrying once after a corrective 402.
 *
 * @param ctx - Identity inputs (storage, signers, salt, payerAuthorizer).
 * @param url - The protected URL to send the refund voucher to.
 * @param probe - Resolved payment requirements and probe metadata for this channel.
 * @param refundAmount - Optional partial refund amount in token base units.
 * @param fetchImpl - Fetch implementation used for the request.
 * @returns The parsed settle response.
 */
async function executeRefund(
  ctx: BatchSettlementClientDeps,
  url: string,
  probe: RefundRequirementsProbe,
  refundAmount: string | undefined,
  fetchImpl: typeof fetch,
): Promise<SettleResponse> {
  const maxAttempts = 2;
  const { paymentRequired, requirements } = probe;
  const httpClient = createRefundHttpClient(ctx, requirements);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const paymentPayload = await buildRefundPaymentPayload(
      ctx,
      paymentRequired,
      requirements,
      refundAmount,
    );
    const headers = httpClient.encodePaymentSignatureHeader(paymentPayload);

    const response = await fetchImpl(url, { method: "GET", headers });

    if (response.status === 402) {
      const nonRecoverable = getNonRecoverableRefundFailure(response);
      if (nonRecoverable) {
        throw new Error(nonRecoverable);
      }
    }

    const result = await httpClient.processPaymentResult(
      paymentPayload,
      name => response.headers.get(name),
      response.status,
    );

    if (response.status === 402) {
      if (result.recovered && attempt < maxAttempts) {
        continue;
      }
      if (result.recovered) {
        throw new Error(`Refund failed: server returned 402 after ${attempt} attempt(s)`);
      }

      const corrective = getRefundPaymentRequired(response);
      throw new Error(`Refund failed: ${corrective.error ?? "unknown"}`);
    }

    if (!result.settleResponse) {
      throw new Error(
        `Refund response missing PAYMENT-RESPONSE header (status ${response.status})`,
      );
    }

    return result.settleResponse;
  }

  throw new Error("Refund failed: retry budget exhausted");
}

/**
 * Builds the refund payload with a zero-charge `maxClaimableAmount`.
 *
 * @param ctx - Identity inputs (storage, signers, salt, payerAuthorizer).
 * @param paymentRequired - Decoded 402 body from the probe (resource, extensions, etc.).
 * @param requirements - Resolved payment requirements for the channel.
 * @param refundAmount - Optional partial refund amount in token base units.
 * @returns A full payment payload wrapping the signed refund request.
 */
async function buildRefundPaymentPayload(
  ctx: BatchSettlementClientDeps,
  paymentRequired: PaymentRequired,
  requirements: PaymentRequirements,
  refundAmount: string | undefined,
): Promise<PaymentPayload> {
  const config = buildChannelConfig(ctx, requirements);
  const channelId = computeChannelId(config, requirements.network);
  const key = channelId.toLowerCase();

  let channel = await ctx.storage.get(key);
  if (channel === undefined && ctx.signer.readContract) {
    channel = await recoverChannel(ctx, requirements);
  }
  if (channel === undefined) {
    throw new Error(
      "Refund requires an existing channel record; deposit first or call from a context with an EVM RPC",
    );
  }

  // Avoid a refund request when local state shows the channel has no refundable balance.
  const charged = channel.chargedCumulativeAmount ?? "0";
  if (channel.balance !== undefined && BigInt(channel.balance) <= BigInt(charged)) {
    throw new Error(
      `Refund failed: channel has no remaining balance (balance=${channel.balance}, chargedCumulativeAmount=${charged})`,
    );
  }

  const voucherSigner = ctx.voucherSigner ?? ctx.signer;
  const voucher = await signVoucher(voucherSigner, channelId, charged, requirements.network);

  const payload: BatchSettlementRefundPayload = {
    type: "refund",
    channelConfig: config,
    voucher,
    ...(refundAmount !== undefined ? { amount: refundAmount } : {}),
  };

  return {
    x402Version: 2,
    accepted: requirements,
    payload: payload as unknown as Record<string, unknown>,
    ...(paymentRequired.resource ? { resource: paymentRequired.resource } : {}),
    ...(paymentRequired.extensions ? { extensions: paymentRequired.extensions } : {}),
  };
}

/**
 * Creates an x402 HTTP client for batch settlement with hooks; refund payloads are supplied
 * by {@link refundChannel} instead of the default payment builder.
 *
 * @param ctx - Identity inputs (storage, signers, salt, payerAuthorizer).
 * @param requirements - Resolved payment requirements for the channel network.
 * @returns An `x402HTTPClient` wired for batch-settlement scheme hooks.
 */
function createRefundHttpClient(
  ctx: BatchSettlementClientDeps,
  requirements: PaymentRequirements,
): x402HTTPClient {
  const client = new x402Client().register(requirements.network, {
    scheme: BATCH_SETTLEMENT_SCHEME,
    schemeHooks: createBatchSettlementClientHooks(ctx),
    createPaymentPayload: async () => {
      throw new Error("Refund payloads are built by refundChannel");
    },
  });
  return new x402HTTPClient(client);
}

/**
 * If the refund HTTP response cannot be recovered by retrying, returns a user-facing message;
 * otherwise returns `undefined`.
 *
 * @param response - The refund request response (402 with headers or settle failure).
 * @returns A formatted failure string, or `undefined` when retry may succeed.
 */
function getNonRecoverableRefundFailure(response: Response): string | undefined {
  const settleHeader = response.headers.get("PAYMENT-RESPONSE");
  if (settleHeader) {
    return formatRefundFailure(decodePaymentResponseHeader(settleHeader));
  }

  const paymentRequired = getRefundPaymentRequired(response);
  const errorCode = paymentRequired.error;
  if (errorCode && NON_RECOVERABLE_REFUND_ERRORS.has(errorCode)) {
    return `Refund failed: ${errorCode}`;
  }
}

/**
 * Reads and decodes the `PAYMENT-REQUIRED` header from a refund-related 402 response.
 *
 * @param response - HTTP response that must include `PAYMENT-REQUIRED`.
 * @returns The decoded {@link PaymentRequired} payload.
 * @throws When the header is missing.
 */
function getRefundPaymentRequired(response: Response): PaymentRequired {
  const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) {
    throw new Error("Refund 402 missing PAYMENT-REQUIRED header");
  }
  return decodePaymentRequiredHeader(requiredHeader);
}

/**
 * Builds a human-readable error message from a settle failure response.
 *
 * @param settle - The decoded SettleResponse from the server's 402 reply.
 * @returns A formatted error string suitable for `throw new Error(...)`.
 */
function formatRefundFailure(settle: SettleResponse): string {
  const reason = settle.errorReason ?? "unknown_settlement_error";
  const message = settle.errorMessage;
  if (message && message !== reason) {
    return `Refund failed: ${reason}: ${message}`;
  }
  return `Refund failed: ${reason}`;
}

/**
 * Validates and normalises the optional `refundAmount` argument.
 *
 * @param amount - Raw amount from caller (string of base units).
 * @returns The same string when valid, or `undefined` when omitted.
 */
function normalizeRefundAmount(amount: string | undefined): string | undefined {
  if (amount === undefined) return undefined;
  if (!/^\d+$/.test(amount) || amount === "0") {
    throw new Error(`Invalid refund amount "${amount}": must be a positive integer string`);
  }
  return amount;
}
