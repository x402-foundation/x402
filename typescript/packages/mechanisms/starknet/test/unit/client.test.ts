import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Signature, TypedData } from "starknet";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactStarknetScheme } from "../../src/exact/client/scheme";
import type { ClientStarknetSigner } from "../../src/signer";
import {
  ANY_CALLER,
  STARKNET_MAINNET_CAIP2,
  STARKNET_SEPOLIA_CAIP2,
  TRANSFER_SELECTOR,
} from "../../src/constants";

const PAYER = "0x01a2b3c4d5e6f7089a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcde";
const FEE_PAYER = "0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81";
const PAY_TO = "0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57";
const ASSET = "0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343";

const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
const MAINNET_CHAIN_ID = "0x534e5f4d41494e";

/**
 * Build a mock client signer whose signMessage returns a fixed felt-array
 * signature and records the typed data it was asked to sign.
 */
function makeSigner(
  address = PAYER,
  signature: Signature = ["0x1", "0x2"],
): ClientStarknetSigner & { signMessage: ReturnType<typeof vi.fn> } {
  return {
    address,
    signMessage: vi.fn((_typedData: TypedData) => signature),
  };
}

function requirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "exact",
    network: STARKNET_SEPOLIA_CAIP2,
    asset: ASSET,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { feePayer: FEE_PAYER },
    ...overrides,
  };
}

