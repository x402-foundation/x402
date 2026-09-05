import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";

import {
  ERR_MASUMI_AGENT_IDENTIFIER,
  ERR_MASUMI_ASSET,
  ERR_MASUMI_COLLATERAL,
  ERR_MASUMI_COMMITMENT,
  ERR_MASUMI_DATUM_INVALID,
  ERR_MASUMI_DATUM_MISMATCH,
  ERR_MASUMI_DATUM_MISSING,
  ERR_MASUMI_DEADLINE,
  ERR_MASUMI_DEPLOYMENT,
  ERR_MASUMI_ESCROW_OUTPUT_COUNT,
  ERR_MASUMI_IDENTIFIER,
  ERR_MASUMI_MIN_UTXO,
  ERR_MASUMI_REFERENCE_SCRIPT,
  ERR_MASUMI_SCHEMA,
  ERR_MASUMI_SELLER_SIGNATURE,
  ERR_SETTLEMENT_LAYER_MISMATCH,
  ERR_SETTLEMENT_LAYER_UNSUPPORTED,
  LOVELACE_ASSET,
} from "../../constants";
import type {
  CardanoExtraMasumi,
  DecodedCardanoTransaction,
  ExactCardanoPayload,
  MasumiDeployment,
} from "../../types";
import { slotToPosixMs } from "../../utils";
import { masumiEscrowAddress, resolveMasumiDeployment } from "./blueprint";
import {
  MASUMI_MIN_COLLATERAL_LOVELACE,
  MASUMI_REGISTRY_POLICY_ID,
  masumiDeadlineIntervalsHold,
  masumiMinUtxoLovelace,
} from "./constants";
import { verifySellerTermsSignature } from "./cose";
import {
  buildSignedTerms,
  commitmentPartDigest,
  computeInputHash,
  computeTermsDigest,
} from "./digests";
import { decodeBlockchainIdentifier } from "./identifier";
import { validateMasumiExtra } from "./schema";
import {
  addressCredentials,
  MASUMI_STATE_FUNDS_LOCKED,
  parseMasumiLockDatum,
  type MasumiAddressCredentials,
  type MasumiDatumView,
} from "./datum";

export type MasumiLockCheck = { ok: true } | { ok: false; reason: string; detail?: string };

/**
 * Builds a rejection result carrying the failure reason.
 *
 * @param reason - The failure reason code.
 * @param detail - Optional human-readable detail.
 * @returns A failing check.
 */
const fail = (reason: string, detail?: string): MasumiLockCheck => ({
  ok: false,
  reason,
  detail,
});

/**
 * Everything the Masumi lock check needs beyond the requirements and the
 * decoded transaction.
 */
export interface MasumiVerifyContext {
  /** The decoded Cardano payload (nonce, settlement layer). */
  payload: ExactCardanoPayload;
  /** The address that owns the nonce UTXO, i.e. the resolved buyer. */
  payer: string;
  /** Live `coinsPerUtxoByte`; when absent the min-UTXO checks are skipped. */
  coinsPerUtxoByte?: bigint;
  /**
   * Independently validates a registry claim on the selected network. The spec
   * requires the asset, seller authorization, metadata, endpoint, network and
   * exact price to be checked before a non-empty `agentIdentifier` is honoured.
   *
   * Without one, a non-empty `agentIdentifier` is **rejected**: accepting an
   * unvalidated claim would let anyone assert another registered agent's
   * identity and reputation while signing the terms with their own key.
   * Unregistered sellers (absent, `null` or empty) are unaffected.
   */
  validateRegistryClaim?: MasumiRegistryValidator;
  /** The protected resource whose endpoint the registry claim must cover. */
  resource?: ResourceInfo;
  /** Explicit application approval for a non-canonical deployment. */
  validateCustomDeployment?: MasumiDeploymentValidator;
  /**
   * How far past now `external_dispute_unlock_time` may sit. The base
   * facilitator deliberately leaves this unset — see
   * {@link MasumiAuthorizationOptions.maxDeadlineHorizonMs} — so it cannot
   * reject a lock a client with a longer appetite already made.
   */
  maxDeadlineHorizonMs?: bigint;
}

