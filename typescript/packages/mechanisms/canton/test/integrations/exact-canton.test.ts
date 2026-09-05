/**
 * Integration: client → server → facilitator, using stubbed Canton signers so
 * the flow runs without a live participant. Proves the pieces compose:
 * the client builds+signs an inline payload the server's enhanced 402 asks for,
 * and the facilitator verifies and settles it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PaymentRequirements, SupportedKind } from "@x402/core/types";
import { ExactCantonScheme as ClientScheme } from "../../src/exact/client/scheme.js";
import { ExactCantonScheme as ServerScheme } from "../../src/exact/server/scheme.js";
import { ExactCantonScheme as FacilitatorScheme } from "../../src/exact/facilitator/scheme.js";
import { decodePrepared } from "../../src/prepared-transfer.js";
import { SubmissionOutcomeUnknownError } from "../../src/ledger/transfer-factory.js";
import type { ClientCantonSigner, FacilitatorCantonSigner } from "../../src/signer.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const CC_RAW = readFileSync(FIX + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim();
const CC = JSON.parse(readFileSync(FIX + "mainnet-0.1.21.json", "utf8")).transfer as {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
};

const FAC = "facilitator::1220" + "ff".repeat(32);
const NETWORK = "canton:mainnet" as const;
const SYNC = "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

// Run inside the fixture's ledger window so verify-before-sign (client) and the
// facilitator's timing checks — both read the wall clock — accept the capture.
beforeEach(() => {
  const prep = decodePrepared(CC_RAW).preparationTime ?? 0n;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(prep / 1000n) + 1000);
});
afterEach(() => vi.useRealTimers());

/** Client signer: hands back the captured transfer + a plausible hash/sig. */
function clientSigner(): ClientCantonSigner {
  return {
    party: CC.sender,
    prepareTransfer: async () => ({ preparedTransaction: CC_RAW }),
    // The signer recomputes the hash from the exact bytes and signs it.
    signPrepared: async () => ({
      preparedTxHashHex: "ab".repeat(32),
      signatureB64: Buffer.alloc(64, 3).toString("base64"),
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2" as const,
    }),
  };
}

function facilitatorSigner(executes: string[]): FacilitatorCantonSigner {
  return {
    getAddresses: () => [FAC],
    verifySignature: async () => ({ verified: true, preparedTxHashHex: "cd".repeat(32) }),
    fetchPreapproval: async () => ({
      receiver: CC.receiver,
      dso: CC.instrumentId.admin,
      expiresAt: new Date(Date.now() + 1_000_000_000).toISOString(),
    }),
    executeSubmission: async () => {
      executes.push("executed");
      return { updateId: "1220-settled", transferred: true };
    },
  };
}

/** Steps 1–2 of the flow: the server's enhanced 402 and the client's signed
 *  inline payload, ready to hand a facilitator for verify/settle. */
async function buildFlow(): Promise<{ reqs: PaymentRequirements; payload: unknown }> {
  const server = new ServerScheme();
  const supported: SupportedKind = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    extra: { feePayer: FAC, synchronizerId: SYNC },
  };
  const baseReqs: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    amount: "100000000",
    asset: "CC",
    payTo: CC.receiver,
    maxTimeoutSeconds: 60,
    extra: { instrumentId: CC.instrumentId, executeBeforeSeconds: 120 },
  };
  const reqs = await server.enhancePaymentRequirements(baseReqs, supported, []);
  const client = new ClientScheme(clientSigner());
  const env = await client.createPaymentPayload(2, reqs);
  const payload = { x402Version: 2, accepted: reqs, payload: env.payload };
  return { reqs, payload };
}

describe("exact/canton integration (CC, stubbed signers)", () => {
  it("client builds a payload the facilitator verifies and settles", async () => {
    // 1. Merchant builds the 402, server enhances it with the facilitator extra.
    const server = new ServerScheme();
    const supported: SupportedKind = {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      extra: {
        feePayer: FAC,
        synchronizerId:
          "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
      },
    };
    const baseReqs: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      amount: "100000000", // 0.01 CC
      asset: "CC",
      payTo: CC.receiver,
      maxTimeoutSeconds: 60,
      extra: { instrumentId: CC.instrumentId, executeBeforeSeconds: 120 },
    };
    const reqs = await server.enhancePaymentRequirements(baseReqs, supported, []);
    expect(reqs.extra.feePayer).toBe(FAC);

    // 2. Client builds + verify-before-signs + signs the inline payload.
    const client = new ClientScheme(clientSigner());
    const env = await client.createPaymentPayload(2, reqs);
    expect(env.payload.assetTransferMethod).toBe("transfer-factory");
    expect(typeof env.payload.preparedTransaction).toBe("string");

    const payload = { x402Version: 2, accepted: reqs, payload: env.payload };

    // 3. Facilitator verifies then settles.
    const executes: string[] = [];
    const facilitator = new FacilitatorScheme(facilitatorSigner(executes), {
      synchronizerId:
        "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
    });

    const verify = await facilitator.verify(payload, reqs);
    expect(verify.isValid).toBe(true);
    expect(verify.payer).toBe(CC.sender);

    const settle = await facilitator.settle(payload, reqs);
    expect(settle.success).toBe(true);
    expect(settle.transaction).toBe("1220-settled");
    expect(executes).toHaveLength(1);
  });

  // Fund-safety: an execute that COMMITTED but whose outcome could not be read is
  // not a rejection. Reporting it as the retryable execute-failed reason would
  // invite the payer to pay again, so settle must surface the non-retryable
  // ledger-read error instead.
  it("settle maps an unknown execute outcome to the non-retryable ledger error", async () => {
    const { reqs, payload } = await buildFlow();
    const signer: FacilitatorCantonSigner = {
      ...facilitatorSigner([]),
      executeSubmission: async () => {
        throw new SubmissionOutcomeUnknownError(new Error("completion read timed out"));
      },
    };
    const facilitator = new FacilitatorScheme(signer, { synchronizerId: SYNC });

    const settle = await facilitator.settle(payload as never, reqs);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("unexpected_canton_ledger_error");
  });

  it("settle maps a definite execute rejection to the retryable execute-failed error", async () => {
    const { reqs, payload } = await buildFlow();
    const signer: FacilitatorCantonSigner = {
      ...facilitatorSigner([]),
      executeSubmission: async () => {
        throw new Error("SUBMISSION_FAILED: rejected");
      },
    };
    const facilitator = new FacilitatorScheme(signer, { synchronizerId: SYNC });

    const settle = await facilitator.settle(payload as never, reqs);
    expect(settle.success).toBe(false);
    expect(settle.errorReason).toBe("invalid_exact_canton_execute_failed");
  });
});
