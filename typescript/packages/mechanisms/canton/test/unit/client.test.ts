/**
 * Client scheme: builds the inline payload from what the signer prepared, but
 * only after verify-before-sign pins it to the payment requirements.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactCantonScheme } from "../../src/exact/client/scheme.js";
import { decodeInlinePaymentPayload } from "../../src/inline-payload.js";
import { decodePrepared } from "../../src/prepared-transfer.js";
import type { ClientCantonSigner } from "../../src/signer.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const CC_RAW = readFileSync(FIX + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim();
const CC = JSON.parse(readFileSync(FIX + "mainnet-0.1.21.json", "utf8")).transfer as {
  sender: string;
  receiver: string;
  instrumentId: { admin: string; id: string };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Number(decodePrepared(CC_RAW).preparationTime! / 1000n) + 1000);
});
afterEach(() => vi.useRealTimers());

/**
 * A signer that prepares the captured transfer and records what it was asked.
 *
 * @returns The signer and the prepare requests.
 */
function signer() {
  const asked: Array<Parameters<ClientCantonSigner["prepareTransfer"]>[0]> = [];
  const s: ClientCantonSigner = {
    party: CC.sender,
    prepareTransfer: async input => {
      asked.push(input);
      return { preparedTransaction: CC_RAW };
    },
    signPrepared: async () => ({
      preparedTxHashHex: "ab".repeat(32),
      signatureB64: Buffer.alloc(64, 3).toString("base64"),
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
    }),
  };
  return { s, asked };
}

const reqs = (extra: Record<string, unknown> = {}, over: Partial<PaymentRequirements> = {}) =>
  ({
    scheme: "exact",
    network: "canton:mainnet",
    amount: "100000000",
    asset: "CC",
    payTo: CC.receiver,
    maxTimeoutSeconds: 60,
    extra: { instrumentId: CC.instrumentId, executeBeforeSeconds: 120, ...extra },
    ...over,
  }) as PaymentRequirements;

describe("client createPaymentPayload", () => {
  it("prepares the requested transfer and carries the signed bytes inline", async () => {
    const { s, asked } = signer();
    const out = await new ExactCantonScheme(s).createPaymentPayload(2, reqs());
    expect(asked[0]).toEqual({
      receiver: CC.receiver,
      amount: "0.0100000000",
      instrumentId: CC.instrumentId,
      executeBeforeSeconds: 120,
    });
    const decoded = decodeInlinePaymentPayload(out.payload);
    expect(decoded.preparedTransactionBytes.toString("base64")).toBe(CC_RAW);
    expect(decoded.claimedPreparedTxHash).toBe("ab".repeat(32));
    expect(out.payload.assetTransferMethod).toBe("transfer-factory");
  });

  it("defaults the deadline and forwards a memo", async () => {
    const { s, asked } = signer();
    await new ExactCantonScheme(s)
      .createPaymentPayload(2, reqs({ executeBeforeSeconds: undefined, memo: "m-1" }))
      .catch(() => undefined);
    expect(asked[0]).toMatchObject({ executeBeforeSeconds: 60, memo: "m-1" });
  });

  it("refuses to sign bytes that pay someone else", async () => {
    const { s } = signer();
    await expect(
      new ExactCantonScheme(s).createPaymentPayload(
        2,
        reqs({}, { payTo: "attacker::1220" + "00".repeat(32) }),
      ),
    ).rejects.toThrow();
  });

  it("refuses requirements without an instrument id", async () => {
    const { s } = signer();
    await expect(
      new ExactCantonScheme(s).createPaymentPayload(2, reqs({ instrumentId: undefined })),
    ).rejects.toThrow(/instrumentId/);
  });
});
