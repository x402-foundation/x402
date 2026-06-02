/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { verifyCredential } from "did-jwt-vc";
import { getDidResolver } from "../credential/resolver";
import { meetsKycRequirement } from "../identity/principal";
import {
  resolveAcceptedIssuers,
  verifyDidDocumentHash,
  type TrustListCache,
} from "../credential/trustlist";
import type { DailyLimitStore } from "../storage";
import { checkCredentialStatus, type StatusListCache } from "./revocation";
import { verifySdJwtVcPresentation } from "./sdjwtvc";
import type { Resolvable } from "did-resolver";
import type {
  IdentityEnvelope,
  IdentityRequirements,
  VerificationResult,
  FullVerificationResult,
  VCXCredentialSubject,
} from "../types";

/**
 * Additional context the verifier needs to enforce the full §9.2
 * delegation conditions. Each field is optional so the v0.2 call site
 * (`verifyEnvelope(env, req, sender)`) still type-checks; when a
 * delegation includes `maxPerTransaction` but the caller didn't supply
 * `paymentAmount`, the verifier fails-closed (cannot enforce a MUST →
 * MUST reject).
 */
export interface VerifyEnvelopeOptions {
  /**
   * The amount being charged on the matching x402 payment payload, as a
   * decimal string in the scheme's smallest unit (matching the units
   * `delegatedTo.conditions.maxPerTransaction` is expressed in). Required
   * whenever the credential's delegation carries `maxPerTransaction`.
   */
  paymentAmount?: string;
  /**
   * Stateful store for `delegatedTo.conditions.maxDaily` (spec §9.2).
   * No default implementation; see {@link DailyLimitStore} for guidance.
   */
  dailyLimitStore?: DailyLimitStore;
  /**
   * When true, missing context that prevents enforcement of a present
   * delegation condition causes a verification failure. When false
   * (default), the verifier logs a `console.warn` and skips that specific
   * check. Production deployments in regulated environments SHOULD set
   * `strictDelegationConditions: true`.
   */
  strictDelegationConditions?: boolean;
  /**
   * Cache for fetched Bitstring Status List bodies (spec §11.2). When
   * omitted, the verifier instantiates a fresh
   * {@link InMemoryStatusListCache} per call — fine for tests but a
   * production deployment SHOULD pass a long-lived cache so consecutive
   * verifications against the same status list don't refetch.
   */
  statusListCache?: StatusListCache;
  /**
   * Cache for resolved well-known trust lists (spec §8.2). Same
   * production-vs-test tradeoff as `statusListCache`.
   */
  trustListCache?: TrustListCache;
  /**
   * Override the `fetch` used to retrieve status lists. Defaults to the
   * global `fetch`. Primarily for testing — production verifiers can
   * also wrap `fetch` to add timeouts, retries, or proxy routing.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Whitelist of keys permitted inside `delegatedTo.conditions` (spec §9.2,
 * with the fail-closed rule normatively enforced by §13.4). Any other
 * key in the conditions object causes the verifier to reject the
 * envelope, even if every recognised condition would otherwise pass.
 */
const KNOWN_CONDITION_KEYS = new Set([
  "maxPerTransaction",
  "maxDaily",
  "allowedNetworks",
  "allowedAssets",
  "expiresAt",
]);

/**
 * Maximum delegation lifetime per spec §9.2 (30 days from credential
 * issuance). v1.1 may add a profile relaxing this for verified
 * institutional principals; v1 verifiers MUST enforce it unconditionally.
 */
const MAX_DELEGATION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

export async function verifyEnvelope(
  envelope: IdentityEnvelope,
  requirements: IdentityRequirements,
  paymentSender: string,
  options: VerifyEnvelopeOptions = {},
): Promise<FullVerificationResult> {
  const steps: VerificationResult[] = [];

  // Envelope shape precondition (spec §6): vcxPresent MUST be the literal
  // true. A missing or wrong-typed value indicates either a malformed
  // envelope or a sender on a non-VCX protocol; reject before touching the
  // credential.
  if ((envelope as { vcxPresent?: unknown }).vcxPresent !== true) {
    steps.push({
      step: "principal_credential",
      success: false,
      error: "Envelope vcxPresent field MUST be the literal true (spec §6)",
    });
    return { valid: false, steps };
  }

  // Step 1: Principal Credential — verifies the JWS and returns the
  // verified credentialSubject so Step 2 doesn't have to re-parse the JWT.
  const step1 = await verifyPrincipalCredential(envelope, requirements, options);
  steps.push(step1.result);
  if (!step1.result.success || !step1.subject) {
    return { valid: false, steps };
  }

  // Step 2: Agent Delegation
  const step2 = await verifyAgentDelegation({
    envelope,
    subject: step1.subject,
    credentialNbf: step1.credentialNbf,
    options,
  });
  steps.push(step2);
  if (!step2.success) return { valid: false, steps };

  // Step 3: Payment Source Binding
  const step3 = verifyPaymentSourceBinding(envelope, paymentSender);
  steps.push(step3);
  if (!step3.success) return { valid: false, steps };

  // Step 4: Payment Settlement (delegated to x402 v2 core; this step is a
  // placeholder so the result shape stays consistent. The server extension
  // is responsible for marking step 4 as success only when x402 settlement
  // has actually reported success.)
  steps.push({ step: "payment_settlement", success: true });

  return { valid: true, steps };
}

interface Step1Result {
  result: VerificationResult;
  subject?: VCXCredentialSubject;
  /**
   * `nbf` claim from the JWT-encoded VC (epoch seconds). Step 2 uses
   * this as the issuance baseline for the 30-day `expiresAt` cap. May
   * be undefined if the credential omits `nbf`, in which case Step 2
   * cannot enforce the cap and rejects per the spec MUST.
   */
  credentialNbf?: number;
}

async function verifyPrincipalCredential(
  envelope: IdentityEnvelope,
  requirements: IdentityRequirements,
  options: VerifyEnvelopeOptions,
): Promise<Step1Result> {
  const result: VerificationResult = {
    step: "principal_credential",
    success: false,
  };

  // Spec §6.1: credentialFormat MUST be present and MUST be one of the
  // two enum values. v0.2.0 verifies "jwt-vc" only; "sd-jwt-vc" is
  // typed-and-accepted by the envelope shape but its verification path
  // is deferred to v1.0.0 (PR #6 in the v1.0 roadmap).
  const format = (envelope.principal as { credentialFormat?: unknown })
    .credentialFormat;
  if (format !== "jwt-vc" && format !== "sd-jwt-vc") {
    result.error = `principal.credentialFormat MUST be "jwt-vc" or "sd-jwt-vc" (spec §6.1); got ${
      typeof format === "string" ? `"${format}"` : String(format)
    }`;
    return { result };
  }
  try {
    const resolver = getDidResolver();
    const normalized = await verifyAndNormalize(envelope, resolver, format);
    if (!normalized.ok) {
      result.error = normalized.error;
      return { result };
    }
    const { issuer, payload, subject, disclosed, credentialNbf } = normalized;

    // Spec §8: resolve each acceptedIssuers reference (inline DID,
    // well-known JWS-signed URL, or ETSI URL) to a flat entry list.
    let trustList;
    try {
      trustList = await resolveAcceptedIssuers(requirements.acceptedIssuers, {
        resolver,
        cache: options.trustListCache,
        fetchImpl: options.fetchImpl,
      });
    } catch (err) {
      result.error = `Trust-list resolution failed: ${err instanceof Error ? err.message : String(err)}`;
      return { result };
    }
    const matchedEntry = trustList.find((e) => e.did === issuer);
    if (!matchedEntry) {
      result.error = `Issuer ${issuer} not in resolved trust list (${trustList.length} entries)`;
      return { result };
    }

    // Spec §8.2 didDocumentHash pinning: when the trust list publishes
    // a hash, the resolved DID document MUST match exactly. This
    // neutralizes DNS/BGP/TLS-MITM substitution attacks against
    // `did:web` issuers (spec §13.3).
    if (matchedEntry.didDocumentHash) {
      const hashCheck = await verifyDidDocumentHash({
        issuerDid: issuer,
        expectedHash: matchedEntry.didDocumentHash,
        resolver,
      });
      if (!hashCheck.ok) {
        result.error = hashCheck.reason;
        return { result };
      }
    }

    // Spec §11 revocation check (short-lived vs Bitstring Status List
    // v1.0 profile detected from `nbf`/`exp` and `credentialStatus`).
    const revocation = await checkCredentialStatus(payload, {
      issuerDid: issuer,
      resolver,
      cache: options.statusListCache,
      fetchImpl: options.fetchImpl,
    });
    if (!revocation.ok) {
      result.error = revocation.reason;
      return { result };
    }

    if (subject.id !== envelope.principal.did) {
      result.error = `Credential subject ${subject.id} does not match envelope principal ${envelope.principal.did}`;
      return { result };
    }

    // Fail-closed KYC check: when the verifier requires a minimum KYC level,
    // a credential missing or not-a-string kycLevel MUST be rejected.
    if (requirements.minKycLevel) {
      if (
        typeof subject.kycLevel !== "string" ||
        !meetsKycRequirement(subject.kycLevel, requirements.minKycLevel)
      ) {
        const actual = typeof subject.kycLevel === "string"
          ? subject.kycLevel
          : "(missing)";
        result.error = `Credential kycLevel "${actual}" does not meet minimum ${requirements.minKycLevel}`;
        return { result };
      }
    }

    // Disclosed-claim check. For jwt-vc, the disclosed values must
    // equal the corresponding credentialSubject fields (plain-claim
    // path). For sd-jwt-vc, the values were already cryptographically
    // validated against the issuer's _sd digests by
    // verifySdJwtVcPresentation; we just check the envelope's reported
    // disclosed values match what the presentation actually disclosed.
    if (format === "sd-jwt-vc") {
      for (const [claim, disclosedValue] of Object.entries(
        envelope.principal.disclosed,
      )) {
        if (!(claim in disclosed)) {
          result.error = `Disclosed claim "${claim}" was not actually disclosed by the SD-JWT VC presentation`;
          return { result };
        }
        if (!claimsEqual(disclosedValue, disclosed[claim])) {
          result.error = `Disclosed claim "${claim}" value (${JSON.stringify(disclosedValue)}) does not match the SD-JWT VC disclosure (${JSON.stringify(disclosed[claim])})`;
          return { result };
        }
      }
    } else {
      const subjectClaims = subject as unknown as Record<string, unknown>;
      for (const [claim, disclosedValue] of Object.entries(
        envelope.principal.disclosed,
      )) {
        if (!(claim in subjectClaims)) {
          result.error = `Disclosed claim "${claim}" is not present in credential`;
          return { result };
        }
        if (!claimsEqual(disclosedValue, subjectClaims[claim])) {
          result.error = `Disclosed claim "${claim}" does not match credential`;
          return { result };
        }
      }
    }

    if (requirements.requiredClaims) {
      for (const claim of requirements.requiredClaims) {
        if (!(claim in envelope.principal.disclosed)) {
          result.error = `Required claim "${claim}" not disclosed`;
          return { result };
        }
      }
    }

    result.success = true;
    return { result, subject, credentialNbf };
  } catch (err) {
    result.error = `Credential verification error: ${err instanceof Error ? err.message : String(err)}`;
    return { result };
  }
}

interface NormalizedCredential {
  ok: true;
  issuer: string;
  payload: Record<string, unknown>;
  subject: VCXCredentialSubject;
  /**
   * Verified disclosed claims (sd-jwt-vc only). Empty for jwt-vc.
   */
  disclosed: Record<string, unknown>;
  credentialNbf?: number;
}

async function verifyAndNormalize(
  envelope: IdentityEnvelope,
  resolver: Resolvable,
  format: "jwt-vc" | "sd-jwt-vc",
): Promise<NormalizedCredential | { ok: false; error: string }> {
  if (format === "sd-jwt-vc") {
    let v;
    try {
      v = await verifySdJwtVcPresentation({
        sdjwt: envelope.principal.credentialJwt,
        resolver,
      });
    } catch (err) {
      return {
        ok: false,
        error: `Credential verification error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Build a synthetic VCXCredentialSubject from the issuer-signed
    // base (vc.credentialSubject minus the _sd digests) overlaid with
    // the verified disclosures. Fields needed downstream (id, kycLevel,
    // delegatedTo) may live in either the base or the disclosures
    // depending on the issuer's framing.
    const vc = v.payload.vc as
      | { credentialSubject?: Record<string, unknown> }
      | undefined;
    const baseSubject = { ...(vc?.credentialSubject ?? {}) };
    delete baseSubject._sd;
    delete baseSubject._sd_alg;
    const subject = { ...baseSubject, ...v.disclosed } as unknown as
      VCXCredentialSubject;
    return {
      ok: true,
      issuer: v.issuer,
      payload: v.payload,
      subject,
      disclosed: v.disclosed,
      credentialNbf: readEpochClaim(v.payload, "nbf"),
    };
  }
  // jwt-vc: existing did-jwt-vc verifyCredential path.
  const verified = await verifyCredential(envelope.principal.credentialJwt, resolver);
  if (!verified.verified) {
    return { ok: false, error: "Credential JWT signature verification failed" };
  }
  const issuerRaw = verified.verifiableCredential.issuer;
  const issuer =
    typeof issuerRaw === "string"
      ? issuerRaw
      : (issuerRaw as { id?: string })?.id;
  if (!issuer) {
    return { ok: false, error: "Verified credential has no issuer" };
  }
  const subject = verified.verifiableCredential
    .credentialSubject as VCXCredentialSubject;
  return {
    ok: true,
    issuer,
    payload: (verified as { payload?: Record<string, unknown> }).payload ?? {},
    subject,
    disclosed: {},
    credentialNbf: readEpochClaim(
      (verified as { payload?: Record<string, unknown> }).payload,
      "nbf",
    ),
  };
}

function readEpochClaim(
  payload: Record<string, unknown> | undefined,
  key: "nbf" | "exp",
): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function verifyAgentDelegation(args: {
  envelope: IdentityEnvelope;
  subject: VCXCredentialSubject;
  credentialNbf: number | undefined;
  options: VerifyEnvelopeOptions;
}): Promise<VerificationResult> {
  const { envelope, subject, credentialNbf, options } = args;
  const step: VerificationResult = {
    step: "agent_delegation",
    success: false,
  };

  // Spec §6.2 / §10: delegationProofFormat MUST be "vc-embedded" in v1.
  // Reserved values (ucan, cacao, hdp) are not permitted; v1 verifiers
  // MUST reject any other value rather than attempt to interpret it.
  const proofFormat = (envelope.agent as { delegationProofFormat?: unknown })
    .delegationProofFormat;
  if (proofFormat !== "vc-embedded") {
    step.error = `agent.delegationProofFormat MUST be "vc-embedded" in v1 (spec §10); got ${
      typeof proofFormat === "string" ? `"${proofFormat}"` : String(proofFormat)
    }`;
    return step;
  }

  if (!subject.delegatedTo) {
    step.error = "Credential does not contain delegation";
    return step;
  }

  if (subject.delegatedTo.agentDid !== envelope.agent.did) {
    step.error = `Delegated agent DID ${subject.delegatedTo.agentDid} does not match envelope agent ${envelope.agent.did}`;
    return step;
  }

  if (
    subject.delegatedTo.paymentSource &&
    subject.delegatedTo.paymentSource !== envelope.paymentSource.accountId
  ) {
    step.error = `Delegated payment source ${subject.delegatedTo.paymentSource} does not match envelope ${envelope.paymentSource.accountId}`;
    return step;
  }

  const conditions = subject.delegatedTo.conditions;
  if (!conditions) {
    // No conditions block means no expiresAt, which is a spec MUST.
    step.error =
      "Delegation has no conditions block; spec §9.2 requires `expiresAt` to be present";
    return step;
  }

  // Spec §13.4: fail-closed on any condition key the verifier doesn't
  // recognise. A future-version restriction silently ignored grants
  // unbounded authority on this deployment.
  for (const key of Object.keys(conditions)) {
    if (!KNOWN_CONDITION_KEYS.has(key)) {
      step.error = `Unknown delegation condition "${key}"; spec §13.4 requires fail-closed on unrecognised keys`;
      return step;
    }
  }

  // §9.2: expiresAt MUST be present, valid, in the future, and ≤ 30
  // days after the credential's `nbf` (issuance baseline).
  const expiresAt = conditions.expiresAt;
  if (typeof expiresAt !== "string" || expiresAt.length === 0) {
    step.error = "Delegation conditions.expiresAt MUST be present (spec §9.2)";
    return step;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    step.error = "Delegation expiresAt is not a valid ISO 8601 timestamp";
    return step;
  }
  if (expiresAtMs <= Date.now()) {
    step.error = "Delegation has expired";
    return step;
  }
  if (credentialNbf === undefined) {
    step.error =
      "Cannot enforce spec §9.2 30-day expiresAt cap: credential JWT has no `nbf` claim";
    return step;
  }
  const maxExpiresAtMs =
    (credentialNbf + MAX_DELEGATION_LIFETIME_SECONDS) * 1000;
  if (expiresAtMs > maxExpiresAtMs) {
    step.error = `Delegation expiresAt (${expiresAt}) exceeds the 30-day cap from credential issuance (spec §9.2)`;
    return step;
  }

  // §9.2 maxPerTransaction: MUST enforce against payment amount when
  // present. If amount unavailable, fail-closed (cannot satisfy a MUST).
  if (conditions.maxPerTransaction !== undefined) {
    if (options.paymentAmount === undefined) {
      step.error =
        "Delegation conditions.maxPerTransaction is set but no paymentAmount was provided to the verifier (spec §9.2 MUST)";
      return step;
    }
    let limit: bigint;
    let amount: bigint;
    try {
      limit = BigInt(conditions.maxPerTransaction);
      amount = BigInt(options.paymentAmount);
    } catch {
      step.error = `Delegation maxPerTransaction (${conditions.maxPerTransaction}) or paymentAmount (${options.paymentAmount}) is not a parseable decimal integer`;
      return step;
    }
    if (amount > limit) {
      step.error = `Payment amount ${amount.toString()} exceeds delegation maxPerTransaction ${limit.toString()}`;
      return step;
    }
  }

  // §9.2 allowedNetworks: MUST enforce against envelope.paymentSource.network
  // when present. Envelope-layer comparison; no payment-details thread.
  if (conditions.allowedNetworks !== undefined) {
    if (!Array.isArray(conditions.allowedNetworks)) {
      step.error =
        "Delegation conditions.allowedNetworks MUST be an array of CAIP-2 strings";
      return step;
    }
    if (!conditions.allowedNetworks.includes(envelope.paymentSource.network)) {
      step.error = `Payment-source network ${envelope.paymentSource.network} is not in delegation allowedNetworks [${conditions.allowedNetworks.join(", ")}]`;
      return step;
    }
  }

  // §9.2 allowedAssets: MUST enforce against envelope.paymentSource.asset
  // when present. Absent asset + present allowedAssets → reject.
  if (conditions.allowedAssets !== undefined) {
    if (!Array.isArray(conditions.allowedAssets)) {
      step.error =
        "Delegation conditions.allowedAssets MUST be an array of CAIP-19 strings or contract addresses";
      return step;
    }
    if (envelope.paymentSource.asset === undefined) {
      step.error =
        "Delegation conditions.allowedAssets is set but envelope.paymentSource.asset is absent (spec §9.2)";
      return step;
    }
    if (!conditions.allowedAssets.includes(envelope.paymentSource.asset)) {
      step.error = `Payment-source asset ${envelope.paymentSource.asset} is not in delegation allowedAssets [${conditions.allowedAssets.join(", ")}]`;
      return step;
    }
  }

  // §9.2 maxDaily: requires a stateful DailyLimitStore. No default
  // store is shipped (see DailyLimitStore docstring); warn-and-skip
  // unless strict mode is on.
  if (conditions.maxDaily !== undefined) {
    if (!options.dailyLimitStore) {
      if (options.strictDelegationConditions) {
        step.error =
          "Delegation conditions.maxDaily is set but no dailyLimitStore was provided and strictDelegationConditions is true (spec §9.2)";
        return step;
      }
      // eslint-disable-next-line no-console
      console.warn(
        "VCX: delegation carries maxDaily but no DailyLimitStore configured; skipping the check (set strictDelegationConditions: true to fail-closed)",
      );
    } else {
      if (options.paymentAmount === undefined) {
        step.error =
          "Delegation conditions.maxDaily is set but no paymentAmount was provided to the verifier";
        return step;
      }
      let limit: bigint;
      try {
        limit = BigInt(conditions.maxDaily);
      } catch {
        step.error = `Delegation maxDaily (${conditions.maxDaily}) is not a parseable decimal integer`;
        return step;
      }
      const newTotal = await options.dailyLimitStore.addAndGetTotal({
        principalDid: envelope.principal.did,
        agentDid: envelope.agent.did,
        amount: options.paymentAmount,
      });
      let total: bigint;
      try {
        total = BigInt(newTotal);
      } catch {
        step.error = `DailyLimitStore.addAndGetTotal returned non-integer ${newTotal}`;
        return step;
      }
      if (total > limit) {
        step.error = `Daily total ${total.toString()} (including this request) exceeds delegation maxDaily ${limit.toString()}`;
        return step;
      }
    }
  }

  step.success = true;
  return step;
}

function verifyPaymentSourceBinding(
  envelope: IdentityEnvelope,
  paymentSender: string,
): VerificationResult {
  const step: VerificationResult = {
    step: "payment_source_binding",
    success: false,
  };

  const sourceId = envelope.paymentSource.sourceId.toLowerCase();
  const sender = paymentSender.toLowerCase();

  if (sourceId !== sender) {
    step.error = `Payment source ${envelope.paymentSource.sourceId} does not match payment sender ${paymentSender}`;
    return step;
  }

  // Bind sourceId to accountId. For CAIP-10 IDs the address is the last
  // `:`-separated segment; for non-CAIP rail-specific URIs the whole accountId
  // is compared. Without this check, an attacker can satisfy the delegation
  // constraint (Step 2 uses accountId) with one wallet while paying from
  // another (Step 3 uses sourceId), defeating the integrity guarantee that
  // the credential authorised payment from this specific source.
  const accountIdSegments = envelope.paymentSource.accountId.split(":");
  const accountIdAddress =
    accountIdSegments[accountIdSegments.length - 1].toLowerCase();
  if (accountIdAddress !== sourceId) {
    step.error = `paymentSource.sourceId ${envelope.paymentSource.sourceId} does not match the address component of paymentSource.accountId ${envelope.paymentSource.accountId}`;
    return step;
  }

  step.success = true;
  return step;
}

function claimsEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
