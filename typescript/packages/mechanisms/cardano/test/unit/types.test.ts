import { describe, expect, it } from "vitest";
import type {
  CardanoExtraDefault,
  CardanoExtraMasumi,
  CardanoExtraScript,
  ExactCardanoPayload,
} from "../../src/types";

describe("Cardano Types", () => {
  it("accepts a default extra", () => {
    const extra: CardanoExtraDefault = {};
    expect(extra).toBeDefined();
  });

  it("accepts the shared submission and confirmation policies", () => {
    const extra: CardanoExtraDefault = {
      submissionPolicy: "either",
      confirmationPolicy: { l1Confirmations: 3 },
    };
    expect(extra.submissionPolicy).toBe("either");
  });

  it("accepts a Masumi extra with all required fields", () => {
    const extra: CardanoExtraMasumi = {
      assetTransferMethod: "masumi",
      submissionPolicy: "server",
      confirmationPolicy: { l1Confirmations: 1 },
      inputCommitment: {
        version: "1",
        algorithm: "sha256",
        parts: [
          {
            name: "body",
            canonicalization: "jcs",
            mediaType: "application/json",
            content: { days: 3 },
            digest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          },
        ],
        digest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
      terms: {
        version: "1",
        paymentType: "Web3CardanoV2",
        sellerAddress: "addr_test1q...",
        sellerNonce: "ab".repeat(32),
        buyerNonce: "",
        inputHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        payByTime: "1713626260000",
        submitResultTime: "1713636260000",
        unlockTime: "1713640260000",
        externalDisputeUnlockTime: "1713644260000",
        settlementPolicy: "auto",
      },
      referenceKey: "a10101",
      referenceSignature: "55".repeat(16),
      blockchainIdentifier: "deadbeef",
      deployment: {
        requiredAdmins: "2",
        adminVkeys: ["fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75"],
        cooldownPeriod: "420000",
      },
    };
    expect(extra.assetTransferMethod).toBe("masumi");
    // `agentIdentifier` is optional; omitting it means the seller is unregistered.
    expect(extra.terms.agentIdentifier).toBeUndefined();
  });

  it("accepts a Script extra with parameters", () => {
    const extra: CardanoExtraScript = {
      assetTransferMethod: "script",
      scriptHash: "abc",
      script: { type: "plutusV3", code: "deadbeef" },
      parameters: { greeting: { type: "bytes", value: "Hello" } },
    };
    expect(extra.assetTransferMethod).toBe("script");
    expect(extra.parameters?.greeting.value).toBe("Hello");
  });

  it("accepts a payload with transaction and nonce", () => {
    const payload: ExactCardanoPayload = {
      transaction: "AAA=",
      nonce: `${"a".repeat(64)}#0`,
    };
    expect(payload.transaction).toBe("AAA=");
    expect(payload.nonce.endsWith("#0")).toBe(true);
  });

  it("accepts the optional settlement fields on a payload", () => {
    const payload: ExactCardanoPayload = {
      transaction: "AAA=",
      nonce: `${"a".repeat(64)}#0`,
      submissionMode: "client",
      settlementLayer: "hydra",
      headId: "a".repeat(56),
    };
    expect(payload.settlementLayer).toBe("hydra");
  });
});