/**
 * Options for {@link verifyMasumiAuthorization}.
 */
export interface MasumiAuthorizationOptions {
  /** Independently validates a non-empty `agentIdentifier`. */
  validateRegistryClaim?: MasumiRegistryValidator;
  /** The protected resource whose endpoint the registry claim must cover. */
  resource?: ResourceInfo;
  /** Explicit application approval for a non-canonical deployment. */
  validateCustomDeployment?: MasumiDeploymentValidator;
  /**
   * The buyer's own content for commitment parts the issuer did not echo,
   * keyed by part name. The spec requires the client to recompute every part
   * digest "using the issuer's `content` where present and its own request
   * bytes where absent" — without this, an omitted part's digest is unchecked.
   */
  localCommitmentContent?: Record<string, unknown>;
  /**
   * Rejects a commitment part whose content is neither echoed by the issuer nor
   * supplied locally. **Clients MUST set this.** A seller that omits content can
   * otherwise invent part digests and an `inputHash`, sign that internally
   * consistent manifest, and bind the escrow to a request the buyer never made.
   * A facilitator leaves it `false`: it never sees the original request.
   */
  requireAllPartContent?: boolean;
  /**
   * How far past now `external_dispute_unlock_time` may sit. **Buyer policy: a
   * client sets it, a verifier does not.** Omitting it skips the horizon check.
   *
   * Set it to `MASUMI_MAX_DEADLINE_HORIZON_MS` for the default appetite,
   * or higher for a counterparty whose long settlement window you accept —
   * until `submit_result_time` passes the buyer can recover neither the payment
   * nor its collateral.
   */
  maxDeadlineHorizonMs?: bigint;
}

/**
 * Validates a Masumi V2 registry claim against the selected network.
 *
 * @param claim - The registry claim to validate.
 * @returns True when the claim is authentic and resolves to the signed price.
 */
export type MasumiRegistryValidator = (claim: {
  /** The non-empty `terms.agentIdentifier`. */
  agentIdentifier: string;
  /** The seller address the terms are signed by. */
  sellerAddress: string;
  /** The x402 Cardano network identifier. */
  network: string;
  /** The signed top-level amount. */
  amount: string;
  /** The signed top-level asset unit. */
  asset: string;
  /** The protected x402 resource whose URL must match the registry endpoint. */
  resource: ResourceInfo;
}) => boolean | Promise<boolean>;

/** Explicitly approves one non-canonical Masumi V2 deployment. */
export type MasumiDeploymentValidator = (claim: {
  network: string;
  payTo: string;
  deployment: MasumiDeployment;
}) => boolean | Promise<boolean>;

/**
 * Whether two addresses share the same payment (and stake, if any) credential.
 *
 * @param a - The first address' credentials.
 * @param b - The second address' credentials.
 * @returns True when the payment and stake credentials match.
 */
function sameCredentials(a: MasumiAddressCredentials, b: MasumiAddressCredentials): boolean {
  if (a.payment.hash !== b.payment.hash || a.payment.isScript !== b.payment.isScript) return false;
  if (
    (a.stake?.hash ?? "") !== (b.stake?.hash ?? "") ||
    (a.stake?.isScript ?? false) !== (b.stake?.isScript ?? false)
  ) {
    return false;
  }
  return (
    (a.pointer?.slot ?? -1n) === (b.pointer?.slot ?? -1n) &&
    (a.pointer?.txIndex ?? -1n) === (b.pointer?.txIndex ?? -1n) &&
    (a.pointer?.certIndex ?? -1n) === (b.pointer?.certIndex ?? -1n)
  );
}

/**
 * Whether the datum's optional return address exactly matches the declared one:
 * a declared address must be present in the datum with matching credentials; an
 * omitted one must be absent (`None`).
 *
 * @param declared - The signed terms' return address (bech32), or undefined.
 * @param actual - The datum's return-address credentials, or null (`None`).
 * @returns True when they correspond exactly.
 */
function returnAddressMatches(
  declared: string | undefined,
  actual: MasumiAddressCredentials | null,
): boolean {
  if (declared === undefined) return actual === null;
  return actual !== null && sameCredentials(actual, addressCredentials(declared));
}

