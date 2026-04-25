import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "../../src/exact/server/scheme";

describe("ExactHedera server scheme", () => {
  it("passes through explicit AssetAmount", async () => {
    const scheme = new ExactHederaScheme();
    const parsed = await scheme.parsePrice(
      { amount: "1000", asset: "0.0.2001", extra: { token: "USDC" } },
      "hedera:testnet",
    );
    expect(parsed.amount).toBe("1000");
    expect(parsed.asset).toBe("0.0.2001");
    expect(parsed.extra?.token).toBe("USDC");
  });

  it("enhances payment requirements with feePayer", async () => {
    const scheme = new ExactHederaScheme();
    const base: PaymentRequirements = {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.2001",
      amount: "1000",
      payTo: "0.0.3001",
      maxTimeoutSeconds: 60,
      extra: {},
    };

    const enhanced = await scheme.enhancePaymentRequirements(
      base,
      {
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer: "0.0.5001" },
      },
      [],
    );

    expect(enhanced.extra.feePayer).toBe("0.0.5001");
  });

  it("rejects explicit AssetAmount with invalid asset id", async () => {
    const scheme = new ExactHederaScheme();
    await expect(
      scheme.parsePrice(
        { amount: "1000", asset: "invalid-asset", extra: { token: "USDC" } },
        "hedera:testnet",
      ),
    ).rejects.toThrow("Invalid Hedera asset identifier");
  });

  it("preserves existing extra when facilitator does not provide feePayer", async () => {
    const scheme = new ExactHederaScheme();
    const base: PaymentRequirements = {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.2001",
      amount: "1000",
      payTo: "0.0.3001",
      maxTimeoutSeconds: 60,
      extra: { custom: "value" },
    };

    const enhanced = await scheme.enhancePaymentRequirements(
      base,
      {
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
      },
      [],
    );

    expect(enhanced.extra.custom).toBe("value");
    expect(enhanced.extra.feePayer).toBeUndefined();
  });
});
