import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import { ExactNearScheme } from "../../src/exact/client/scheme";
import { makeRequirements } from "./fixtures/near.fixture";

describe("near client scheme", () => {
  it("creates a payload using the signer callback (no relayer field required)", async () => {
    const signer = {
      createSignedDelegateAction: vi.fn().mockResolvedValue("signed-action-b64"),
    };
    const scheme = new ExactNearScheme(signer);
    const requirements = makeRequirements();

    const result = await scheme.createPaymentPayload(2, requirements);

    expect(result.x402Version).toBe(2);
    expect(result.payload).toEqual({ signedDelegateAction: "signed-action-b64" });
    expect(signer.createSignedDelegateAction).toHaveBeenCalledWith({
      x402Version: 2,
      paymentRequirements: requirements,
    });
  });

  it("rejects a non-NEAR network", async () => {
    const signer = { createSignedDelegateAction: vi.fn() };
    const scheme = new ExactNearScheme(signer);
    const requirements = makeRequirements({
      network: "eip155:8453" as PaymentRequirements["network"],
    });

    await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(
      /Unsupported NEAR network/,
    );
    expect(signer.createSignedDelegateAction).not.toHaveBeenCalled();
  });

  it("rejects an unsupported scheme", async () => {
    const signer = { createSignedDelegateAction: vi.fn() };
    const scheme = new ExactNearScheme(signer);
    const requirements = makeRequirements({ scheme: "upto" });

    await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(
      /Unsupported scheme/,
    );
  });

  it("throws when the signer returns an empty payload", async () => {
    const signer = { createSignedDelegateAction: vi.fn().mockResolvedValue("") };
    const scheme = new ExactNearScheme(signer);

    await expect(scheme.createPaymentPayload(2, makeRequirements())).rejects.toThrow(
      /empty signed delegate action/,
    );
  });
});