/**
 * Whether an address in the datum is one Masumi's own off-chain tooling can
 * re-encode. `getPubKeyAddressDatum` in `masumi-payment-service` accepts only an
 * enterprise key address or a base address whose **both** credentials are key
 * hashes; a script stake credential or a pointer stake reference makes it throw.
 *
 * That matters after the lock: every later transition rebuilds the continuation
 * datum from the decoded one and the validator requires `new_datum.buyer ==
 * buyer` exactly, so an address form Masumi cannot re-encode leaves the escrow
 * unspendable through Masumi tooling. The script payment credential is refused
 * for a stronger reason still — `address_to_verification_key` fails on it, so
 * the contract itself can never release the funds.
 *
 * @param credentials - The address credentials taken from the datum.
 * @returns A failure detail suffix, or `null` when the address form is accepted.
 */
function unsupportedAddressForm(credentials: MasumiAddressCredentials): string | null {
  if (credentials.payment.isScript) return "script payment credential";
  if (credentials.stake?.isScript) return "script stake credential";
  if (credentials.pointer) return "pointer stake reference";
  return null;
}

/**
 * Checks invariants that make a freshly built V2 datum safe to submit. This is
 * shared by the client preflight and facilitator verification so client mode
 * cannot broadcast a lock that the facilitator will reject afterwards.
 *
 * @param view - Parsed fresh-lock datum.
 * @param escrowAddress - Derived Masumi V2 escrow address.
 * @returns Success, or the first failed invariant.
 */
export function verifyMasumiDatumInvariants(
  view: MasumiDatumView,
  escrowAddress: string,
): MasumiLockCheck {
  if (view.state !== MASUMI_STATE_FUNDS_LOCKED) return fail(ERR_MASUMI_DATUM_INVALID, "state");
  if (view.resultHash !== "") return fail(ERR_MASUMI_DATUM_INVALID, "result_hash");
  if (view.sellerCooldownTime !== 0n || view.buyerCooldownTime !== 0n) {
    return fail(ERR_MASUMI_DATUM_INVALID, "cooldown");
  }
  const addressForms: Array<[string, MasumiAddressCredentials | null]> = [
    ["buyer", view.buyer],
    ["seller", view.seller],
    ["buyer_return_address", view.buyerReturnAddress],
    ["seller_return_address", view.sellerReturnAddress],
  ];
  for (const [field, credentials] of addressForms) {
    if (!credentials) continue;
    const unsupported = unsupportedAddressForm(credentials);
    if (unsupported) return fail(ERR_MASUMI_DATUM_INVALID, `${field} is a ${unsupported}`);
  }
  if (view.referenceSignature.length < 32) {
    return fail(ERR_MASUMI_DATUM_INVALID, "reference_signature shorter than 16 bytes");
  }

  const escrow = addressCredentials(escrowAddress);
  const buyerTarget = view.buyerReturnAddress ?? view.buyer;
  const sellerTarget = view.sellerReturnAddress ?? view.seller;
  if (
    sameCredentials(view.buyer, escrow) ||
    sameCredentials(view.seller, escrow) ||
    sameCredentials(buyerTarget, escrow) ||
    sameCredentials(sellerTarget, escrow)
  ) {
    return fail(ERR_MASUMI_DATUM_INVALID, "datum address is the escrow");
  }
  if (sameCredentials(buyerTarget, sellerTarget)) {
    return fail(ERR_MASUMI_DATUM_INVALID, "buyer and seller payout targets are equal");
  }

  if (
    !masumiDeadlineIntervalsHold(
      view.payByTime,
      view.submitResultTime,
      view.unlockTime,
      view.externalDisputeUnlockTime,
    )
  ) {
    return fail(ERR_MASUMI_DEADLINE, "deadline intervals below the minimum");
  }
  return { ok: true };
}

