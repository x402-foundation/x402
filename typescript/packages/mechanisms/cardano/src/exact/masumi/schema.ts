import { AddressEras } from "@evolution-sdk/evolution";

import { getCardanoNetworkId } from "../../constants";
import {
  MAX_MASUMI_ADMIN_KEYS,
  MAX_MASUMI_COMMITMENT_CONTENT_BYTES,
  MAX_MASUMI_COMMITMENT_PARTS,
  MAX_MASUMI_COSE_BYTES,
  MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES,
} from "../../limits";
import { normalizeConfirmationPolicy, normalizeSubmissionPolicy } from "../../policy";
import type {
  CardanoExtraMasumi,
  MasumiCommitmentPart,
  MasumiDeployment,
  MasumiInputCommitment,
  MasumiTerms,
} from "../../types";
import { MASUMI_PAYMENT_SOURCE_TYPE } from "./constants";

/**
 * Wire-schema validation for the Masumi `extra` block.
 *
 * `extra`, `inputCommitment`, every commitment part, `terms`,
 * `confirmationPolicy` and `deployment` are **closed objects**: an unknown
 * field is invalid. Because the allowed key sets below exclude every field that
 * is projected into `signedTerms` from the top level, the closed-object check
 * also enforces that `terms` never repeats one of them.
 */

/** Result of a schema validation: the typed block, or why it was rejected. */
export type MasumiSchemaResult =
  | { ok: true; extra: CardanoExtraMasumi }
  | { ok: false; detail: string };

const EXTRA_KEYS = new Set([
  "assetTransferMethod",
  "submissionPolicy",
  "confirmationPolicy",
  "areFeesSponsored",
  "inputCommitment",
  "terms",
  "referenceKey",
  "referenceSignature",
  "blockchainIdentifier",
  "deployment",
]);

const COMMITMENT_KEYS = new Set(["version", "algorithm", "parts", "digest"]);

const PART_KEYS = new Set(["name", "canonicalization", "mediaType", "content", "digest"]);

const TERMS_KEYS = new Set([
  "version",
  "paymentType",
  "sellerAddress",
  "sellerReturnAddress",
  "sellerNonce",
  "buyerNonce",
  "agentIdentifier",
  "inputHash",
  "payByTime",
  "submitResultTime",
  "unlockTime",
  "externalDisputeUnlockTime",
  "settlementPolicy",
]);

const DEPLOYMENT_KEYS = new Set(["requiredAdmins", "adminVkeys", "cooldownPeriod"]);

/** Lowercase even-length hex, possibly empty. */
const HEX = /^([0-9a-f]{2})*$/;
/** Exactly 32 bytes of lowercase hex. */
const HEX_32_BYTES = /^[0-9a-f]{64}$/;
/** Exactly 28 bytes of lowercase hex. */
const HEX_28_BYTES = /^[0-9a-f]{56}$/;
/** Positive canonical base-10 integer with no leading zero. */
const POSITIVE_INT = /^[1-9][0-9]*$/;
/** Non-negative canonical base-10 integer with no leading zero. */
const NON_NEGATIVE_INT = /^(0|[1-9][0-9]*)$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_VALUES = 100_000;
const MAX_PART_NAME_CHARS = 128;
const MAX_MEDIA_TYPE_CHARS = 256;
const MAX_POSIX_DIGITS = 20;
const MAX_AGENT_IDENTIFIER_HEX_CHARS = 120;

/**
 * Whether a value is a plain (non-array, non-null) object.
 *
 * @param value - The value to test.
 * @returns True for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Names the first key of `value` that is not in `allowed`.
 *
 * @param value - The object to check.
 * @param allowed - The closed key set.
 * @returns The offending key, or `undefined` when every key is allowed.
 */
function unknownKey(value: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(value).find(key => !allowed.has(key));
}

/**
 * Checks one commitment payload before digest code recursively canonicalizes it.
 *
 * @param value - Declared part content.
 * @param canonicalization - Declared byte encoding.
 * @returns Rejection detail, or undefined when within budget.
 */
