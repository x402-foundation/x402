/**
 * Tests for the Authorization Evidence Extension
 */
import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_EVIDENCE,
  AUTHORIZATION_EVIDENCE_PROFILE,
  AuthorizationEvidenceClientExtension,
  buildEvidenceVerifierRequest,
  createAuthorizationEvidenceResourceServerExtension,
  createCommandVerifier,
  createInMemoryNonceStore,
  decideAuthorizationEvidence,
  declareAuthorizationEvidenceExtension,
  denialReason,
  mintChallengeNonce,
  runEvcVerifier,
  validateChallengeNonce,
} from "../src/authorization-evidence";
import type {
  AuthorizationEvidenceServerOptions,
  AuthorizationEvidenceVerifier,
  EvcDecision,
  PaymentRequirementLike,
} from "../src/authorization-evidence";

const REQUIREMENT: PaymentRequirementLike = {
  network: "base-sepolia",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "25000000",
  payTo: "api.merchant.example",
};

/**
 * Build a stub verifier returning a fixed decision.
 *
 * @param decision - The decision every verify call returns
 * @returns A verifier usable in server options
 */
function stubVerifier(decision: EvcDecision): AuthorizationEvidenceVerifier {
  return { verify: async () => decision };
}

/**
 * Build server options around a stub verifier with a pinned clock.
 *
 * @param decision - The stub verifier's fixed decision
 * @returns Options for decideAuthorizationEvidence and the server factory
 */
function stubOptions(decision: EvcDecision): AuthorizationEvidenceServerOptions {
  return {
    audience: "api.merchant.example",
    verifier: stubVerifier(decision),
    now: () => 1_000_000,
  };
}

/**
 * Build a verifier command that prints one fixed stdout and exits 0.
 *
 * @param stdout - The exact stdout the verifier writes
 * @returns argv for runEvcVerifier
 */
function scriptedVerifier(stdout: string): string[] {
  return ["node", "-e", `process.stdout.write(${JSON.stringify(stdout)})`];
}

