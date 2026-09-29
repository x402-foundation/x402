import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactHederaScheme } from "../../src/exact/client/scheme";

describe("ExactHedera client scheme", () => {
  it("creates payment payload from signer output", async () => {
    const signer = {
      accountId: "0.0.7001",
      createPartiallySignedTransferTransaction: async () => "YmFzZTY0LXR4",
    };
    const scheme = new ExactHederaScheme(signer);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.2001",
      amount: "1000",
      payTo: "0.0.4001",
      maxTimeoutSeconds: 180,
      extra: {
        feePayer: "0.0.5001",
      },
    };

    const payload = await scheme.createPaymentPayload(2, requirements);
    expect(payload.x402Version).toBe(2);
    expect((payload.payload as { transaction: string }).transaction).toBe("YmFzZTY0LXR4");
  });

  it("requires feePayer in requirements.extra", async () => {
    const signer = {
      accountId: "0.0.7001",
      createPartiallySignedTransferTransaction: async () => "YmFzZTY0LXR4",
    };
    const scheme = new ExactHederaScheme(signer);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "hedera:testnet",
      asset: "0.0.2001",
      amount: "1000",
      payTo: "0.0.4001",
      maxTimeoutSeconds: 180,
      extra: {},
    };

    await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(
      "feePayer is required",
    );
  });

  it("rejects non-exact scheme requirements", async () => {
    const signer = {
      accountId: "0.0.7001",
      createPartiallySignedTransferTransaction: async () => "YmFzZTY0LXR4",
    };
    const scheme = new ExactHederaScheme(signer);
    const requirements = {
      scheme: "permit",
      network: "hedera:testnet",
      asset: "0.0.2001",
      amount: "1000",
      payTo: "0.0.4001",
      maxTimeoutSeconds: 180,
      extra: {
        feePayer: "0.0.5001",
      },
    } as unknown as PaymentRequirements;

    await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(
      "Unsupported scheme",
    );
  });

  it("rejects unsupported network", async () => {
    const signer = {
      accountId: "0.0.7001",
      createPartiallySignedTransferTransaction: async () => "YmFzZTY0LXR4",
    };
    const scheme = new ExactHederaScheme(signer);
    const requirements = {
      scheme: "exact",
      network: "eip155:1",
      asset: "0.0.2001",
      amount: "1000",
      payTo: "0.0.4001",
      maxTimeoutSeconds: 180,
      extra: {
        feePayer: "0.0.5001",
      },
    } as unknown as PaymentRequirements;

    await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow(
      "Unsupported Hedera network",
    );
  });
});