function commitmentContentError(
  value: unknown,
  canonicalization: "jcs" | "raw",
): string | undefined {
  if (canonicalization === "raw") {
    if (typeof value !== "string" || !BASE64URL.test(value)) {
      return "raw content must be canonical unpadded base64url";
    }
    const decoded = Buffer.from(value, "base64url");
    if (
      decoded.length > MAX_MASUMI_COMMITMENT_CONTENT_BYTES ||
      decoded.toString("base64url") !== value
    ) {
      return "raw content exceeds the byte limit or is not canonical base64url";
    }
    return undefined;
  }

  const pending: Array<
    { value: unknown; depth: number; leave?: false } | { value: object; leave: true }
  > = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let values = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.leave) {
      seen.delete(current.value);
      continue;
    }
    values++;
    if (values > MAX_JSON_VALUES) return "JCS content exceeds the value limit";
    if (current.depth > MAX_JSON_DEPTH) return "JCS content exceeds the nesting limit";
    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return "JCS content contains a non-finite number";
      continue;
    }
    if (typeof current.value === "string") {
      bytes += Buffer.byteLength(current.value, "utf8");
      if (bytes > MAX_MASUMI_COMMITMENT_CONTENT_BYTES) {
        return "JCS content exceeds the byte limit";
      }
      continue;
    }
    if (typeof current.value !== "object") return "JCS content is not valid JSON";
    if (seen.has(current.value)) return "JCS content contains a cycle";
    seen.add(current.value);
    pending.push({ value: current.value, leave: true });
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return "JCS content must contain only plain JSON objects";
    }
    for (const [key, item] of Object.entries(current.value as Record<string, unknown>)) {
      bytes += Buffer.byteLength(key, "utf8");
      if (bytes > MAX_MASUMI_COMMITMENT_CONTENT_BYTES) {
        return "JCS content exceeds the byte limit";
      }
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }
  return undefined;
}

/**
 * Whether a value is a deadline the scheme can safely convert with `BigInt`: a
 * bounded, positive, canonical decimal string of POSIX milliseconds.
 *
 * Callers rely on this as a guard, not just as a schema rule — `BigInt("")` and
 * `BigInt("12x")` throw a raw `SyntaxError`, which would escape a validator as
 * an unhelpful crash instead of a precise rejection.
 *
 * @param value - The candidate deadline.
 * @returns True when the value converts cleanly.
 */
export function isPosixMsString(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_POSIX_DIGITS && POSITIVE_INT.test(value);
}

/**
 * Whether a bech32 address parses, belongs to the selected network, and uses an
 * address form the Masumi escrow lifecycle can carry end to end: an enterprise
 * address with a key payment credential, or a base address whose payment **and**
 * stake credentials are both key hashes.
 *
 * A script payment credential is refused because `vested_pay` does
 * `expect Some(vk) = address_to_verification_key(...)` on every spend path — the
 * contract could never release the funds. A script stake credential and a
 * pointer stake reference are refused for a narrower but equally terminal
 * reason: Masumi's own `getPubKeyAddressDatum` accepts neither, and every later
 * transition rebuilds the continuation datum through it while the validator
 * demands `new_datum.buyer == buyer` exactly. Locking such an address strands
 * the escrow for Masumi tooling with no recovery path.
 *
 * @param value - The candidate address.
 * @param network - The x402 Cardano network identifier.
 * @returns True when the address is a key-credential address on that network.
 */
export function isKeyCredentialAddressOn(value: unknown, network: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const address = AddressEras.fromBech32(value);
    if (address._tag !== "BaseAddress" && address._tag !== "EnterpriseAddress") return false;
    if (address.paymentCredential._tag !== "KeyHash") return false;
    if (address._tag === "BaseAddress" && address.stakeCredential._tag !== "KeyHash") return false;
    return address.networkId === getCardanoNetworkId(network);
  } catch {
    return false;
  }
}

/**
 * Validates the closed `deployment` block.
 *
 * @param value - The raw `extra.deployment` value.
 * @returns The typed deployment, or why it was rejected.
 */