describe("ExactStarknetScheme (client)", () => {
  let signer: ReturnType<typeof makeSigner>;
  let scheme: ExactStarknetScheme;

  beforeEach(() => {
    signer = makeSigner();
    scheme = new ExactStarknetScheme(signer);
  });

  it("has scheme property set to exact", () => {
    expect(scheme.scheme).toBe("exact");
  });

  // x402Client's spend controls only cap assets the scheme recognizes as
  // USD-pegged defaults; anything else is rejected unless the user opts in.
  it("recognizes the default USDC via findDefaultAsset and no other token", () => {
    expect(scheme.findDefaultAsset?.(ASSET, STARKNET_SEPOLIA_CAIP2)?.symbol).toBe("USDC");
    expect(scheme.findDefaultAsset?.(PAY_TO, STARKNET_SEPOLIA_CAIP2)).toBeUndefined();
  });

  describe("createPaymentPayload happy path", () => {
    it("returns a payload with the payer, signed typed data, and signature", async () => {
      const result = await scheme.createPaymentPayload(2, requirements());

      expect(result.x402Version).toBe(2);
      const payload = result.payload as {
        from: string;
        outsideExecution: { typedData: TypedData; signature: string[] };
      };
      expect(payload.from).toBe(PAYER);
      expect(payload.outsideExecution.signature).toEqual(["0x1", "0x2"]);
      expect(signer.signMessage).toHaveBeenCalledTimes(1);
    });

    it("binds the single transfer call to Caller = extra.feePayer and the exact amount", async () => {
      const result = await scheme.createPaymentPayload(2, requirements());
      const payload = result.payload as {
        outsideExecution: {
          typedData: TypedData & {
            message: {
              Caller: string;
              Calls: { To: string; Selector: string; Calldata: string[] }[];
            };
          };
        };
      };
      const td = payload.outsideExecution.typedData;

      expect(td.primaryType).toBe("OutsideExecution");
      expect(td.domain.chainId).toBe(SEPOLIA_CHAIN_ID);
      expect(BigInt(td.message.Caller)).toBe(BigInt(FEE_PAYER));
      expect(td.message.Calls).toHaveLength(1);

      const call = td.message.Calls[0];
      expect(BigInt(call.To)).toBe(BigInt(ASSET));
      expect(BigInt(call.Selector)).toBe(BigInt(TRANSFER_SELECTOR));
      // Calldata is [recipient, amount_low, amount_high], every felt in hex so a
      // SNIP-29 paymaster can rebuild the onchain calldata from it.
      expect(call.Calldata.map(BigInt)).toEqual([BigInt(PAY_TO), 10000n, 0n]);
      expect(call.Calldata.every(c => /^0x[0-9a-f]+$/.test(c))).toBe(true);
    });

    it("splits a u256 amount into low/high 128-bit limbs", async () => {
      // 2^128 + 5 -> low = 5, high = 1
      const amount = ((1n << 128n) + 5n).toString();
      const result = await scheme.createPaymentPayload(2, requirements({ amount }));
      const payload = result.payload as {
        outsideExecution: {
          typedData: { message: { Calls: { Calldata: string[] }[] } };
        };
      };
      expect(payload.outsideExecution.typedData.message.Calls[0].Calldata.map(BigInt)).toEqual([
        BigInt(PAY_TO),
        5n,
        1n,
      ]);
    });

    // Spec client signing rule: Execute After well in the past, Execute Before
    // exactly the advertised window from now.
    it("sets Execute After to 1 and Execute Before to now + maxTimeoutSeconds", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_800_000_000_000);
      try {
        const result = await scheme.createPaymentPayload(
          2,
          requirements({ maxTimeoutSeconds: 120 }),
        );
        const message = (result.payload as { outsideExecution: { typedData: TypedData } })
          .outsideExecution.typedData.message as Record<string, unknown>;
        expect(Number(message["Execute After"])).toBe(1);
        expect(Number(message["Execute Before"])).toBe(1_800_000_000 + 120);
      } finally {
        vi.useRealTimers();
      }
    });

    it("draws a fresh SNIP-9 nonce for every payload", async () => {
      const nonceOf = async () => {
        const result = await scheme.createPaymentPayload(2, requirements());
        return (result.payload as { outsideExecution: { typedData: TypedData } }).outsideExecution
          .typedData.message.Nonce as string;
      };
      const first = await nonceOf();
      const second = await nonceOf();
      expect(first).toMatch(/^0x[0-9a-f]+$/);
      expect(BigInt(first)).not.toBe(BigInt(second));
    });

    it("uses the mainnet chainId for the mainnet network", async () => {
      const result = await scheme.createPaymentPayload(
        2,
        requirements({ network: STARKNET_MAINNET_CAIP2 }),
      );
      const payload = result.payload as {
        outsideExecution: { typedData: TypedData };
      };
      expect(payload.outsideExecution.typedData.domain.chainId).toBe(MAINNET_CHAIN_ID);
    });

    it("normalizes an { r, s } signature into a felt array", async () => {
      const rsSigner = makeSigner(PAYER, { r: 3n, s: 4n } as unknown as Signature);
      const rsScheme = new ExactStarknetScheme(rsSigner);
      const result = await rsScheme.createPaymentPayload(2, requirements());
      const payload = result.payload as { outsideExecution: { signature: string[] } };
      expect(payload.outsideExecution.signature).toEqual(["0x3", "0x4"]);
    });

    it("echoes the x402Version argument", async () => {
      const result = await scheme.createPaymentPayload(7, requirements());
      expect(result.x402Version).toBe(7);
    });
  });

  describe("createPaymentPayload rejections", () => {
    it("rejects when extra.feePayer is missing", async () => {
      await expect(scheme.createPaymentPayload(2, requirements({ extra: {} }))).rejects.toThrow(
        /extra\.feePayer is required/,
      );
    });

    it("rejects a zero-address feePayer", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ extra: { feePayer: "0x0" } })),
      ).rejects.toThrow(/zero address/);
    });

    it("rejects the ANY_CALLER sentinel as feePayer", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ extra: { feePayer: ANY_CALLER } })),
      ).rejects.toThrow(/ANY_CALLER/);
    });

    it("rejects a feePayer equal to the payer address", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ extra: { feePayer: PAYER } })),
      ).rejects.toThrow(/must not equal the payer/);
    });

    it("rejects a malformed feePayer address", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ extra: { feePayer: "0xZZZ" } })),
      ).rejects.toThrow(/Invalid feePayer/);
    });

    it("rejects a missing asset", async () => {
      await expect(scheme.createPaymentPayload(2, requirements({ asset: "" }))).rejects.toThrow(
        /Asset is required/,
      );
    });

    it("rejects a malformed asset address", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ asset: "not-an-address" })),
      ).rejects.toThrow(/Invalid asset address/);
    });

    it("rejects a missing pay-to address", async () => {
      await expect(scheme.createPaymentPayload(2, requirements({ payTo: "" }))).rejects.toThrow(
        /Pay-to address is required/,
      );
    });

    it("rejects a malformed pay-to address", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ payTo: "0xnothex" })),
      ).rejects.toThrow(/Invalid pay-to address/);
    });

    it("rejects a missing amount", async () => {
      await expect(scheme.createPaymentPayload(2, requirements({ amount: "" }))).rejects.toThrow(
        /Amount is required/,
      );
    });

    it("rejects a non-numeric amount", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ amount: "12.5" })),
      ).rejects.toThrow(/base-10 integer/);
    });

    it("rejects a zero amount", async () => {
      await expect(scheme.createPaymentPayload(2, requirements({ amount: "0" }))).rejects.toThrow(
        /positive integer/,
      );
    });

    it("rejects an unsupported network", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ network: "starknet:SN_UNKNOWN" })),
      ).rejects.toThrow(/Unsupported Starknet network/);
    });

    it("rejects a non-positive maxTimeoutSeconds", async () => {
      await expect(
        scheme.createPaymentPayload(2, requirements({ maxTimeoutSeconds: 0 })),
      ).rejects.toThrow(/maxTimeoutSeconds must be a positive integer/);
    });

    it("does not spend a signature when validation fails", async () => {
      await expect(scheme.createPaymentPayload(2, requirements({ extra: {} }))).rejects.toThrow();
      expect(signer.signMessage).not.toHaveBeenCalled();
    });
  });
});

// The client is the layer that originates the signature, so it must refuse a
// value the facilitator would later reject - and refuse it with its own message
// rather than a raw RangeError from inside starknet.js's hashing.
describe("ExactStarknetScheme (client) - address and window bounds", () => {
  it.each([
    ["asset", /Invalid asset address/],
    ["payTo", /Invalid pay-to address/],
  ])("rejects an out-of-range %s", async (field, message) => {
    await expect(
      new ExactStarknetScheme(makeSigner()).createPaymentPayload(
        2,
        requirements({ [field]: "0x" + "f".repeat(64) }),
      ),
    ).rejects.toThrow(message);
  });

  it("rejects an out-of-range feePayer", async () => {
    await expect(
      new ExactStarknetScheme(makeSigner()).createPaymentPayload(
        2,
        requirements({ extra: { feePayer: "0x" + "f".repeat(64) } }),
      ),
    ).rejects.toThrow(/Invalid feePayer address/);
  });

  it("rejects a fractional maxTimeoutSeconds with its own error", async () => {
    await expect(
      new ExactStarknetScheme(makeSigner()).createPaymentPayload(
        2,
        requirements({ maxTimeoutSeconds: 30.5 }),
      ),
    ).rejects.toThrow(/maxTimeoutSeconds must be a positive integer/);
  });
});
