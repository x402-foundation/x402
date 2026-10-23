import type { MasumiInputCommitment } from "../../types";
import {
  CARDANO_REQUEST_COMMITMENT,
  buildHttpBinding,
  buildRequestCommitment,
  commitmentMismatch,
  randomSalt,
  validateBoundHeaders,
  validateSalt,
  type HttpRequestDescription,
} from "./binding";
import { readRequestCommitment } from "./transaction";

/** Supplies the request being paid for. */
export type RequestCommitmentRequestProvider = () =>
  | HttpRequestDescription
  | Promise<HttpRequestDescription>;

/**
 * Supplies the 32-byte salt (64 lowercase hex characters) for one payment.
 * Defaults to fresh random bytes. Every payment MUST use a new salt; reusing
 * one makes payments for the same request linkable on-chain again.
 */
export type RequestCommitmentSaltSource = () => string | Promise<string>;

/** What the client commits to: the on-chain digest and the salt it discloses. */
export interface ResolvedRequestCommitment {
  profile: string;
  /** Lowercase hex of the salted commitment digest signed into the transaction. */
  hash: string;
  /** The salt, disclosed to the resource server in the payment payload. */
  salt: string;
}

/**
 * Decides what commitment, if any, the client embeds.
 *
 * The client never signs a digest it has not recomputed from its own request:
 * - no declaration → nothing;
 * - declaration but no request provider → refuse if required, otherwise pay without;
 * - declared commitment that differs from the client's request → refuse, always.
 *
 * When it embeds one, the on-chain digest is the declared request commitment
 * extended with a fresh `salt` part, so the chain reveals nothing about the
 * request and two payments for the same request do not share a digest.
 *
 * @param extensions - `PaymentRequired.extensions` as passed to the scheme.
 * @param provider - The client's view of the request, if configured.
 * @param saltSource - Salt for this payment; fresh random bytes by default.
 * @returns The commitment to embed and the salt to disclose, or undefined.
 * @throws When the commitment is required but cannot be honored, or does not match.
 */
export async function resolveClientRequestCommitment(
  extensions: Record<string, unknown> | undefined,
  provider: RequestCommitmentRequestProvider | undefined,
  saltSource?: RequestCommitmentSaltSource,
): Promise<ResolvedRequestCommitment | undefined> {
  const declaration = extensions?.[CARDANO_REQUEST_COMMITMENT] as
    | { info?: Record<string, unknown> }
    | undefined;
  if (declaration === undefined) return undefined;

  const info = declaration.info ?? {};
  const required = info.required === true;
  if (info.profile !== "http:1") {
    throw new Error(`Unsupported request commitment profile ${JSON.stringify(info.profile)}`);
  }
  const headers = validateBoundHeaders(
    ((info.bindingParams as { headers?: unknown } | undefined)?.headers as string[]) ?? [],
  );
  const commitment = info.commitment as MasumiInputCommitment | undefined;
  if (!commitment || typeof commitment !== "object") {
    // The server could not compute a commitment for this request.
    if (required) throw new Error("Route requires a request commitment but declared none");
    return undefined;
  }

  if (!provider) {
    if (required) {
      throw new Error("Route requires a request commitment but no request provider is configured");
    }
    return undefined;
  }

  const binding = buildHttpBinding(await provider(), headers);
  const mismatch = commitmentMismatch(commitment, binding);
  if (mismatch) throw new Error(`Refusing to pay: ${mismatch}`);
  const salt = validateSalt(saltSource ? await saltSource() : randomSalt());
  return { profile: "http:1", hash: buildRequestCommitment(binding, salt).digest, salt };
}

/**
 * The payment payload extension that discloses the salt to the resource server.
 *
 * @param commitment - The resolved commitment.
 * @returns The `extensions` entry to merge into the payment payload.
 */
export function requestCommitmentPayloadExtension(commitment: ResolvedRequestCommitment) {
  return { [CARDANO_REQUEST_COMMITMENT]: { info: { salt: commitment.salt } } };
}

/**
 * Confirms a signer actually embedded the commitment it was asked to embed.
 * A signer that ignores the request would otherwise drop the binding silently.
 *
 * @param transactionBase64 - The signed transaction.
 * @param expected - The commitment the signer was asked to embed.
 * @param expected.profile - Request binding profile.
 * @param expected.hash - Lowercase hex digest.
 * @throws When the transaction does not carry exactly that commitment.
 */
export function assertCommitmentEmbedded(
  transactionBase64: string,
  expected: { profile: string; hash: string },
): void {
  const found = readRequestCommitment(transactionBase64);
  if (
    found.status !== "present" ||
    found.metadatum.profile !== expected.profile ||
    found.metadatum.hash !== expected.hash
  ) {
    throw new Error(
      `Cardano signer did not embed the request commitment (${
        found.status === "present" ? "different value" : found.status
      })`,
    );
  }
}