function validateDeployment(
  value: unknown,
): { ok: true; deployment: MasumiDeployment } | { ok: false; detail: string } {
  if (!isRecord(value)) return { ok: false, detail: "deployment must be an object" };
  const extraneous = unknownKey(value, DEPLOYMENT_KEYS);
  if (extraneous) return { ok: false, detail: `deployment has unknown field ${extraneous}` };

  const { requiredAdmins, adminVkeys, cooldownPeriod } = value;
  if (
    !Array.isArray(adminVkeys) ||
    adminVkeys.length === 0 ||
    adminVkeys.length > MAX_MASUMI_ADMIN_KEYS
  ) {
    return { ok: false, detail: "deployment.adminVkeys must be a non-empty array" };
  }
  if (!adminVkeys.every(vkey => typeof vkey === "string" && HEX_28_BYTES.test(vkey))) {
    return { ok: false, detail: "deployment.adminVkeys must be 28-byte lowercase hex" };
  }
  if (
    typeof requiredAdmins !== "string" ||
    requiredAdmins.length > 3 ||
    !POSITIVE_INT.test(requiredAdmins)
  ) {
    return { ok: false, detail: "deployment.requiredAdmins must be a positive integer string" };
  }
  if (BigInt(requiredAdmins) > BigInt(adminVkeys.length)) {
    return { ok: false, detail: "deployment.requiredAdmins exceeds adminVkeys length" };
  }
  if (
    typeof cooldownPeriod !== "string" ||
    cooldownPeriod.length > MAX_POSIX_DIGITS ||
    !NON_NEGATIVE_INT.test(cooldownPeriod)
  ) {
    return {
      ok: false,
      detail: "deployment.cooldownPeriod must be a non-negative integer string",
    };
  }
  return {
    ok: true,
    deployment: { requiredAdmins, adminVkeys: adminVkeys as string[], cooldownPeriod },
  };
}

/**
 * Validates one closed commitment part.
 *
 * @param value - The raw part.
 * @param index - Its position, used in the rejection detail.
 * @returns The typed part, or why it was rejected.
 */
function validatePart(
  value: unknown,
  index: number,
): { ok: true; part: MasumiCommitmentPart } | { ok: false; detail: string } {
  if (!isRecord(value)) return { ok: false, detail: `parts[${index}] must be an object` };
  const extraneous = unknownKey(value, PART_KEYS);
  if (extraneous) return { ok: false, detail: `parts[${index}] has unknown field ${extraneous}` };

  const { name, canonicalization, mediaType, digest } = value;
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_PART_NAME_CHARS) {
    return { ok: false, detail: `parts[${index}].name must be a non-empty string` };
  }
  if (canonicalization !== "jcs" && canonicalization !== "raw") {
    return { ok: false, detail: `parts[${index}].canonicalization must be jcs or raw` };
  }
  if (
    mediaType !== undefined &&
    (typeof mediaType !== "string" || mediaType.length > MAX_MEDIA_TYPE_CHARS)
  ) {
    return { ok: false, detail: `parts[${index}].mediaType must be a string` };
  }
  if (typeof digest !== "string" || !HEX_32_BYTES.test(digest)) {
    return { ok: false, detail: `parts[${index}].digest must be 32-byte lowercase hex` };
  }
  if ("content" in value) {
    const contentError = commitmentContentError(value.content, canonicalization);
    if (contentError) return { ok: false, detail: `parts[${index}].content ${contentError}` };
  }
  return {
    ok: true,
    part: {
      name,
      canonicalization,
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...("content" in value ? { content: value.content } : {}),
      digest,
    },
  };
}

/**
 * Validates the closed `inputCommitment` block.
 *
 * @param value - The raw commitment.
 * @returns The typed commitment, or why it was rejected.
 */
