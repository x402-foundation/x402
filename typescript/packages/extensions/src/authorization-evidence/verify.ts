/**
 * Authorization Evidence Verification
 *
 * Pure building blocks: construct the verifier request for one protected
 * request, run the host-side checks the verifier cannot see (payee coverage,
 * challenge expiry, challenge-nonce replay), and combine both into one
 * closed decision. No HTTP types here; the transport hook adapts these to
 * the request/response surface.
 */

import { runEvcVerifier } from "./evcHost";
import { AUTHORIZATION_EVIDENCE_PROFILE } from "./types";
import type {
  AuthorizationEvidenceServerOptions,
  AuthorizationEvidenceVerifier,
  CommandVerifierOptions,
  EvcDecision,
  EvidenceNonceStore,
  PaymentRequirementLike,
} from "./types";

/**
 * Create the bundled verifier adapter: spawns an External Verifier Contract
 * v1 subprocess per decision. Any EVC-conformant verifier works; the
 * reference implementation is `bolyra verify` from `@bolyra/cli`.
 *
 * @param options - Verifier command and host-enforced bounds
 * @returns A verifier usable in `createAuthorizationEvidenceResourceServerExtension`
 */
export function createCommandVerifier(
  options: CommandVerifierOptions,
): AuthorizationEvidenceVerifier {
  if (!Array.isArray(options.command) || options.command.length === 0) {
    throw new Error(
      `Invalid authorization-evidence verifier command: expected a non-empty argv array`,
    );
  }
  return {
    verify: request => runEvcVerifier(request, options),
  };
}

/**
 * A per-process reserve-before-act nonce store. Suitable for tests and
 * single-instance servers; production deployments should implement
 * `EvidenceNonceStore` over shared durable storage.
 *
 * @param now - Clock override in unix seconds, for tests
 * @returns A fresh in-memory store
 */
export function createInMemoryNonceStore(now?: () => number): EvidenceNonceStore {
  const reserved = new Map<string, number>();
  return {
    reserve(nonces, retainUntilUnix) {
      const nowUnix = now ? now() : Math.floor(Date.now() / 1000);
      for (const [nonce, until] of reserved) {
        if (until < nowUnix) reserved.delete(nonce);
      }
      if (nonces.some(nonce => reserved.has(nonce))) return false;
      for (const nonce of nonces) reserved.set(nonce, retainUntilUnix);
      return true;
    },
  };
}

/** The challenge context minted into the 402 response's extension info. */
export interface EvidenceChallenge {
  nonce: string;
  expiresAt: number;
}

/**
 * Build the External Verifier Contract request for one evidence presentation,
 * carrying the x402 context as an envelope-level extension member that
 * profile-unaware conformant verifiers ignore.
 *
 * @param evidence - The opaque evidence presentation from the request header
 * @param requirement - The payment requirement being authorized
 * @param challenge - The challenge context minted with the 402
 * @param resource - Identifier of the protected resource
 * @param options - Server extension options (audience, program, model, mappers)
 * @returns The verifier request object
 */
export function buildEvidenceVerifierRequest(
  evidence: string,
  requirement: PaymentRequirementLike,
  challenge: EvidenceChallenge,
  resource: string,
  options: AuthorizationEvidenceServerOptions,
): unknown {
  const capabilities = (options.capabilitiesFor ?? defaultCapabilitiesFor)(requirement);
  return {
    version: 1,
    bundle: evidence,
    request: {
      agent_name: "*",
      project_key: options.audience,
      program: options.program ?? "x402",
      model: options.model ?? "*",
      granted_capabilities: capabilities,
    },
    now_unix: (options.now ?? defaultNow)(),
    x402_evc: {
      profile: AUTHORIZATION_EVIDENCE_PROFILE,
      resource,
      amount: requirement.amount,
      asset: requirement.asset,
      network: requirement.network,
      payee: requirement.payTo,
      nonce: challenge.nonce,
      expires_at: challenge.expiresAt,
      verifier: "command",
    },
  };
}

/**
 * Run the full evidence decision for one protected request: host-side payee
 * coverage, challenge expiry, and challenge-nonce replay first (the verifier
 * cannot see these), then the configured verifier. Fail closed on every path.
 *
 * @param evidence - The opaque evidence presentation from the request header
 * @param requirement - The payment requirement being authorized
 * @param challenge - The challenge context echoed by the client
 * @param resource - Identifier of the protected resource
 * @param options - Server extension options
 * @param nonceStore - Reserve-before-act store for the challenge nonce
 * @returns The closed decision
 */
export async function decideAuthorizationEvidence(
  evidence: string,
  requirement: PaymentRequirementLike,
  challenge: EvidenceChallenge,
  resource: string,
  options: AuthorizationEvidenceServerOptions,
  nonceStore: EvidenceNonceStore,
): Promise<EvcDecision> {
  const payeeMatches = options.payeeMatches ?? ((audience, payTo) => audience === payTo);
  if (!payeeMatches(options.audience, requirement.payTo)) {
    return { decision: "deny", code: "request_mismatch" };
  }

  const nowUnix = (options.now ?? defaultNow)();
  if (nowUnix >= challenge.expiresAt) {
    return { decision: "deny", code: "expired" };
  }

  const novel = await nonceStore.reserve([challenge.nonce], challenge.expiresAt);
  if (!novel) {
    return { decision: "deny", code: "nonce_replayed" };
  }

  const request = buildEvidenceVerifierRequest(evidence, requirement, challenge, resource, options);
  return options.verifier.verify(request);
}

/**
 * Render a decision's denial as the abort reason string surfaced in the 403
 * body.
 *
 * @param decision - A deny decision
 * @returns A stable machine-readable reason string
 */
export function denialReason(decision: Exclude<EvcDecision, { decision: "allow" }>): string {
  if ("code" in decision) return `authorization_evidence_denied: ${decision.code}`;
  return `authorization_evidence_denied: verifier_${decision.failureClass}`;
}

/**
 * Default capability mapping: assumes a 1:1 USD stablecoin with 6 decimals
 * and maps the amount to cumulative financial tiers.
 *
 * @param requirement - The payment requirement being authorized
 * @returns The capability tokens the mandate must cover
 */
function defaultCapabilitiesFor(requirement: PaymentRequirementLike): string[] {
  const atomic = Number(requirement.amount);
  if (requirement.amount.trim() === "" || !Number.isFinite(atomic) || atomic < 0) {
    // Unresolvable amounts demand the widest tier: the verifier denies unless
    // the mandate explicitly covers unlimited spend. Fail closed; never guess.
    return ["mpp:financial:unlimited"];
  }
  const usd = atomic / 10 ** 6;
  if (usd < 100) return ["mpp:financial:small"];
  if (usd < 10_000) return ["mpp:financial:medium"];
  return ["mpp:financial:unlimited"];
}

/**
 * Read the current unix time in seconds.
 *
 * @returns Seconds since the epoch
 */
function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}
