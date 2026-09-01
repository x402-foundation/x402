import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import { getNewKeetaAccount } from "./utils";
import { ExactKeetaScheme } from "../../src/exact/client/scheme";
import { KEETA_TESTNET_CAIP2 } from "../../src/constants";
import { USDC_TESTNET_ADDRESS } from "../../src/defaultAssets";
import { KTA_TESTNET_ADDRESS } from "../../src/utils";

const PAY_TO = getNewKeetaAccount().publicKeyString.toString();
const MOCK_BLOCK_BYTES = Buffer.from("mock-block-bytes");

function createMockSigner() {
  return {
    computePaymentBlock: vi.fn().mockResolvedValue({
      toBytes: vi.fn().mockReturnValue(MOCK_BLOCK_BYTES),
    }),
    destroy: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
}

function createRequirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: KEETA_TESTNET_CAIP2,
    asset: KTA_TESTNET_ADDRESS,
    amount: "1000000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

describe("ExactKeetaScheme (client)", () => {
  let signer: ReturnType<typeof createMockSigner>;
  let scheme: ExactKeetaScheme;

  beforeEach(() => {
    vi.clearAllMocks();
    signer = createMockSigner();
    scheme = new ExactKeetaScheme(signer);
  });

  it("has scheme set to exact", () => {
    expect(scheme.scheme).toBe("exact");
  });

  it("recognizes documented USDC via findDefaultAsset and rejects native KTA", () => {
    expect(scheme.findDefaultAsset?.(USDC_TESTNET_ADDRESS, KEETA_TESTNET_CAIP2)?.symbol).toBe(
      "USDC",
    );
    expect(scheme.findDefaultAsset?.(KTA_TESTNET_ADDRESS, KEETA_TESTNET_CAIP2)).toBeUndefined();
  });

  describe("spendControls", () => {
    function paymentRequired(asset: string, amount: string) {
      return {
        x402Version: 2,
        resource: { url: "https://example.com/resource" },
        accepts: [createRequirements({ asset, amount })],
      };
    }

    it("auto-allows documented USDC at or below the $1 cap", async () => {
      const client = new x402Client().register(KEETA_TESTNET_CAIP2, scheme);
      await client.createPaymentPayload(paymentRequired(USDC_TESTNET_ADDRESS, "1000000"));
      expect(signer.computePaymentBlock).toHaveBeenCalledOnce();
    });

    it("rejects documented USDC above the $1 cap", async () => {
      const client = new x402Client().register(KEETA_TESTNET_CAIP2, scheme);
      await expect(
        client.createPaymentPayload(paymentRequired(USDC_TESTNET_ADDRESS, "1000001")),
      ).rejects.toThrow(/maxAmountPerPayment/);
    });

    it("rejects native KTA unless opted in via allowedAssets", async () => {
      const client = new x402Client().register(KEETA_TESTNET_CAIP2, scheme);
      await expect(
        client.createPaymentPayload(paymentRequired(KTA_TESTNET_ADDRESS, "1000")),
      ).rejects.toThrow(/spendControls\.allowedAssets/);
    });
  });

  describe("createPaymentPayload", () => {
    it("returns the x402Version and base64-encoded block", async () => {
      const result = await scheme.createPaymentPayload(2, createRequirements());

      expect(result.x402Version).toBe(2);
      expect((result.payload as { block: string }).block).toBe(MOCK_BLOCK_BYTES.toString("base64"));
    });

    it("passes the correct network, amount, and external=undefined to the signer", async () => {
      await scheme.createPaymentPayload(2, createRequirements());

      expect(signer.computePaymentBlock).toHaveBeenCalledWith(
        KEETA_TESTNET_CAIP2,
        // recipient Account object
        expect.anything(),
        BigInt("1000000"),
        // token Account object
        expect.anything(),
        undefined,
      );
    });

    it("passes external to computePaymentBlock when set in requirements.extra", async () => {
      await scheme.createPaymentPayload(
        2,
        createRequirements({ extra: { external: "ref-abc-123" } }),
      );

      expect(signer.computePaymentBlock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        "ref-abc-123",
      );
    });

    it("omits external when requirements.extra has no external field", async () => {
      await scheme.createPaymentPayload(2, createRequirements({ extra: {} }));

      expect(signer.computePaymentBlock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
      );
    });

    it("omits external when requirements.extra is absent", async () => {
      await scheme.createPaymentPayload(2, createRequirements({ extra: undefined }));

      expect(signer.computePaymentBlock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
      );
    });

    it("throws when the asset address is not a token", async () => {
      // PAY_TO is a signing account (isToken() = false), so it is invalid as an asset
      const requirements = createRequirements({ asset: PAY_TO });
      await expect(scheme.createPaymentPayload(2, requirements)).rejects.toThrow();
      expect(signer.computePaymentBlock).not.toHaveBeenCalled();
    });

    it("propagates errors thrown by the signer", async () => {
      signer.computePaymentBlock.mockRejectedValueOnce(new Error("Network error"));

      await expect(scheme.createPaymentPayload(2, createRequirements())).rejects.toThrow(
        "Network error",
      );
    });
  });
});
