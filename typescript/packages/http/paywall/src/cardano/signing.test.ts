import { Address, Client, PrivateKey, preprod } from "@evolution-sdk/evolution";
import { decodeCardanoTransaction } from "@x402/cardano";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestCip30Wallet } from "./fixtures/cip30Wallet";
import fixture from "./fixtures/koios-epoch-params-preprod.json";
import { toCip30ProtocolParameters } from "./params";
import { mapKoiosEpochParams } from "./protocolParams";
import { createSignPayment, pinnedRequirementSelector } from "./signing";

const PARAMS = toCip30ProtocolParameters(mapKoiosEpochParams(fixture[0], 0)!);

/**
 * Builds requirements for one payee.
 *
 * @param payTo - Payee.
 * @param extra - Extra block.
 * @returns Requirements.
 */
function req(payTo: string, extra: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "cardano:preprod",
    asset: "lovelace",
    amount: "2000000",
    payTo,
    maxTimeoutSeconds: 600,
    extra,
  };
}

let payTo: string;
beforeEach(async () => {
  payTo = Address.toBech32(
    await Client.make(preprod).withSeed({ mnemonic: PrivateKey.generateMnemonic() }).address(),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network access is forbidden");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pinnedRequirementSelector", () => {
  it("returns only the displayed requirement, regardless of key order", () => {
    const shown = req("addr_test1qx", { assetTransferMethod: "default" });
    const masumi = req("addr_test1qx", { assetTransferMethod: "masumi" });
    // Same requirement, keys in a different order.
    const reordered = Object.fromEntries(Object.entries(shown).reverse()) as PaymentRequirements;
    const select = pinnedRequirementSelector(shown);
    expect(select(2, [masumi, reordered])).toBe(reordered);
    expect(() => select(2, [masumi])).toThrow(/no longer offered/);
  });
});

describe("createSignPayment", () => {
  it("signs only the displayed default requirement on a route that also offers masumi and script", async () => {
    const shim = await createTestCip30Wallet([
      { ref: `${"1".repeat(64)}#0`, owner: 0, lovelace: 20_000_000n },
    ]);
    const selected = req(payTo);
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://api.example.com/premium" },
      accepts: [
        req(payTo, { assetTransferMethod: "masumi" }),
        req(payTo, { assetTransferMethod: "script" }),
        selected,
      ],
    };
    const sign = createSignPayment({
      api: shim.api,
      network: "cardano:preprod",
      protocolParameters: PARAMS,
      clock: { now: () => Date.now() },
      paymentRequired,
      selectedRequirement: selected,
    });
    const signed = await sign(undefined);
    const payload = decodePaymentSignatureHeader(signed.header);
    expect(payload.accepted).toEqual(selected);
    expect(payload.payload.nonce).toBe(`${"1".repeat(64)}#0`);
    expect(signed.nonce).toBe(payload.payload.nonce);
    const tx = decodeCardanoTransaction(payload.payload.transaction as string);
    expect(signed.txId).toBe(tx.txHash);
    expect(tx.outputs.find(o => o.address === payTo)?.coin).toBe(2_000_000n);
    expect(shim.calls.signTx).toBe(1);
    expect(shim.calls.submitTx).toBe(0);
  });

  it("spends the pinned nonce it is given", async () => {
    const shim = await createTestCip30Wallet([
      { ref: `${"1".repeat(64)}#0`, owner: 0, lovelace: 20_000_000n },
      { ref: `${"9".repeat(64)}#2`, owner: 1, lovelace: 20_000_000n },
    ]);
    const selected = req(payTo);
    const sign = createSignPayment({
      api: shim.api,
      network: "cardano:preprod",
      protocolParameters: PARAMS,
      clock: { now: () => Date.now() },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://api.example.com/premium" },
        accepts: [selected],
      },
      selectedRequirement: selected,
    });
    expect((await sign(`${"9".repeat(64)}#2`)).nonce).toBe(`${"9".repeat(64)}#2`);
  });

  it("refuses when the displayed requirement is no longer offered", async () => {
    const shim = await createTestCip30Wallet([
      { ref: `${"1".repeat(64)}#0`, owner: 0, lovelace: 20_000_000n },
    ]);
    const sign = createSignPayment({
      api: shim.api,
      network: "cardano:preprod",
      protocolParameters: PARAMS,
      clock: { now: () => Date.now() },
      paymentRequired: {
        x402Version: 2,
        resource: { url: "https://api.example.com/premium" },
        accepts: [req(payTo, { assetTransferMethod: "masumi" })],
      },
      selectedRequirement: req(payTo),
    });
    await expect(sign(undefined)).rejects.toThrow(/no longer offered/);
    expect(shim.calls.signTx).toBe(0);
  });
});
