import { createHash } from "crypto";

/**
 * Selected accepted payment terms used as replay-context material.
 */
export type PaymentRequirementsLike = {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  pay_to?: string;
  maxTimeoutSeconds?: number;
  max_timeout_seconds?: number;
  extra?: unknown;
};

/**
 * 402 payment-required payload offering one or more accepted terms.
 */
export type PaymentRequiredLike = {
  accepts?: PaymentRequirementsLike[];
};

/**
 * In-memory captured payment header bound to one immutable target URL.
 */
export type CapturedExactHeader = {
  headers?: Record<string, string>;
  url?: string;
  terms?: string;
};

/**
 * x402Client surface used to capture the encoded header after signing.
 */
export type ExactHeaderReplayClient = {
  onAfterPaymentCreation(
    hook: (context: {
      paymentPayload: object;
      selectedRequirements: PaymentRequirementsLike;
    }) => Promise<void>,
  ): unknown;
};

/**
 * x402HTTPClient surface used to encode and conditionally replay the header.
 */
export type ExactHeaderReplayHttpClient = {
  encodePaymentSignatureHeader(paymentPayload: object): Record<string, string>;
  onPaymentRequired(
    hook: (context: {
      paymentRequired: PaymentRequiredLike;
      requestUrl: string;
    }) => Promise<{ headers: Record<string, string> } | void>,
  ): unknown;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

/**
 * SHA-256 fingerprint of selected accepted payment terms.
 *
 * Covers scheme, network, asset, amount, payTo, normalized maxTimeoutSeconds,
 * and recursively canonical extra. Used only as a replay-context key.
 *
 * @param requirements - Selected or offered accepted payment terms
 * @returns Hex digest of the canonical terms material
 */
export function acceptedTermsFingerprint(
  requirements: PaymentRequirementsLike | null | undefined,
): string {
  const terms = requirements ?? {};
  const extra = terms.extra;
  const timeout = terms.maxTimeoutSeconds ?? terms.max_timeout_seconds;
  const material = {
    amount: String(terms.amount ?? ""),
    asset: String(terms.asset ?? ""),
    extra: extra === undefined || extra === null ? "{}" : canonicalJson(extra),
    maxTimeoutSeconds: timeout === undefined || timeout === null ? "" : String(timeout),
    network: String(terms.network ?? ""),
    payTo: String(terms.payTo ?? terms.pay_to ?? ""),
    scheme: String(terms.scheme ?? ""),
  };
  const keys = Object.keys(material).sort();
  return createHash("sha256").update(JSON.stringify(material, keys)).digest("hex");
}

const acceptsIncludeTerms = (paymentRequired: PaymentRequiredLike, terms: string): boolean => {
  const accepts = paymentRequired.accepts ?? [];
  return accepts.some(item => acceptedTermsFingerprint(item) === terms);
};

/**
 * Return captured headers only when the 402 matches the exact captured context.
 *
 * Both the request URL string and the selected accepted-terms fingerprint must
 * match. A different origin, path, query, or accepted offer does not replay.
 *
 * @param captured - Previously captured header and context
 * @param requestUrl - Exact 402 request URL from the HTTP client
 * @param paymentRequired - Later 402 payment-required body
 * @returns Captured headers when both context components match
 */
export function replayHeadersIfExactContext(
  captured: CapturedExactHeader,
  requestUrl: string,
  paymentRequired: PaymentRequiredLike,
): Record<string, string> | undefined {
  const headers = captured.headers;
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }
  if (requestUrl !== captured.url) {
    return undefined;
  }
  const terms = captured.terms;
  if (!terms || !acceptsIncludeTerms(paymentRequired, terms)) {
    return undefined;
  }
  return headers;
}

/**
 * Capture the first encoded payment header for one exact target URL.
 *
 * `targetUrl` is immutable configuration. PaymentCreatedContext has no request
 * URL, so a shared mutable pendingUrl cannot correlate concurrent 402s. This
 * helper is an educational sequential-retry client for that one URL. A 402 for
 * any other origin, path, or query before capture poisons capture (fail
 * closed): the credential is not stored and is not replayed. Replay still
 * requires an exact URL string match and matching selected accepted terms.
 * Never replays cross-origin, cross-path, across query drift, or against
 * different accepted terms. Does not print or persist the header.
 *
 * @param client - x402Client used to observe payload creation
 * @param httpClient - x402HTTPClient used to encode and replay headers
 * @param targetUrl - Exact request URL this helper may capture and replay
 * @returns Mutable captured context; header bytes stay in memory only
 */
export function configureExactHeaderReplay(
  client: ExactHeaderReplayClient,
  httpClient: ExactHeaderReplayHttpClient,
  targetUrl: string,
): CapturedExactHeader {
  const captured: CapturedExactHeader = { url: targetUrl };
  let sawTargetRequired = false;
  let sawForeignRequired = false;

  client.onAfterPaymentCreation(async ({ paymentPayload, selectedRequirements }) => {
    if (captured.headers || !targetUrl || !sawTargetRequired || sawForeignRequired) {
      return;
    }
    captured.headers = { ...httpClient.encodePaymentSignatureHeader(paymentPayload) };
    captured.terms = acceptedTermsFingerprint(selectedRequirements);
  });

  httpClient.onPaymentRequired(async ({ paymentRequired, requestUrl }) => {
    if (requestUrl !== targetUrl) {
      if (!captured.headers) {
        sawForeignRequired = true;
      }
      return;
    }
    const replayed = replayHeadersIfExactContext(captured, requestUrl, paymentRequired);
    if (replayed) {
      return { headers: replayed };
    }
    if (!captured.headers || Object.keys(captured.headers).length === 0) {
      sawTargetRequired = true;
    }
    return;
  });

  return captured;
}
