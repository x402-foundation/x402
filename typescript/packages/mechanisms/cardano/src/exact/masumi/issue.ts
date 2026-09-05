import { Address, COSE, PrivateKey } from "@evolution-sdk/evolution";
import { addressFromSeed, keysFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import type { PaymentRequirements } from "@x402/core/types";

import {
  ASSET_TRANSFER_METHOD_MASUMI,
  CANONICAL_CARDANO_ASSET_REGEX,
  getCardanoNetworkId,
  POSITIVE_CANONICAL_AMOUNT_REGEX,
} from "../../constants";
import type {
  CardanoExtraMasumi,
  MasumiCommitmentPart,
  MasumiDeployment,
  MasumiInputCommitment,
  MasumiTerms,
} from "../../types";
import { masumiEscrowAddress, resolveMasumiDeployment } from "./blueprint";
import {
  MASUMI_MAX_DEADLINE_HORIZON_MS,
  MASUMI_MIN_SUBMIT_RESULT_LEAD_MS,
  MASUMI_PAYMENT_SOURCE_TYPE,
  masumiDeadlineIntervalsHold,
} from "./constants";
import {
  buildSignedTerms,
  commitmentPartDigest,
  computeInputHash,
  computeTermsDigest,
} from "./digests";
import { encodeBlockchainIdentifier } from "./identifier";
import { isPosixMsString, validateMasumiExtra } from "./schema";

/**
 * The requirements-issuer side of the Masumi method: builds a
 * `PaymentRequirements` whose `extra` carries a consistent request commitment,
 * seller-signed `terms`, CIP-8 authorization and compatibility identifier.
 *
 * The issuer MUST store the complete object and reuse it verbatim on the paid
 * retry — regenerating the nonce, deadlines, commitment or policies produces a
 * different `termsDigest` and invalidates the payment the buyer built.
 */

/** The seller's CIP-30 `signData` result, as the wire carries it. */
export interface MasumiSellerAuthorization {
  /** Complete CBOR `COSE_Key` as lowercase hex. */
  key: string;
  /** Complete CBOR `COSE_Sign1` as lowercase hex. */
  signature: string;
}

/**
 * Signs `termsDigest` on the seller's behalf. Wrap a CIP-30 wallet's
 * `signData(sellerAddress, lowercaseHex(termsDigest))` here, or use
 * {@link toMasumiSellerSigner} for a mnemonic-backed seller.
 */
export type MasumiTermsSigner = (
  sellerAddress: string,
  termsDigestHex: string,
) => MasumiSellerAuthorization | Promise<MasumiSellerAuthorization>;

/** One part of the request the issuer commits to. */
export interface MasumiCommitmentInput {
  /** Unique non-empty part name (conventionally `parameters`, `body`, `raw`). */
  name: string;
  /** How `content` becomes bytes. */
  canonicalization: "jcs" | "raw";
  /** Optional media type, preserved byte-for-byte. */
  mediaType?: string;
  /** RFC 8785-compatible JSON for `jcs`, unpadded base64url for `raw`. */
  content: unknown;
  /**
   * Whether to echo `content` on the wire. Set `false` for parts derived from
   * the client's own request bytes, which it recomputes from what it sent —
   * this keeps a large body out of the `PAYMENT-REQUIRED` header without
   * weakening the commitment, because the manifest excludes `content` anyway.
   * Defaults to `true`, which is REQUIRED for issuer-originated content.
   */
  echoContent?: boolean;
}

/** Everything needed to issue one Masumi 402. */
export interface IssueMasumiRequirementsInput {
  /** The x402 Cardano network identifier. */
  network: string;
  /** `lovelace` or a canonical `policyId.assetNameHex` unit. */
  asset: string;
  /** Positive canonical decimal string in the asset's smallest unit. */
  amount: string;
  maxTimeoutSeconds: number;
  /** The seller's key-credential address on the selected network. */
  sellerAddress: string;
  /** Produces the seller's CIP-8 authorization over `termsDigest`. */
  signTerms: MasumiTermsSigner;
  /** The ordered request commitment parts. */
  commitment: MasumiCommitmentInput[];
  /** POSIX-millisecond deadlines, ordered and clearing the spec's minimums. */
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
  /**
   * 32 fresh cryptographically random bytes as 64 lowercase hex characters. A
   * fresh nonce MUST be generated for every new requirements object; one is
   * generated here when omitted.
   */
  sellerNonce?: string;
  /** Empty, or the buyer nonce extracted from the protected request. */
  buyerNonce?: string;
  /** Registry asset identifier; omitted, `null` or empty means unregistered. */
  agentIdentifier?: string | null;
  /** Optional key-credential payout address for the seller. */
  sellerReturnAddress?: string;
  settlementPolicy?: MasumiTerms["settlementPolicy"];
  submissionPolicy?: CardanoExtraMasumi["submissionPolicy"];
  confirmationPolicy?: CardanoExtraMasumi["confirmationPolicy"];
  /** Non-canonical validator parameters. Required on Preview. */
  deployment?: MasumiDeployment;
  /**
   * Test-only escape hatch that skips {@link assertMasumiIssuePolicy}. It exists
   * so negative fixtures can mint the hostile 402s a client and facilitator MUST
   * refuse. Never set it in production: the deadlines it lets through are the
   * exact ones the buyer rejects before it signs, and because they are covered
   * by `termsDigest` the resulting 402 cannot be repaired — only re-issued.
   */
  unsafeSkipPolicyChecks?: boolean;
  /**
   * How far past now `externalDisputeUnlockTime` may sit, defaulting to
   * {@link MASUMI_MAX_DEADLINE_HORIZON_MS}. This is the seller's own ceiling; a
   * buyer applies its own independently, so raising it here does not oblige
   * anyone to accept the result.
   */
  maxDeadlineHorizonMs?: bigint;
}

/** The four escrow deadlines, in the order the scheme requires them. */
const DEADLINE_FIELDS = [
  "payByTime",
  "submitResultTime",
  "unlockTime",
  "externalDisputeUnlockTime",
] as const;

/**
 * Rejects a Masumi 402 the buyer would refuse anyway, at the only moment the
 * seller can still fix it.
 *
 * Every value checked here is covered by `termsDigest`, so a 402 that fails a
 * buyer-side or facilitator-side rule cannot be patched afterwards — the whole
 * requirements object has to be re-issued and re-signed. Failing at issue time
 * turns a silent "no client will ever pay this" into an immediate error.
 *
 * @param input - The requirements about to be issued.
 * @param nowMs - Current POSIX time in milliseconds.
 * @throws When a deadline or the payment window would make the 402 unpayable.
 */
function assertMasumiIssuePolicy(input: IssueMasumiRequirementsInput, nowMs: bigint): void {
  // Guard before converting: `BigInt("")` and `BigInt("12x")` throw a raw
  // SyntaxError, which would surface as a crash instead of a named rejection.
  // The wire schema enforces the same shape later; this is the earlier gate.
  for (const field of DEADLINE_FIELDS) {
    if (!isPosixMsString(input[field])) {
      throw new Error(`Masumi ${field} must be a positive POSIX-ms integer string`);
    }
  }

  // Ordering and minimum gaps: the same rule the client and facilitator apply.
  if (
    !masumiDeadlineIntervalsHold(
      BigInt(input.payByTime),
      BigInt(input.submitResultTime),
      BigInt(input.unlockTime),
      BigInt(input.externalDisputeUnlockTime),
    )
  ) {
    throw new Error("Masumi deadline intervals are below the minimum");
  }

  assertMasumiIssueWindow(
    {
      payByTime: input.payByTime,
      submitResultTime: input.submitResultTime,
      externalDisputeUnlockTime: input.externalDisputeUnlockTime,
    },
    input.maxTimeoutSeconds,
    nowMs,
    input.maxDeadlineHorizonMs ?? MASUMI_MAX_DEADLINE_HORIZON_MS,
  );
}

/**
 * The clock-relative half of the issue policy, split out because it has to run
 * twice.
 *
 * `signTerms` is asynchronous and may sit behind a hardware wallet, a remote
 * signer or a human approval, so an unbounded amount of time can pass between
 * the first check and the moment the requirements are actually served. Without a
 * second pass the issuer can emit a 402 whose `payByTime` has already expired,
 * and the buyer would be the first to notice.
 *
 * Only the floors can newly fail on that second pass. The `maxTimeoutSeconds`
 * ceiling is `now + maxTimeoutSeconds`, which moves forward with the clock, so
 * a `payByTime` once inside it stays inside it; it is re-checked here only
 * because this function is the whole window, not because it can trip late.
 *
 * @param deadlines - Deadlines already validated for shape and ordering.
 * @param deadlines.payByTime - Datum `pay_by_time`.
 * @param deadlines.submitResultTime - Datum `submit_result_time`.
 * @param deadlines.externalDisputeUnlockTime - Datum `external_dispute_unlock_time`.
 * @param maxTimeoutSeconds - The x402 validity window.
 * @param nowMs - Current POSIX time in milliseconds.
 * @param maxDeadlineHorizonMs - How far past now the last deadline may sit.
 * @throws When the window no longer admits a payable 402.
 */
function assertMasumiIssueWindow(
  deadlines: { payByTime: string; submitResultTime: string; externalDisputeUnlockTime: string },
  maxTimeoutSeconds: number,
  nowMs: bigint,
  maxDeadlineHorizonMs: bigint,
): void {
  const payByTime = BigInt(deadlines.payByTime);

  // Absolute floors. Only the issuer holds a clock the buyer has not moved past.
  if (payByTime <= nowMs) {
    throw new Error("Masumi payByTime must be in the future");
  }
  if (BigInt(deadlines.submitResultTime) < nowMs + MASUMI_MIN_SUBMIT_RESULT_LEAD_MS) {
    throw new Error("Masumi submitResultTime must be at least 15 minutes away");
  }
  // A buyer refuses a window it cannot escape: until `submit_result_time` the
  // contract lets it recover neither the payment nor its collateral.
  if (BigInt(deadlines.externalDisputeUnlockTime) > nowMs + maxDeadlineHorizonMs) {
    throw new Error("Masumi deadlines extend beyond the accepted horizon");
  }

  // The buyer must be able to build, sign and land the lock inside the x402
  // validity window, and its transaction TTL is bounded by `payByTime`.
  if (payByTime > nowMs + BigInt(maxTimeoutSeconds) * 1000n) {
    throw new Error("Masumi payByTime exceeds maxTimeoutSeconds");
  }
}

/**
 * Generates a lowercase hex string of cryptographically random bytes.
 *
 * @param bytes - How many bytes to generate.
 * @returns The lowercase hex encoding.
 */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);
  return Array.from(buffer, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Issues a Masumi `PaymentRequirements`.
 *
 * `payTo` is derived from the deployment parameters, never supplied: the
 * verifier re-derives the same address and rejects a mismatch.
 *
 * @param input - What to issue.
 * @returns The complete payment requirements.
 * @throws When the resulting `extra` would not satisfy the wire schema.
 */
export async function issueMasumiRequirements(
  input: IssueMasumiRequirementsInput,
): Promise<PaymentRequirements> {
  if (!POSITIVE_CANONICAL_AMOUNT_REGEX.test(input.amount)) {
    throw new Error(`Masumi amount must be a positive canonical integer: ${input.amount}`);
  }
  if (!CANONICAL_CARDANO_ASSET_REGEX.test(input.asset)) {
    throw new Error(`Masumi asset must use canonical lowercase form: ${input.asset}`);
  }
  // Input validity, not policy: `maxTimeoutSeconds` goes on the wire and into
  // `termsDigest`, so it is never skippable.
  if (!Number.isSafeInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds <= 0) {
    throw new Error("Masumi maxTimeoutSeconds must be a positive safe integer");
  }
  // Strictly `true`: a truthy non-boolean reaching a security escape hatch from
  // untyped configuration must not silently disable it.
  const skipPolicyChecks = input.unsafeSkipPolicyChecks === true;
  if (!skipPolicyChecks) {
    assertMasumiIssuePolicy(input, BigInt(Date.now()));
  }
  const deployment = resolveMasumiDeployment(input.network, input.deployment);
  if (!deployment) {
    throw new Error(
      `Network ${input.network} has no canonical Masumi deployment; supply extra.deployment`,
    );
  }
  const payTo = masumiEscrowAddress(input.network, deployment);

  const parts: MasumiCommitmentPart[] = input.commitment.map(part => ({
    name: part.name,
    canonicalization: part.canonicalization,
    ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
    ...(part.echoContent === false ? {} : { content: part.content }),
    digest: commitmentPartDigest(part),
  }));
  const inputCommitment: MasumiInputCommitment = {
    version: "1",
    algorithm: "sha256",
    parts,
    digest: "",
  };
  inputCommitment.digest = computeInputHash(inputCommitment);

  const terms: MasumiTerms = {
    version: "1",
    paymentType: MASUMI_PAYMENT_SOURCE_TYPE,
    sellerAddress: input.sellerAddress,
    ...(input.sellerReturnAddress !== undefined
      ? { sellerReturnAddress: input.sellerReturnAddress }
      : {}),
    sellerNonce: input.sellerNonce ?? randomHex(32),
    buyerNonce: input.buyerNonce ?? "",
    ...(input.agentIdentifier !== undefined ? { agentIdentifier: input.agentIdentifier } : {}),
    inputHash: inputCommitment.digest,
    payByTime: input.payByTime,
    submitResultTime: input.submitResultTime,
    unlockTime: input.unlockTime,
    externalDisputeUnlockTime: input.externalDisputeUnlockTime,
    // This reference implementation currently has no Hydra client, so its
    // issuer deliberately selects L1 instead of advertising `auto` and later
    // being unable to honor a Hydra-capable buyer's choice.
    settlementPolicy: input.settlementPolicy ?? "l1",
  };

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: input.network as PaymentRequirements["network"],
    asset: input.asset,
    amount: input.amount,
    payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: {},
  };

  // The digest covers `terms` plus the seven projected top-level fields, so it
  // can only be computed once the requirements above are fixed.
  const termsDigest = computeTermsDigest(
    buildSignedTerms(
      {
        assetTransferMethod: ASSET_TRANSFER_METHOD_MASUMI,
        inputCommitment,
        terms,
        referenceKey: "",
        referenceSignature: "",
        blockchainIdentifier: "",
      },
      requirements,
    ),
  );
  const authorization = await input.signTerms(input.sellerAddress, termsDigest);
  const referenceKey = authorization.key.toLowerCase();
  const referenceSignature = authorization.signature.toLowerCase();

  // Signing is asynchronous and unbounded — a hardware wallet, a remote signer
  // or a human approval can take minutes. Re-check the clock-relative rules
  // against `terms` and `requirements`, which are this function's own copies, so
  // a caller mutating `input` mid-flight cannot steer the second pass.
  if (!skipPolicyChecks) {
    assertMasumiIssueWindow(
      terms,
      requirements.maxTimeoutSeconds,
      BigInt(Date.now()),
      input.maxDeadlineHorizonMs ?? MASUMI_MAX_DEADLINE_HORIZON_MS,
    );
  }

  const extra: CardanoExtraMasumi = {
    assetTransferMethod: ASSET_TRANSFER_METHOD_MASUMI,
    ...(input.submissionPolicy !== undefined ? { submissionPolicy: input.submissionPolicy } : {}),
    ...(input.confirmationPolicy !== undefined
      ? { confirmationPolicy: input.confirmationPolicy }
      : {}),
    inputCommitment,
    terms,
    referenceKey,
    referenceSignature,
    blockchainIdentifier: encodeBlockchainIdentifier({
      sellerNonce: terms.sellerNonce,
      agentIdentifier: typeof terms.agentIdentifier === "string" ? terms.agentIdentifier : "",
      buyerNonce: terms.buyerNonce,
      referenceSignature,
      referenceKey,
      contractAddress: payTo,
    }),
    ...(input.deployment ? { deployment: input.deployment } : {}),
  };

  // Fail here rather than serving a 402 no client or facilitator will accept.
  const schema = validateMasumiExtra(extra, input.network);
  if (!schema.ok) {
    throw new Error(`Issued Masumi requirements are invalid: ${schema.detail}`);
  }

  requirements.extra = extra as unknown as Record<string, unknown>;
  return requirements;
}

