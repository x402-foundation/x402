/**
 * Authorization Evidence Resource-Server Extension
 *
 * Factory wiring the extension into a resource server: PaymentRequired
 * responses gain a fresh signed challenge, and `onBeforeVerify` denies the
 * payment before facilitator verification unless the client presented
 * evidence that the configured External Verifier Contract verifier allows.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PaymentRequiredContext, ResourceServerExtension } from "@x402/core/types";
import { decideAuthorizationEvidence, createInMemoryNonceStore, denialReason } from "./verify";
import type { EvidenceChallenge } from "./verify";
import { AUTHORIZATION_EVIDENCE, DEFAULT_CHALLENGE_TTL_SECONDS } from "./types";
import type {
  AuthorizationEvidenceDeclaration,
  AuthorizationEvidenceServerOptions,
  PaymentRequirementLike,
} from "./types";

/**
 * Create the authorization-evidence resource-server extension. Declaring the
 * extension on a route makes evidence mandatory there: v2 payments without a
 * valid presentation are aborted before facilitator verification, and v1
 * payments (which cannot carry extensions) are always aborted on declared
 * routes.
 *
 * @param options - Verifier, audience, and policy configuration
 * @returns The extension to pass to `registerExtension`
 */
export function createAuthorizationEvidenceResourceServerExtension(
  options: AuthorizationEvidenceServerOptions,
): ResourceServerExtension {
  if (typeof options.audience !== "string" || options.audience.length === 0) {
    throw new Error(`Invalid authorization-evidence audience: expected a non-empty string`);
  }
  if (!options.verifier || typeof options.verifier.verify !== "function") {
    throw new Error(`Invalid authorization-evidence verifier: expected a { verify } object`);
  }
  const challengeSecret = options.challengeSecret ?? randomBytes(32).toString("hex");
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  const nonceStore = options.nonceStore ?? createInMemoryNonceStore(now);

  return {
    key: AUTHORIZATION_EVIDENCE,
    dynamicInfoFields: ["nonce", "expiresAt"],
    enrichPaymentRequiredResponse: async (declaration, _: PaymentRequiredContext) => {
      const decl = declaration as AuthorizationEvidenceDeclaration;
      const ttl = decl._options?.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
      const expiresAt = now() + ttl;
      return {
        info: {
          ...decl.info,
          nonce: mintChallengeNonce(challengeSecret, expiresAt),
          expiresAt,
        },
        schema: decl.schema,
      };
    },
    hooks: {
      // The entire hook is wrapped fail-closed: a throw escaping onBeforeVerify
      // is logged and IGNORED by the core (verification would continue), so a
      // throwing operator callback, custom verifier, or nonce store must
      // become a deny here, never an escape.
      onBeforeVerify: async (_declaration, context) => {
        try {
          return await gate();
        } catch {
          return { abort: true, reason: "authorization_evidence_denied: internal_error" };
        }

        /**
         * Run the evidence gate for this verification.
         *
         * @returns The hook directive: undefined to continue, or an abort
         */
        async function gate(): Promise<void | { abort: true; reason: string }> {
          // v1 payloads cannot carry extensions, so a declared route always
          // fails closed for them.
          if (context.paymentPayload.x402Version !== 2) {
            return { abort: true, reason: "authorization_evidence_required" };
          }
          const echoed = (
            context.paymentPayload.extensions as
              | Record<string, { info?: Record<string, unknown> } | undefined>
              | undefined
          )?.[AUTHORIZATION_EVIDENCE]?.info;
          const evidence = echoed?.evidence;
          const nonce = echoed?.nonce;
          if (typeof evidence !== "string" || evidence.length === 0 || typeof nonce !== "string") {
            return { abort: true, reason: "authorization_evidence_required" };
          }

          const challenge = validateChallengeNonce(challengeSecret, nonce, now());
          if (!challenge) {
            return { abort: true, reason: "authorization_evidence_denied: expired" };
          }

          const requirement = context.requirements as unknown as PaymentRequirementLike;
          const decision = await decideAuthorizationEvidence(
            evidence,
            requirement,
            challenge,
            String((context.paymentPayload as { resource?: unknown }).resource ?? ""),
            options,
            nonceStore,
          );
          if (decision.decision === "allow") return;
          return { abort: true, reason: denialReason(decision) };
        }
      },
    },
  };
}

/**
 * Mint a stateless signed challenge nonce: `v0.<expiresAt>.<random>.<hmac>`.
 * The HMAC makes the expiry tamper-evident without server-side challenge
 * state; multi-instance deployments share `challengeSecret`.
 *
 * @param secret - The challenge-signing secret
 * @param expiresAt - Unix seconds after which the challenge is stale
 * @returns The encoded nonce
 */
export function mintChallengeNonce(secret: string, expiresAt: number): string {
  const random = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", secret).update(`${expiresAt}.${random}`).digest("hex");
  return `v0.${expiresAt}.${random}.${mac}`;
}

/**
 * Validate a challenge nonce's signature and freshness.
 *
 * @param secret - The challenge-signing secret
 * @param nonce - The client-echoed nonce
 * @param nowUnix - Current unix seconds
 * @returns The decoded challenge, or undefined when invalid or stale
 */
export function validateChallengeNonce(
  secret: string,
  nonce: string,
  nowUnix: number,
): EvidenceChallenge | undefined {
  const parts = nonce.split(".");
  if (parts.length !== 4 || parts[0] !== "v0") return undefined;
  const expiresAt = Number(parts[1]);
  if (!Number.isInteger(expiresAt)) return undefined;
  const expected = createHmac("sha256", secret).update(`${parts[1]}.${parts[2]}`).digest();
  const presented = Buffer.from(parts[3], "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return undefined;
  }
  if (nowUnix >= expiresAt) return undefined;
  return { nonce, expiresAt };
}
