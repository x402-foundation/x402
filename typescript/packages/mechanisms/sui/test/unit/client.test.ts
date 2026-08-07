import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { describe, expect, it, vi } from "vitest";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import { ExactSuiScheme } from "../../src/exact/client/scheme";
import { SUI_TESTNET_CAIP2 } from "../../src/constants";
import { pureInputsBase64, transactionCarriesNonce } from "../../src/utils";
import type { ExactSuiPayload } from "../../src/types";
import { fromBase64, payer, payerKeypair, testRequirements } from "./helpers";

/**
 * A mock client that resolves gas/coin-balance offline so createPaymentPayload
 * can build without a network.
 *
 * @returns The mock client
 */
function offlineClient() {
  return {
    core: {
      getBalance: vi.fn().mockResolvedValue({
        balance: { balance: "999999999999", addressBalance: "999999999999", coinBalance: "0" },
      }),
      listCoins: vi.fn().mockResolvedValue({ objects: [], hasNextPage: false, cursor: null }),
      resolveTransactionPlugin: vi
        .fn()
        .mockReturnValue(
          async (
            data: { gasData: { price: unknown; budget: unknown; payment: unknown } },
            _o: unknown,
            next: () => Promise<void>,
          ) => {
            data.gasData.price = "1000";
            data.gasData.budget = "5000000";
            data.gasData.payment = [];
            await next();
          },
        ),
    },
  } as never;
}

describe("ExactSuiScheme client", () => {
  const scheme = new ExactSuiScheme(payerKeypair, {
    clients: { [SUI_TESTNET_CAIP2]: offlineClient() },
  });

  it("builds a signed payment bound to the sender with no embedded nonce", async () => {
    const result = await scheme.createPaymentPayload(2, testRequirements());
    const payload = result.payload as ExactSuiPayload;
    const data = Transaction.from(payload.transaction).getData();
    expect(data.sender).toBe(payer);

    expect(transactionCarriesNonce(data, "q6urq6urq6s=")).toBe(false);

    await expect(
      verifyTransactionSignature(fromBase64(payload.transaction), payload.signature, {
        address: payer,
      }),
    ).resolves.toBeDefined();
  });

  it("embeds a declared server nonce as a Pure input", async () => {
    const nonce = "q6urq6urq6s="; // 8 bytes of 0xab, Base64
    const result = await scheme.createPaymentPayload(2, testRequirements({ extra: { nonce } }));
    const data = Transaction.from((result.payload as ExactSuiPayload).transaction).getData();
    expect(pureInputsBase64(data)).toContain(nonce);
    expect(transactionCarriesNonce(data, nonce)).toBe(true);
  });

  it("sets the announced sponsor as gas owner with empty gas payment", async () => {
    const feePayer = `0x${"cd".repeat(32)}`;
    const result = await scheme.createPaymentPayload(2, testRequirements({ extra: { feePayer } }));
    const data = Transaction.from((result.payload as ExactSuiPayload).transaction).getData();
    expect(normalizeSuiAddress(data.gasData.owner!)).toBe(normalizeSuiAddress(feePayer));
    expect(data.gasData.payment).toEqual([]);
  });

  it("validates requirements", async () => {
    await expect(scheme.createPaymentPayload(2, testRequirements({ asset: "" }))).rejects.toThrow(
      "Asset is required",
    );
    await expect(
      scheme.createPaymentPayload(2, testRequirements({ payTo: "0x123" })),
    ).rejects.toThrow("Invalid pay-to address");
    await expect(scheme.createPaymentPayload(2, testRequirements({ amount: "0" }))).rejects.toThrow(
      "positive atomic-unit integer",
    );
  });

  it("embeds the nonce as raw bytes (no BCS length prefix)", async () => {
    const nonce = "q6urq6urq6s="; // 8 bytes of 0xab, Base64
    const result = await scheme.createPaymentPayload(2, testRequirements({ extra: { nonce } }));
    const data = Transaction.from((result.payload as ExactSuiPayload).transaction).getData();
    // tx.pure(bytes) writes the raw bytes, so the decoded Pure input is exactly
    // the 8-byte nonce — not a length-prefixed 9-byte BCS vector.
    expect(pureInputsBase64(data)).toContain(nonce);
  });
});