describe("Authorization Evidence Extension", () => {
  describe("constants", () => {
    it("should expose the extension key", () => {
      expect(AUTHORIZATION_EVIDENCE).toBe("authorization-evidence");
      expect(AUTHORIZATION_EVIDENCE_PROFILE).toBe("authorization-evidence/0");
    });
  });

  describe("declareAuthorizationEvidenceExtension", () => {
    it("should return a keyed { info, schema } declaration", () => {
      const declared = declareAuthorizationEvidenceExtension();
      const declaration = declared[AUTHORIZATION_EVIDENCE];
      expect(declaration.info.profile).toBe(AUTHORIZATION_EVIDENCE_PROFILE);
      expect(declaration.schema).toBeDefined();
    });

    it("should reject a non-positive challenge lifetime", () => {
      expect(() => declareAuthorizationEvidenceExtension({ challengeTtlSeconds: 0 })).toThrow(
        /challengeTtlSeconds/,
      );
    });
  });

  describe("createAuthorizationEvidenceResourceServerExtension", () => {
    it("should expose the key and dynamic challenge fields", () => {
      const extension = createAuthorizationEvidenceResourceServerExtension(
        stubOptions({ decision: "allow" }),
      );
      expect(extension.key).toBe(AUTHORIZATION_EVIDENCE);
      expect(extension.dynamicInfoFields).toEqual(["nonce", "expiresAt"]);
      expect(extension.hooks?.onBeforeVerify).toBeTypeOf("function");
    });

    it("should reject an empty audience", () => {
      expect(() =>
        createAuthorizationEvidenceResourceServerExtension({
          audience: "",
          verifier: stubVerifier({ decision: "allow" }),
        }),
      ).toThrow(/audience/);
    });

    it("should mint a fresh signed challenge per PaymentRequired response", async () => {
      const extension = createAuthorizationEvidenceResourceServerExtension(
        stubOptions({ decision: "allow" }),
      );
      const declaration = declareAuthorizationEvidenceExtension()[AUTHORIZATION_EVIDENCE];
      const first = (await extension.enrichPaymentRequiredResponse!(declaration, {} as never)) as {
        info: { nonce: string; expiresAt: number };
      };
      const second = (await extension.enrichPaymentRequiredResponse!(declaration, {} as never)) as {
        info: { nonce: string; expiresAt: number };
      };
      expect(first.info.nonce).not.toBe(second.info.nonce);
      expect(first.info.expiresAt).toBe(1_000_000 + 300);
    });
  });

  describe("challenge nonces", () => {
    it("should round-trip a minted nonce", () => {
      const nonce = mintChallengeNonce("secret", 2_000_000);
      const challenge = validateChallengeNonce("secret", nonce, 1_000_000);
      expect(challenge).toEqual({ nonce, expiresAt: 2_000_000 });
    });

    it("should reject a tampered expiry", () => {
      const nonce = mintChallengeNonce("secret", 2_000_000);
      const tampered = nonce.replace(".2000000.", ".9000000.");
      expect(validateChallengeNonce("secret", tampered, 1_000_000)).toBeUndefined();
    });

    it("should reject a stale challenge", () => {
      const nonce = mintChallengeNonce("secret", 2_000_000);
      expect(validateChallengeNonce("secret", nonce, 2_000_001)).toBeUndefined();
    });
  });

  describe("decideAuthorizationEvidence", () => {
    it("should allow when host checks and the verifier both pass", async () => {
      const options = stubOptions({ decision: "allow" });
      const decision = await decideAuthorizationEvidence(
        "evidence",
        REQUIREMENT,
        { nonce: "n1", expiresAt: 1_000_100 },
        "/api/report",
        options,
        createInMemoryNonceStore(() => 1_000_000),
      );
      expect(decision).toEqual({ decision: "allow" });
    });

    it("should deny request_mismatch before the verifier when the payee is not covered", async () => {
      const options = stubOptions({ decision: "allow" });
      const decision = await decideAuthorizationEvidence(
        "evidence",
        { ...REQUIREMENT, payTo: "api.other.example" },
        { nonce: "n1", expiresAt: 1_000_100 },
        "/api/report",
        options,
        createInMemoryNonceStore(() => 1_000_000),
      );
      expect(decision).toEqual({ decision: "deny", code: "request_mismatch" });
    });

    it("should deny nonce_replayed on challenge reuse", async () => {
      const options = stubOptions({ decision: "allow" });
      const store = createInMemoryNonceStore(() => 1_000_000);
      const challenge = { nonce: "n1", expiresAt: 1_000_100 };
      await decideAuthorizationEvidence(
        "evidence",
        REQUIREMENT,
        challenge,
        "/api/report",
        options,
        store,
      );
      const replay = await decideAuthorizationEvidence(
        "evidence",
        REQUIREMENT,
        challenge,
        "/api/report",
        options,
        store,
      );
      expect(replay).toEqual({ decision: "deny", code: "nonce_replayed" });
    });

    it("should relay a verifier deny code unchanged", async () => {
      const options = stubOptions({ decision: "deny", code: "scope_exceeded" });
      const decision = await decideAuthorizationEvidence(
        "evidence",
        REQUIREMENT,
        { nonce: "n1", expiresAt: 1_000_100 },
        "/api/report",
        options,
        createInMemoryNonceStore(() => 1_000_000),
      );
      expect(decision).toEqual({ decision: "deny", code: "scope_exceeded" });
    });
  });

  describe("buildEvidenceVerifierRequest", () => {
    it("should carry the x402 context as an envelope extension member", () => {
      const request = buildEvidenceVerifierRequest(
        "bundle-bytes",
        REQUIREMENT,
        { nonce: "n1", expiresAt: 1_000_100 },
        "/api/report",
        stubOptions({ decision: "allow" }),
      ) as Record<string, unknown>;
      expect(request.version).toBe(1);
      expect(request.bundle).toBe("bundle-bytes");
      expect(request.x402_evc).toMatchObject({
        payee: REQUIREMENT.payTo,
        nonce: "n1",
        amount: REQUIREMENT.amount,
      });
      expect((request.request as { granted_capabilities: string[] }).granted_capabilities).toEqual([
        "mpp:financial:small",
      ]);
    });
  });

  describe("runEvcVerifier", () => {
    it("should relay a schema-valid deny", async () => {
      const decision = await runEvcVerifier("{}", {
        command: scriptedVerifier(
          JSON.stringify({ verdict: "deny", code: "expired", message: "stale" }),
        ),
      });
      expect(decision).toEqual({ decision: "deny", code: "expired" });
    });

    it("should fail closed on an out-of-registry deny code", async () => {
      const decision = await runEvcVerifier("{}", {
        command: scriptedVerifier(
          JSON.stringify({ verdict: "deny", code: "made_up_code", message: "x" }),
        ),
      });
      expect(decision).toEqual({ decision: "deny", failureClass: "schema_invalid" });
    });

    it("should fail closed on a multi-object stdout stream", async () => {
      const decision = await runEvcVerifier("{}", {
        command: scriptedVerifier('{"verdict":"allow"}{"verdict":"allow"}'),
      });
      expect(decision).toEqual({ decision: "deny", failureClass: "multiple_objects" });
    });

    it("should enforce the stdout bound and fail closed", async () => {
      const decision = await runEvcVerifier("{}", {
        command: scriptedVerifier("x".repeat(2048)),
        maxStdoutBytes: 1024,
      });
      expect(decision).toEqual({ decision: "deny", failureClass: "oversize_stdout" });
    });
  });

  describe("denialReason", () => {
    it("should render relayed codes and failure classes distinctly", () => {
      expect(denialReason({ decision: "deny", code: "expired" })).toBe(
        "authorization_evidence_denied: expired",
      );
      expect(denialReason({ decision: "deny", failureClass: "timeout" })).toBe(
        "authorization_evidence_denied: verifier_timeout",
      );
    });
  });

  describe("AuthorizationEvidenceClientExtension", () => {
    it("should echo advertised info and attach the evidence", async () => {
      const extension = new AuthorizationEvidenceClientExtension(async () => "presentation");
      const enriched = await extension.enrichPaymentPayload(
        { extensions: {} },
        {
          extensions: {
            [AUTHORIZATION_EVIDENCE]: {
              info: { profile: AUTHORIZATION_EVIDENCE_PROFILE, nonce: "n1", expiresAt: 5 },
            },
          },
        },
      );
      expect(enriched.extensions?.[AUTHORIZATION_EVIDENCE]).toEqual({
        info: {
          profile: AUTHORIZATION_EVIDENCE_PROFILE,
          nonce: "n1",
          expiresAt: 5,
          evidence: "presentation",
        },
      });
    });

    it("should leave routes without the extension untouched", async () => {
      const extension = new AuthorizationEvidenceClientExtension(async () => "presentation");
      const payload = { extensions: {} };
      const enriched = await extension.enrichPaymentPayload(payload, {});
      expect(enriched).toBe(payload);
    });
  });

  describe("fail-closed hook wrapper", () => {
    it("should abort instead of throwing when the verifier itself throws", async () => {
      const extension = createAuthorizationEvidenceResourceServerExtension({
        audience: "api.merchant.example",
        verifier: {
          verify: async () => {
            throw new Error("adapter exploded");
          },
        },
        now: () => 1_000_000,
        challengeSecret: "secret",
      });
      const nonce = mintChallengeNonce("secret", 1_000_100);
      const context = {
        paymentPayload: {
          x402Version: 2,
          resource: "/api/report",
          extensions: {
            [AUTHORIZATION_EVIDENCE]: { info: { nonce, evidence: "presentation" } },
          },
        },
        requirements: REQUIREMENT,
        declaredExtensions: {},
      };
      const result = await extension.hooks!.onBeforeVerify!({}, context as never);
      expect(result).toEqual({
        abort: true,
        reason: "authorization_evidence_denied: internal_error",
      });
    });
  });

  describe("createCommandVerifier", () => {
    it("should reject an empty command", () => {
      expect(() => createCommandVerifier({ command: [] })).toThrow(/verifier command/);
    });
  });
});