function validateCommitment(
  value: unknown,
): { ok: true; commitment: MasumiInputCommitment } | { ok: false; detail: string } {
  if (!isRecord(value)) return { ok: false, detail: "inputCommitment must be an object" };
  const extraneous = unknownKey(value, COMMITMENT_KEYS);
  if (extraneous) return { ok: false, detail: `inputCommitment has unknown field ${extraneous}` };

  if (value.version !== "1") return { ok: false, detail: "inputCommitment.version must be '1'" };
  if (value.algorithm !== "sha256") {
    return { ok: false, detail: "inputCommitment.algorithm must be 'sha256'" };
  }
  if (typeof value.digest !== "string" || !HEX_32_BYTES.test(value.digest)) {
    return { ok: false, detail: "inputCommitment.digest must be 32-byte lowercase hex" };
  }
  if (
    !Array.isArray(value.parts) ||
    value.parts.length === 0 ||
    value.parts.length > MAX_MASUMI_COMMITMENT_PARTS
  ) {
    return { ok: false, detail: "inputCommitment.parts must be a non-empty array" };
  }

  const parts: MasumiCommitmentPart[] = [];
  const names = new Set<string>();
  for (const [index, raw] of value.parts.entries()) {
    const result = validatePart(raw, index);
    if (!result.ok) return result;
    if (names.has(result.part.name)) {
      return { ok: false, detail: `inputCommitment has duplicate part name ${result.part.name}` };
    }
    names.add(result.part.name);
    parts.push(result.part);
  }
  return {
    ok: true,
    commitment: { version: "1", algorithm: "sha256", parts, digest: value.digest },
  };
}

/**
 * Validates the closed `terms` block against the selected network.
 *
 * @param value - The raw terms.
 * @param network - The x402 Cardano network identifier.
 * @param commitmentDigest - The validated `inputCommitment.digest`.
 * @returns The typed terms, or why they were rejected.
 */
function validateTerms(
  value: unknown,
  network: string,
  commitmentDigest: string,
): { ok: true; terms: MasumiTerms } | { ok: false; detail: string } {
  if (!isRecord(value)) return { ok: false, detail: "terms must be an object" };
  const extraneous = unknownKey(value, TERMS_KEYS);
  if (extraneous) return { ok: false, detail: `terms has unknown field ${extraneous}` };

  if (value.version !== "1") return { ok: false, detail: "terms.version must be '1'" };
  if (value.paymentType !== MASUMI_PAYMENT_SOURCE_TYPE) {
    return { ok: false, detail: `terms.paymentType must be ${MASUMI_PAYMENT_SOURCE_TYPE}` };
  }
  if (!isKeyCredentialAddressOn(value.sellerAddress, network)) {
    return { ok: false, detail: "terms.sellerAddress must be a key-credential address on network" };
  }
  // An absent return address is OMITTED; JSON null is explicitly invalid.
  if (
    "sellerReturnAddress" in value &&
    !isKeyCredentialAddressOn(value.sellerReturnAddress, network)
  ) {
    return {
      ok: false,
      detail: "terms.sellerReturnAddress must be a key-credential address on network",
    };
  }
  if (typeof value.sellerNonce !== "string" || !HEX_32_BYTES.test(value.sellerNonce)) {
    return { ok: false, detail: "terms.sellerNonce must be 32-byte lowercase hex" };
  }
  if (
    typeof value.buyerNonce !== "string" ||
    !HEX.test(value.buyerNonce) ||
    (value.buyerNonce.length !== 0 &&
      (value.buyerNonce.length < 14 || value.buyerNonce.length > 26))
  ) {
    return { ok: false, detail: "terms.buyerNonce must be empty or 14-26 lowercase hex chars" };
  }
  if (
    "agentIdentifier" in value &&
    value.agentIdentifier !== null &&
    (typeof value.agentIdentifier !== "string" ||
      value.agentIdentifier.length > MAX_AGENT_IDENTIFIER_HEX_CHARS ||
      !HEX.test(value.agentIdentifier))
  ) {
    return { ok: false, detail: "terms.agentIdentifier must be null or lowercase hex" };
  }
  if (value.inputHash !== commitmentDigest) {
    return { ok: false, detail: "terms.inputHash must equal inputCommitment.digest" };
  }
  const times = ["payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"];
  for (const field of times) {
    if (!isPosixMsString(value[field])) {
      return { ok: false, detail: `terms.${field} must be a positive POSIX-ms integer string` };
    }
  }
  if (
    value.settlementPolicy !== "auto" &&
    value.settlementPolicy !== "l1" &&
    value.settlementPolicy !== "hydra"
  ) {
    return { ok: false, detail: "terms.settlementPolicy must be auto, l1 or hydra" };
  }

  return {
    ok: true,
    terms: {
      version: "1",
      paymentType: MASUMI_PAYMENT_SOURCE_TYPE,
      sellerAddress: value.sellerAddress as string,
      ...("sellerReturnAddress" in value
        ? { sellerReturnAddress: value.sellerReturnAddress as string }
        : {}),
      sellerNonce: value.sellerNonce,
      buyerNonce: value.buyerNonce,
      ...("agentIdentifier" in value
        ? { agentIdentifier: value.agentIdentifier as string | null }
        : {}),
      inputHash: value.inputHash as string,
      payByTime: value.payByTime as string,
      submitResultTime: value.submitResultTime as string,
      unlockTime: value.unlockTime as string,
      externalDisputeUnlockTime: value.externalDisputeUnlockTime as string,
      settlementPolicy: value.settlementPolicy,
    },
  };
}

