import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { bech32, utils as scure } from "@scure/base";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { httpRequestBinding, mcpToolCallBinding, type RequestBinding } from "../../src/binding";
import { LNBTC_MAINNET } from "../../src/constants";

/** Test-only secp256k1 key from the specification vectors. */
export const RECEIVER_KEY = hexToBytes(
  "0000000000000000000000000000000000000000000000000000000000000001",
);
export const RECEIVER_PUBKEY = bytesToHex(secp256k1.getPublicKey(RECEIVER_KEY, true));
export const OTHER_KEY = hexToBytes(
  "0000000000000000000000000000000000000000000000000000000000000002",
);

export const SPEC_TIME = 1_700_000_000;
export const SPEC_PREIMAGE = "0001020304050607080900010203040506070809000102030405060708090102";
export const SPEC_INVOICE =
  "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f";
export const HTTP_A_HASH = "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018";
export const HTTP_B_HASH = "4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509";
export const MCP_A_HASH = "03941bfedc6af8a09b2f459fe83470284a76a8c75801caa9e1487a9276a693f4";

export interface InvoiceSpec {
  currency?: string;
  amountMsat?: bigint | null;
  timestamp?: number;
  preimage?: string;
  paymentSecret?: string;
  descriptionHash?: string | null;
  description?: string;
  expiry?: number | null;
  minFinalCltv?: number;
  payeeField?: boolean;
  key?: Uint8Array;
  extraPaymentHash?: boolean;
  /** Raw `p` field words; `null` omits the payment hash. */
  paymentHashWords?: number[] | null;
  omitPaymentSecret?: boolean;
  unknownField?: boolean;
  /** Overrides the whole human-readable prefix (amount and currency). */
  hrp?: string;
  /** Raw `x` field words, replacing the minimal encoding of `expiry`. */
  expiryWords?: number[];
  /** Raw `c` field words, replacing the minimal encoding of `minFinalCltv`. */
  minFinalCltvWords?: number[];
  /** Raw `9` (features) field words. */
  featureWords?: number[];
  /** Extra raw tagged fields appended after the standard ones, as [tag, words]. */
  rawFields?: [number, number[]][];
  /** Raw words appended after the tagged fields (may be a malformed field). */
  trailingWords?: number[];
  /** Emit the high-S form of the signature (and the matching recovery id). */
  highS?: boolean;
  /** Overrides the recovery id byte. */
  recovery?: number;
}

/**
 * Signs a BOLT11 invoice. Field order p, s, h/d, x, c matches the spec vector.
 *
 * @param spec - Invoice contents
 * @returns The invoice and its payment hash
 */
export function makeInvoice(spec: InvoiceSpec = {}): { invoice: string; paymentHash: string } {
  const key = spec.key ?? RECEIVER_KEY;
  const preimage = spec.preimage ?? SPEC_PREIMAGE;
  const paymentHash = bytesToHex(sha256(hexToBytes(preimage)));
  const amount = spec.amountMsat === undefined ? 25_000n : spec.amountMsat;
  const hrp =
    spec.hrp ?? `ln${spec.currency ?? "bc"}${amount === null ? "" : encodeAmount(amount)}`;

  const words: number[] = [...numberToWords(spec.timestamp ?? SPEC_TIME, 7)];
  const field = (tag: number, data: number[]) =>
    words.push(tag, Math.floor(data.length / 32), data.length % 32, ...data);
  if (spec.paymentHashWords !== null) {
    field(1, spec.paymentHashWords ?? bech32.toWords(hexToBytes(paymentHash)));
  }
  if (spec.extraPaymentHash) field(1, bech32.toWords(sha256(Uint8Array.of(9))));
  if (!spec.omitPaymentSecret) {
    field(16, bech32.toWords(hexToBytes(spec.paymentSecret ?? "11".repeat(32))));
  }
  if (spec.description !== undefined) {
    field(13, bech32.toWords(new TextEncoder().encode(spec.description)));
  }
  const descriptionHash = spec.descriptionHash === undefined ? HTTP_A_HASH : spec.descriptionHash;
  if (descriptionHash !== null) field(23, bech32.toWords(hexToBytes(descriptionHash)));
  if (spec.payeeField) field(19, bech32.toWords(secp256k1.getPublicKey(key, true)));
  const expiry = spec.expiry === undefined ? 300 : spec.expiry;
  if (spec.expiryWords) field(6, spec.expiryWords);
  else if (expiry !== null) field(6, minimalWords(expiry));
  field(24, spec.minFinalCltvWords ?? minimalWords(spec.minFinalCltv ?? 18));
  if (spec.featureWords) field(5, spec.featureWords);
  if (spec.unknownField) field(31, [1, 2, 3]);
  for (const [tag, data] of spec.rawFields ?? []) field(tag, data);
  if (spec.trailingWords) words.push(...spec.trailingWords);

  const data = Uint8Array.from(scure.convertRadix2(words, 5, 8, true));
  const message = new Uint8Array([...new TextEncoder().encode(hrp), ...data]);
  const signed = secp256k1.sign(sha256(message), key);
  const signature = spec.highS
    ? new secp256k1.Signature(signed.r, secp256k1.CURVE.n - signed.s, signed.recovery ^ 1)
    : signed;
  const sigBytes = new Uint8Array([
    ...signature.toCompactRawBytes(),
    spec.recovery ?? (signature.recovery as number),
  ]);
  const invoice = bech32.encode(hrp, [...words, ...bech32.toWords(sigBytes)], false);
  return { invoice, paymentHash };
}