/**
 * Checks the seller-signed deadline order, and optionally the horizon, before a
 * client selects funds.
 *
 * The interval rule is a protocol rule and always applies. The horizon is
 * **buyer policy** and applies only when a caller asks for it. `vested_pay`
 * gates the buyer's `WithdrawRefund` on `must_start_after(validity_range,
 * submit_result_time)`, so a 402 naming a deadline years out freezes the buyer's
 * payment and collateral for that long — but how long a wait is acceptable is
 * the payer's risk appetite, not something a third party can decide.
 *
 * A verifier therefore does not impose one. Once the funds are locked, rejecting
 * the payment for a distant deadline unfreezes nothing; it only adds a failed
 * settlement to a lock the buyer already chose to make. Worse, a facilitator
 * applying its own horizon could reject exactly the payment a client with a
 * raised horizon was willing to make — stranding the funds it was meant to
 * protect.
 *
 * @param terms - Schema-validated Masumi terms.
 * @param maxDeadlineHorizonMs - How far past now the last deadline may sit;
 *   omit to skip the horizon check.
 * @returns Success, or a deadline failure.
 */
function verifyMasumiTermDeadlines(
  terms: CardanoExtraMasumi["terms"],
  maxDeadlineHorizonMs?: bigint,
): MasumiLockCheck {
  const externalDisputeUnlockTime = BigInt(terms.externalDisputeUnlockTime);
  if (
    !masumiDeadlineIntervalsHold(
      BigInt(terms.payByTime),
      BigInt(terms.submitResultTime),
      BigInt(terms.unlockTime),
      externalDisputeUnlockTime,
    )
  ) {
    return fail(ERR_MASUMI_DEADLINE, "deadline intervals below the minimum");
  }
  if (
    maxDeadlineHorizonMs !== undefined &&
    externalDisputeUnlockTime > BigInt(Date.now()) + maxDeadlineHorizonMs
  ) {
    return fail(ERR_MASUMI_DEADLINE, "deadlines extend beyond the accepted horizon");
  }
  return { ok: true };
}

/**
 * Verifies the seller authorization carried in `extra`: the request commitment
 * recomputes, the reconstructed `termsDigest` is what the seller's COSE
 * signature covers, and the compatibility identifier decodes to the same
 * values. No transaction is involved — a client runs exactly these checks
 * before it signs.
 *
 * @param extra - The schema-validated masumi `extra` block.
 * @param requirements - The canonical payment requirements.
 * @param options - Registry validation and buyer-supplied commitment content.
 * @returns `{ ok: true }` plus the derived escrow address, else a failure reason.
 */
export async function verifyMasumiAuthorization(
  extra: CardanoExtraMasumi,
  requirements: PaymentRequirements,
  options: MasumiAuthorizationOptions = {},
): Promise<
  | { ok: true; escrowAddress: string; termsDigest: string }
  | { ok: false; reason: string; detail?: string }
