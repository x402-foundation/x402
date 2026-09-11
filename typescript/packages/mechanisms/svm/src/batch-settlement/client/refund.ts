/** Driving a payer-forced channel close over HTTP. */

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";

import { BATCH_SETTLEMENT_SCHEME } from "../types";

/** Caller-facing options for a refund. */
export interface BatchRefundOptions {
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch | undefined;
  /** Requirements to refund against; probed from `url` when omitted. */
  requirements?: PaymentRequirements | undefined;
}

/** Builds the payer-signed close payload for a set of requirements. */
export type RefundPayloadBuilder = (
  x402Version: number,
  requirements: PaymentRequirements,
) => Promise<{ x402Version: number; payload: unknown }>;

/**
 * Probe a protected route for the requirements its channel was opened against.
 *
 * A refund needs the same `feePayer`, asset and `withdrawDelay` the channel was
 * derived from, and an unpaid `GET` is what advertises them.
 *
 * @param url - A protected route on the channel's server
 * @param fetchImpl - Fetch implementation to probe with
 * @returns The advertised batch-settlement requirements and x402 version
 */
export async function probeBatchRequirements(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ x402Version: number; requirements: PaymentRequirements }> {
  const probe = await fetchImpl(url, { method: "GET" });
  if (probe.status !== 402) {
    throw new Error(`refund probe expected 402 from ${url}, got ${probe.status}`);
  }
  const header = probe.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("refund probe response has no PAYMENT-REQUIRED header");
  const paymentRequired = decodePaymentRequiredHeader(header);
  const requirements = paymentRequired.accepts.find(
    accept => accept.scheme === BATCH_SETTLEMENT_SCHEME,
  );
  if (!requirements) throw new Error(`${url} does not offer ${BATCH_SETTLEMENT_SCHEME}`);
  return { requirements, x402Version: paymentRequired.x402Version };
}

/**
 * Start the payer-forced close of the channel backing `url`.
 *
 * The escrow does not come back with this response: `request_close` begins the
 * forced-close grace period, after which the unused deposit is returned. The
 * scheme has no partial refund — the program returns all unused escrow or
 * nothing — so this takes no amount.
 *
 * Unlike a paid request there is nothing to retry against a corrective 402: a
 * close carries no cumulative amount to resynchronize.
 *
 * @param build - Builds the payer-signed close payload
 * @param url - Any protected route on the channel to close
 * @param options - Fetch override, or requirements to skip the probe
 * @returns The settlement response describing the initiated close
 */
export async function refundBatchChannel(
  build: RefundPayloadBuilder,
  url: string,
  options?: BatchRefundOptions,
): Promise<SettleResponse> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("refund requires a fetch implementation (globalThis.fetch unavailable)");
  }
  const probed = options?.requirements
    ? { requirements: options.requirements, x402Version: 2 }
    : await probeBatchRequirements(url, fetchImpl);

  const payload = await build(probed.x402Version, probed.requirements);
  const response = await fetchImpl(url, {
    headers: {
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
        accepted: probed.requirements,
        payload: payload.payload as never,
        x402Version: payload.x402Version,
      }),
    },
    method: "GET",
  });

  const settled = response.headers.get("PAYMENT-RESPONSE");
  if (!settled) {
    if (response.status === 402) {
      const header = response.headers.get("PAYMENT-REQUIRED");
      const reason = header ? decodePaymentRequiredHeader(header).error : undefined;
      throw new Error(`refund refused: ${reason ?? "no reason given"}`);
    }
    throw new Error(`refund response has no PAYMENT-RESPONSE header (status ${response.status})`);
  }
  return decodePaymentResponseHeader(settled);
}