/**
 * Encodes an msat amount with the shortest BOLT11 multiplier.
 *
 * @param msat - Amount in millisatoshis
 * @returns The amount part of the human-readable prefix
 */
function encodeAmount(msat: bigint): string {
  if (msat % 100_000_000_000n === 0n) return `${msat / 100_000_000_000n}`;
  if (msat % 100_000_000n === 0n) return `${msat / 100_000_000n}m`;
  if (msat % 100_000n === 0n) return `${msat / 100_000n}u`;
  if (msat % 100n === 0n) return `${msat / 100n}n`;
  return `${msat * 10n}p`;
}

/**
 * Big-endian 5-bit words of fixed length.
 *
 * @param value - Integer
 * @param length - Word count
 * @returns Words
 */
function numberToWords(value: number, length: number): number[] {
  const out: number[] = [];
  for (let i = length - 1; i >= 0; i--) out.push(Math.floor(value / 32 ** i) % 32);
  return out;
}

/**
 * Minimal big-endian 5-bit words.
 *
 * @param value - Non-negative integer
 * @returns Words without leading zeros
 */
function minimalWords(value: number): number[] {
  const out: number[] = [];
  do {
    out.unshift(value % 32);
    value = Math.floor(value / 32);
  } while (value > 0);
  return out;
}

/**
 * The spec's HTTP binding for `GET https://api.example.com/article/<id>`.
 *
 * @param article - Article id
 * @param overrides - Method and body overrides
 * @param overrides.method - HTTP method
 * @param overrides.body - Body bytes
 * @returns The binding
 */
export function httpArticle(
  article = "A",
  overrides: { method?: string; body?: Uint8Array } = {},
): RequestBinding {
  return httpRequestBinding({
    method: overrides.method ?? "GET",
    url: `https://api.example.com/article/${article}`,
    body: overrides.body,
    boundHeaders: [],
    getHeader: () => undefined,
  });
}

/**
 * The spec's MCP binding for `get_article`.
 *
 * @param article - Article id
 * @returns The binding
 */
export function mcpArticle(article = "A"): RequestBinding {
  return mcpToolCallBinding({
    server: "https://api.example.com/mcp",
    name: "get_article",
    arguments: { article },
    boundMetadata: [],
  });
}

/**
 * Requirements for a binding and invoice, defaulting to the spec example.
 *
 * @param binding - Request binding
 * @param invoice - Invoice text
 * @returns Payment requirements
 */
export function requirementsFor(
  binding: RequestBinding = httpArticle(),
  invoice: string = SPEC_INVOICE,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: LNBTC_MAINNET,
    amount: "25000",
    asset: "BTC",
    payTo: RECEIVER_PUBKEY,
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: "bolt11",
      paymentFlow: "upfront",
      requestHash: binding.requestHash,
      requestBindingProfile: binding.requestBindingProfile,
      requestBindingParams: binding.requestBindingParams,
      invoice,
    },
  };
}

/**
 * A payment payload accepting the given requirements.
 *
 * @param accepted - Accepted requirements
 * @param preimage - Preimage
 * @returns Payment payload
 */
export function payloadFor(
  accepted: PaymentRequirements = requirementsFor(),
  preimage: string = SPEC_PREIMAGE,
): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/article/A" },
    accepted: structuredClone(accepted),
    payload: { preimage },
  };
}