> {
  const { terms, inputCommitment } = extra;

  const deadlines = verifyMasumiTermDeadlines(terms, options.maxDeadlineHorizonMs);
  if (!deadlines.ok) return deadlines;

  // Commitment: every part digest must recompute. The issuer echoes the content
  // it originates; for a part derived from the buyer's own request bytes the
  // buyer supplies it. A part with neither is unverifiable — the client MUST
  // refuse it, because a seller free to invent an omitted part's digest is free
  // to bind the escrow to a request that was never made.
  for (const part of inputCommitment.parts) {
    const content = part.content ?? options.localCommitmentContent?.[part.name];
    if (content === undefined) {
      if (options.requireAllPartContent) {
        return {
          ok: false,
          reason: ERR_MASUMI_COMMITMENT,
          detail: `part ${part.name} carries no content to verify its digest against`,
        };
      }
      continue;
    }
    let digest: string;
    try {
      digest = commitmentPartDigest({ canonicalization: part.canonicalization, content });
    } catch (cause) {
      return {
        ok: false,
        reason: ERR_MASUMI_COMMITMENT,
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
    if (digest !== part.digest) {
      return {
        ok: false,
        reason: ERR_MASUMI_COMMITMENT,
        detail: `part ${part.name} digest mismatch`,
      };
    }
  }
  if (computeInputHash(inputCommitment) !== inputCommitment.digest) {
    return { ok: false, reason: ERR_MASUMI_COMMITMENT, detail: "commitment digest mismatch" };
  }

  // Escrow address: derived from the deployment parameters, never defaulted
  // from `payTo`. Preview has no canonical deployment.
  const deployment = resolveMasumiDeployment(requirements.network, extra.deployment);
  if (!deployment) {
    return {
      ok: false,
      reason: ERR_MASUMI_DEPLOYMENT,
      detail: "network has no canonical deployment; extra.deployment is required",
    };
  }
  let escrowAddress: string;
  try {
    escrowAddress = masumiEscrowAddress(requirements.network, deployment);
  } catch (cause) {
    return {
      ok: false,
      reason: ERR_MASUMI_DEPLOYMENT,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (escrowAddress !== requirements.payTo) {
    return {
      ok: false,
      reason: ERR_MASUMI_DEPLOYMENT,
      detail: `derived escrow ${escrowAddress} does not equal payTo`,
    };
  }
  const termsDigest = computeTermsDigest(buildSignedTerms(extra, requirements));
  if (
    !verifySellerTermsSignature(
      extra.referenceKey,
      extra.referenceSignature,
      terms.sellerAddress,
      termsDigest,
    )
  ) {
    return { ok: false, reason: ERR_MASUMI_SELLER_SIGNATURE };
  }

  // Run application callbacks only after the local seller signature check.
  if (extra.deployment) {
    if (!options.validateCustomDeployment) {
      return {
        ok: false,
        reason: ERR_MASUMI_DEPLOYMENT,
        detail: "custom deployment requires explicit application approval",
      };
    }
    if (
      !(await options.validateCustomDeployment({
        network: requirements.network,
        payTo: requirements.payTo,
        deployment: extra.deployment,
      }))
    ) {
      return {
        ok: false,
        reason: ERR_MASUMI_DEPLOYMENT,
        detail: "custom deployment was not approved",
      };
    }
  }

  const agentIdentifier = typeof terms.agentIdentifier === "string" ? terms.agentIdentifier : "";
  if (agentIdentifier.length > 0) {
    if (!agentIdentifier.startsWith(MASUMI_REGISTRY_POLICY_ID)) {
      return {
        ok: false,
        reason: ERR_MASUMI_AGENT_IDENTIFIER,
        detail: "agentIdentifier does not carry the Masumi V2 registry policy id",
      };
    }
    if (!options.validateRegistryClaim) {
      return {
        ok: false,
        reason: ERR_MASUMI_AGENT_IDENTIFIER,
        detail: "registry claims require an independent on-network validator",
      };
    }
    if (!options.resource) {
      return {
        ok: false,
        reason: ERR_MASUMI_AGENT_IDENTIFIER,
        detail: "registry claims require the protected resource for endpoint validation",
      };
    }
    if (
      !(await options.validateRegistryClaim({
        agentIdentifier,
        sellerAddress: terms.sellerAddress,
        network: requirements.network,
        amount: requirements.amount,
        asset: requirements.asset,
        resource: options.resource,
      }))
    ) {
      return {
        ok: false,
        reason: ERR_MASUMI_AGENT_IDENTIFIER,
        detail: "registry validation rejected the claim",
      };
    }
  }

  const decoded = decodeBlockchainIdentifier(extra.blockchainIdentifier);
  if (
    !decoded ||
    decoded.sellerNonce !== terms.sellerNonce ||
    decoded.agentIdentifier !== agentIdentifier ||
    decoded.buyerNonce !== terms.buyerNonce ||
    decoded.referenceSignature !== extra.referenceSignature ||
    decoded.referenceKey !== extra.referenceKey ||
    decoded.contractAddress !== requirements.payTo
  ) {
    return { ok: false, reason: ERR_MASUMI_IDENTIFIER };
  }

  return { ok: true, escrowAddress, termsDigest };
}

/**
 * Verifies that a payment locks funds into the Masumi `vested_pay` escrow with a
 * well-formed `FundsLocked` datum matching the seller-signed terms. Only the
 * on-chain lock is checked (x402's scope); the post-lock lifecycle is governed
 * by the contract in later transactions.
 *
 * Because `vested_pay` only runs on spend, a malformed datum is not rejected at
 * lock time — it silently strands the funds — so every invariant below is
 * enforced here rather than left to the validator.
 *
 * @param rawExtra - The `extra` block from the canonical requirements.
 * @param requirements - The canonical payment requirements.
 * @param decoded - The decoded transaction (with output inline datums).
 * @param context - Payload, resolved payer and live protocol parameters.
 * @returns `{ ok: true }` when the lock is valid, else a precise failure reason.
 */
export async function verifyMasumiLock(
  rawExtra: unknown,
  requirements: PaymentRequirements,
  decoded: DecodedCardanoTransaction,
  context: MasumiVerifyContext,
): Promise<MasumiLockCheck> {
  const schema = validateMasumiExtra(rawExtra, requirements.network);
  if (!schema.ok) return fail(ERR_MASUMI_SCHEMA, schema.detail);
  const extra = schema.extra;
  const terms = extra.terms;

  const authorization = await verifyMasumiAuthorization(extra, requirements, {
    ...(context.validateRegistryClaim
      ? { validateRegistryClaim: context.validateRegistryClaim }
      : {}),
    ...(context.resource ? { resource: context.resource } : {}),
    ...(context.validateCustomDeployment
      ? { validateCustomDeployment: context.validateCustomDeployment }
      : {}),
    ...(context.maxDeadlineHorizonMs !== undefined
      ? { maxDeadlineHorizonMs: context.maxDeadlineHorizonMs }
      : {}),
  });
  if (!authorization.ok) return authorization;
  const escrowAddress = authorization.escrowAddress;

  // Settlement layer: required for masumi, and admitted by the signed policy.
  const settlementLayer = context.payload.settlementLayer;
  if (settlementLayer === undefined) {
    return fail(ERR_SETTLEMENT_LAYER_MISMATCH, "payload.settlementLayer is required for masumi");
  }
  if (terms.settlementPolicy !== "auto" && terms.settlementPolicy !== settlementLayer) {
    return fail(ERR_SETTLEMENT_LAYER_MISMATCH);
  }
  // Hydra needs verified Init state, head parameters, a seller-participant
  // binding and `SnapshotConfirmed` evidence from the selected head. This
  // implementation has none of that, and authenticating a Hydra payment against
  // L1 evidence would be a lie, so Hydra is refused outright.
  if (settlementLayer === "hydra") {
    return fail(ERR_SETTLEMENT_LAYER_UNSUPPORTED, "Hydra settlement is not implemented");
  }

  // Exactly one escrow output, carrying an inline datum and no reference script.
  const escrowOutputs = decoded.outputs.filter(o => o.address === escrowAddress);
  if (escrowOutputs.length !== 1) return fail(ERR_MASUMI_ESCROW_OUTPUT_COUNT);
  const output = escrowOutputs[0];
  if (output.datum === undefined) return fail(ERR_MASUMI_DATUM_MISSING);
  // Masumi treats a set `reference_script_hash` as a spoofing attempt.
  if (output.hasReferenceScript) return fail(ERR_MASUMI_REFERENCE_SCRIPT);

  const datumHex = output.datum;
  const view = parseMasumiLockDatum(datumHex);
  if (!view) return fail(ERR_MASUMI_DATUM_INVALID, "datum does not match masumi.vested_pay.v2");

  const datumInvariants = verifyMasumiDatumInvariants(view, escrowAddress);
  if (!datumInvariants.ok) return datumInvariants;
  // The tx MUST carry a validity upper bound on/before pay_by_time, so the lock
  // cannot settle past the deadline.
  if (decoded.ttlSlot === undefined) return fail(ERR_MASUMI_DEADLINE, "no validity upper bound");
  if (BigInt(slotToPosixMs(requirements.network, decoded.ttlSlot)) > view.payByTime) {
    return fail(ERR_MASUMI_DEADLINE, "TTL is after pay_by_time");
  }

  // Buyer identity: the datum's payment credential must control the nonce input
  // and have witnessed the transaction. Only the payment credential is compared
  // — the buyer may pick any stake part for its own address.
  const payerCredentials = addressCredentials(context.payer);
  if (view.buyer.payment.hash !== payerCredentials.payment.hash) {
    return fail(ERR_MASUMI_DATUM_MISMATCH, "buyer does not control the nonce input");
  }
  if (!decoded.vkeyHashes.includes(view.buyer.payment.hash)) {
    return fail(ERR_MASUMI_DATUM_MISMATCH, "no witness for the buyer credential");
  }

  // Seller-side datum fields match the signed terms exactly. `buyer_return_address`
  // is buyer-chosen and deliberately not matched.
  if (!sameCredentials(view.seller, addressCredentials(terms.sellerAddress))) {
    return fail(ERR_MASUMI_DATUM_MISMATCH, "seller");
  }
  if (!returnAddressMatches(terms.sellerReturnAddress, view.sellerReturnAddress)) {
    return fail(ERR_MASUMI_DATUM_MISMATCH, "seller_return_address");
  }
  const agentIdentifier = typeof terms.agentIdentifier === "string" ? terms.agentIdentifier : "";
  const byteFields: Array<[string, string, string]> = [
    ["reference_key", extra.referenceKey, view.referenceKey],
    ["reference_signature", extra.referenceSignature, view.referenceSignature],
    ["seller_nonce", terms.sellerNonce, view.sellerNonce],
    ["buyer_nonce", terms.buyerNonce, view.buyerNonce],
    ["agent_identifier", agentIdentifier, view.agentIdentifier],
    ["input_hash", terms.inputHash, view.inputHash],
  ];
  for (const [field, declared, actual] of byteFields) {
    if (declared.toLowerCase() !== actual) return fail(ERR_MASUMI_DATUM_MISMATCH, field);
  }
  const timeFields: Array<[string, string, bigint]> = [
    ["pay_by_time", terms.payByTime, view.payByTime],
    ["submit_result_time", terms.submitResultTime, view.submitResultTime],
    ["unlock_time", terms.unlockTime, view.unlockTime],
    [
      "external_dispute_unlock_time",
      terms.externalDisputeUnlockTime,
      view.externalDisputeUnlockTime,
    ],
  ];
  for (const [field, declared, actual] of timeFields) {
    if (BigInt(declared) !== actual) return fail(ERR_MASUMI_DATUM_MISMATCH, field);
  }

  // Value: `lockedLovelace = requestedLovelace + collateral_return_lovelace`
  // exactly, with the collateral either zero or at/above the Masumi floor.
  const amount = BigInt(requirements.amount);
  const assetKey = requirements.asset.toLowerCase();
  const isLovelace = assetKey === LOVELACE_ASSET;
  const requestedLovelace = isLovelace ? amount : 0n;
  const collateral = view.collateralReturnLovelace;
  if (collateral < 0n || (collateral > 0n && collateral < MASUMI_MIN_COLLATERAL_LOVELACE)) {
    return fail(ERR_MASUMI_COLLATERAL, `collateral ${collateral} below the floor`);
  }
  if (output.coin !== requestedLovelace + collateral) {
    return fail(
      ERR_MASUMI_COLLATERAL,
      `locked ${output.coin} lovelace, expected ${requestedLovelace + collateral}`,
    );
  }
  if (!isLovelace && output.assets[assetKey] !== amount) {
    return fail(ERR_MASUMI_ASSET, "native token amount is not exact");
  }
  // The escrow output carries EXACTLY the requested asset set.
  if (Object.keys(output.assets).length !== (isLovelace ? 0 : 1)) {
    return fail(ERR_MASUMI_ASSET, "escrow output carries extra native tokens");
  }

  // min-UTXO with post-`SubmitResult` headroom: the escrow must still clear the
  // protocol minimum once `result_hash` is 32 bytes and the cooldowns non-zero,
  // otherwise the seller can never spend it.
  if (context.coinsPerUtxoByte !== undefined) {
    const requiredMinUtxo = masumiMinUtxoLovelace(
      datumHex.length / 2,
      Object.keys(output.assets).length,
      context.coinsPerUtxoByte,
    );
    if (output.coin < requiredMinUtxo) {
      return fail(
        ERR_MASUMI_MIN_UTXO,
        `locked ${output.coin}, post-result minimum ${requiredMinUtxo}`,
      );
    }
  }

  return { ok: true };
}
