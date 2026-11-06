import { describe, it, expect, vi } from "vitest";
import { ShieldedEvmClient } from "../../../src/shielded/client/scheme.js";
import type { PaymentRequirements } from "@x402/core/types";
import type { UnshieldFn } from "../../../src/shielded/types.js";

const TX_HASH = "0x4712f6ad727eb4f72a59bf6e23edeb23589da66edc0166a2223252a5be9459c7" as const;
const PAY_TO = "0x0cB634602891d5c200C80052a5047374afcE684A";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function makeRequirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453" as `${string}:${string}`,
    asset: USDC,
    amount: "1000000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { assetTransferMethod: "shielded" },
  };
}

describe("ShieldedEvmClient", () => {
  it("calls unshield with correct token, amount, and recipient", async () => {
    const unshield = vi.fn<UnshieldFn>().mockResolvedValue({ txHash: TX_HASH });
    const client = new ShieldedEvmClient({ unshield });

    await client.createPaymentPayload(2, makeRequirements());

    expect(unshield).toHaveBeenCalledWith(USDC, "1000000", PAY_TO, "eip155:8453");
  });

  it("returns txHash in payload", async () => {
    const unshield = vi.fn<UnshieldFn>().mockResolvedValue({ txHash: TX_HASH });
    const client = new ShieldedEvmClient({ unshield });

    const result = await client.createPaymentPayload(2, makeRequirements());

    expect(result.x402Version).toBe(2);
    expect((result.payload as Record<string, unknown>).txHash).toBe(TX_HASH);
  });

  it("propagates unshield errors", async () => {
    const unshield = vi.fn<UnshieldFn>().mockRejectedValue(new Error("insufficient shielded balance"));
    const client = new ShieldedEvmClient({ unshield });

    await expect(client.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
      "insufficient shielded balance",
    );
  });

  it("has scheme set to exact", () => {
    const unshield = vi.fn<UnshieldFn>().mockResolvedValue({ txHash: TX_HASH });
    const client = new ShieldedEvmClient({ unshield });
    expect(client.scheme).toBe("exact");
  });
});
