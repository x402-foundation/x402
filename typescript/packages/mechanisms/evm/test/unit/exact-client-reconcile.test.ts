import { describe, it, expect, vi } from "vitest";
import { ExactEvmScheme } from "../../src/exact/client/scheme";
import type { PaymentPayload } from "@x402/core/types";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FROM = "0x1111111111111111111111111111111111111111";
const NONCE = `0x${"ab".repeat(32)}` as const;

const accepted = {
  scheme: "exact",
  network: "eip155:84532" as const,
  amount: "10000",
  asset: USDC,
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
  extra: { name: "USD Coin", version: "2" },
};

const eip3009Payload: PaymentPayload = {
  x402Version: 2,
  accepted,
  payload: {
    signature: "0xsig",
    authorization: {
      from: FROM,
      to: accepted.payTo,
      value: accepted.amount,
      validAfter: "0",
      validBefore: "9999999999",
      nonce: NONCE,
    },
  },
};

function signerWith(readContract?: (args: unknown) => Promise<unknown>) {
  return { address: FROM, signTypedData: async () => "0xsig", readContract } as never;
}

describe("ExactEvmScheme client reconcilePaymentPayload", () => {
  it("reports settled when the authorization nonce has been used", async () => {
    const readContract = vi.fn().mockResolvedValue(true);
    const client = new ExactEvmScheme(signerWith(readContract));

    expect(await client.reconcilePaymentPayload(eip3009Payload)).toBe("settled");
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: USDC,
        functionName: "authorizationState",
        args: [FROM, NONCE],
      }),
    );
  });

  it("reports unsettled when the authorization nonce is unused", async () => {
    const client = new ExactEvmScheme(signerWith(vi.fn().mockResolvedValue(false)));

    expect(await client.reconcilePaymentPayload(eip3009Payload)).toBe("unsettled");
  });

  it("reports unknown without a chain read capability", async () => {
    const client = new ExactEvmScheme(signerWith());

    expect(await client.reconcilePaymentPayload(eip3009Payload)).toBe("unknown");
  });

  it("reports unknown for payloads without an EIP-3009 authorization", async () => {
    const client = new ExactEvmScheme(signerWith(vi.fn().mockResolvedValue(true)));
    const permit2Payload: PaymentPayload = {
      x402Version: 2,
      accepted,
      payload: { permit2Authorization: {}, signature: "0xsig" },
    };

    expect(await client.reconcilePaymentPayload(permit2Payload)).toBe("unknown");
  });
});