/**
 * Builds a mnemonic-backed seller: its key-credential address and a
 * {@link MasumiTermsSigner} that produces the CIP-8 authorization with the same
 * key. Convenience for a resource server that holds the selling wallet directly;
 * a CIP-30 wallet integration supplies its own signer instead.
 *
 * @param config - The seller wallet configuration.
 * @param config.mnemonic - BIP-39 mnemonic of the selling wallet.
 * @param config.network - The x402 Cardano network identifier.
 * @param config.accountIndex - Optional derivation account index.
 * @returns The seller address and its terms signer.
 */
export function toMasumiSellerSigner(config: {
  mnemonic: string;
  network: string;
  accountIndex?: number;
}): { sellerAddress: string; signTerms: MasumiTermsSigner } {
  const mnemonic = config.mnemonic.trim().replace(/\s+/g, " ").toLowerCase();
  const derivation = {
    accountIndex: config.accountIndex,
    networkId: getCardanoNetworkId(config.network),
  };
  const privateKey = PrivateKey.fromBech32(keysFromSeed(mnemonic, derivation).paymentKey);
  const sellerAddress = Address.toBech32(addressFromSeed(mnemonic, derivation).address);

  return {
    sellerAddress,
    signTerms: (address, termsDigestHex) => {
      const signed = COSE.SignData.signData(
        Address.toHex(Address.fromBech32(address)),
        Uint8Array.from(Buffer.from(termsDigestHex, "hex")),
        privateKey,
      );
      return {
        key: Buffer.from(signed.key).toString("hex").toLowerCase(),
        signature: Buffer.from(signed.signature).toString("hex").toLowerCase(),
      };
    },
  };
}