/**
 * Validates a Masumi `extra` block against the wire schema.
 *
 * This checks structure only — digests, signatures, the derived escrow address
 * and the datum are verified separately.
 *
 * @param value - The raw `requirements.extra`.
 * @param network - The x402 Cardano network identifier.
 * @returns The typed extra, or why it was rejected.
 */
export function validateMasumiExtra(value: unknown, network: string): MasumiSchemaResult {
  if (!isRecord(value)) return { ok: false, detail: "extra must be an object" };
  const extraneous = unknownKey(value, EXTRA_KEYS);
  if (extraneous) return { ok: false, detail: `extra has unknown field ${extraneous}` };

  if (value.assetTransferMethod !== "masumi") {
    return { ok: false, detail: "extra.assetTransferMethod must be masumi" };
  }
  if (normalizeSubmissionPolicy(value.submissionPolicy) === null) {
    return { ok: false, detail: "extra.submissionPolicy must be server, client or either" };
  }
  if (normalizeConfirmationPolicy(value.confirmationPolicy) === null) {
    return { ok: false, detail: "extra.confirmationPolicy must be { l1Confirmations: -1..20 }" };
  }
  // Cardano never sponsors fees: the client balances the fee against its own
  // inputs. A 402 claiming otherwise misdescribes who pays.
  if (value.areFeesSponsored !== undefined && value.areFeesSponsored !== false) {
    return { ok: false, detail: "extra.areFeesSponsored must be false" };
  }
  for (const field of ["referenceKey", "referenceSignature", "blockchainIdentifier"] as const) {
    const hex = value[field];
    const maxBytes =
      field === "blockchainIdentifier"
        ? MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES
        : MAX_MASUMI_COSE_BYTES;
    if (
      typeof hex !== "string" ||
      hex.length === 0 ||
      hex.length / 2 > maxBytes ||
      !HEX.test(hex)
    ) {
      return { ok: false, detail: `extra.${field} must be non-empty lowercase even-length hex` };
    }
  }

  const commitment = validateCommitment(value.inputCommitment);
  if (!commitment.ok) return commitment;
  const terms = validateTerms(value.terms, network, commitment.commitment.digest);
  if (!terms.ok) return terms;

  let deployment: MasumiDeployment | undefined;
  if (value.deployment !== undefined) {
    const result = validateDeployment(value.deployment);
    if (!result.ok) return result;
    deployment = result.deployment;
  }

  return {
    ok: true,
    extra: {
      assetTransferMethod: "masumi",
      ...(value.areFeesSponsored !== undefined
        ? { areFeesSponsored: value.areFeesSponsored as boolean }
        : {}),
      ...(value.submissionPolicy !== undefined
        ? { submissionPolicy: value.submissionPolicy as CardanoExtraMasumi["submissionPolicy"] }
        : {}),
      ...(value.confirmationPolicy !== undefined
        ? {
            confirmationPolicy:
              value.confirmationPolicy as CardanoExtraMasumi["confirmationPolicy"],
          }
        : {}),
      inputCommitment: commitment.commitment,
      terms: terms.terms,
      referenceKey: value.referenceKey as string,
      referenceSignature: value.referenceSignature as string,
      blockchainIdentifier: value.blockchainIdentifier as string,
      ...(deployment ? { deployment } : {}),
    },
  };
}
