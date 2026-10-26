import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { PaymentPayloadV1, PaymentRequirementsV1 } from "@x402/core/types/v1";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import {
  isCanonicalEcdsaSignature,
  isPlainNonCanonicalEcdsaSignature,
} from "../../../src/shared/verifySignature";
import { verifyEIP3009 } from "../../../src/exact/facilitator/eip3009";
import { ExactEvmSchemeV1 } from "../../../src/exact/v1/facilitator/scheme";
import { ErrInvalidSignatureS } from "../../../src/exact/facilitator/errors";
import type { ExactEIP3009Payload } from "../../../src/types";

// secp256k1 n/2 (EIP-2 low-s upper bound) — the boundary value, which is canonical.
const N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

const PAYER = "0xabcA8d06A3925a6C06D142788a1A90ae431ccB00" as const;
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const EOA_CODE = "0x" as const;
const WALLET_CODE = "0x6080604052" as const;

// Build a 65-byte ECDSA signature (r || s || v) with a chosen s value. r and v are
// arbitrary here — only s is inspected by the canonical-s gate.
function sigWithS(s: bigint, v = "1b"): Hex {
  const r = "11".repeat(32);
  return `0x${r}${s.toString(16).padStart(64, "0")}${v}`;
}

function signer(payerCode: Hex): FacilitatorEvmSigner {
  return {
    getAddresses: () => [],
    readContract: vi.fn(),
    verifyTypedData: vi.fn(),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn(async ({ address }: { address: `0x${string}` }) =>
      address.toLowerCase() === PAYER.toLowerCase() ? payerCode : WALLET_CODE,
    ),
  };
}

const authorization = {
  from: PAYER,
  to: PAY_TO,
  value: "10000",
  validAfter: "0",
  validBefore: "9999999999",
  nonce: `0x${"11".repeat(32)}` as Hex,
};

describe("isCanonicalEcdsaSignature", () => {
  it("accepts a low-s signature (s < n/2)", () => {
    expect(isCanonicalEcdsaSignature(sigWithS(N_HALF - 1n))).toBe(true);
  });

  it("accepts the boundary s == n/2 (canonical per EIP-2)", () => {
    expect(isCanonicalEcdsaSignature(sigWithS(N_HALF))).toBe(true);
  });

  it("rejects a high-s signature (s > n/2, malleable)", () => {
    expect(isCanonicalEcdsaSignature(sigWithS(N_HALF + 1n))).toBe(false);
  });

  it("returns false for non-65-byte signatures", () => {
    expect(isCanonicalEcdsaSignature("0x010203")).toBe(false);
  });
});

describe("isPlainNonCanonicalEcdsaSignature", () => {
  it("rejects a high-s EOA signature", () => {
    expect(isPlainNonCanonicalEcdsaSignature(sigWithS(N_HALF + 1n), false)).toBe(true);
  });

  it("allows a low-s EOA signature", () => {
    expect(isPlainNonCanonicalEcdsaSignature(sigWithS(N_HALF), false)).toBe(false);
  });

  it("allows a high-s deployed wallet signature", () => {
    expect(isPlainNonCanonicalEcdsaSignature(sigWithS(N_HALF + 1n), true)).toBe(false);
  });

  it("ignores non-65-byte signatures (ERC-1271 / ERC-6492 wrappers)", () => {
    expect(isPlainNonCanonicalEcdsaSignature("0x010203", false)).toBe(false);
  });
});

describe("verifyEIP3009 canonical-s gate", () => {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "eip155:84532",
    asset: ASSET,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
  const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: {} };

  function eip3009(signature: Hex): ExactEIP3009Payload {
    return { signature, authorization };
  }

  it("rejects a high-s EOA signature with ErrInvalidSignatureS", async () => {
    const { response } = await verifyEIP3009(
      signer(EOA_CODE),
      payload,
      requirements,
      eip3009(sigWithS(N_HALF + 1n)),
    );

    expect(response).toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignatureS,
      payer: PAYER,
    });
  });

  it("does not apply the gate to a deployed wallet", async () => {
    const { response } = await verifyEIP3009(
      signer(WALLET_CODE),
      payload,
      requirements,
      eip3009(sigWithS(N_HALF + 1n)),
    );

    expect(response.invalidReason).not.toBe(ErrInvalidSignatureS);
  });
});

describe("ExactEvmSchemeV1 canonical-s gate", () => {
  const requirements: PaymentRequirementsV1 = {
    scheme: "exact",
    network: "base-sepolia",
    asset: ASSET,
    maxAmountRequired: "10000",
    resource: "https://example.com/resource",
    description: "test",
    mimeType: "application/json",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };

  function payload(signature: Hex): PaymentPayloadV1 {
    return {
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature, authorization },
    };
  }

  it("rejects a high-s EOA signature with ErrInvalidSignatureS", async () => {
    const facilitator = new ExactEvmSchemeV1(signer(EOA_CODE));

    const response = await facilitator.verify(payload(sigWithS(N_HALF + 1n)), requirements);

    expect(response).toMatchObject({
      isValid: false,
      invalidReason: ErrInvalidSignatureS,
      payer: PAYER,
    });
  });

  it("does not apply the gate to a deployed wallet", async () => {
    const facilitator = new ExactEvmSchemeV1(signer(WALLET_CODE));

    const response = await facilitator.verify(payload(sigWithS(N_HALF + 1n)), requirements);

    expect(response.invalidReason).not.toBe(ErrInvalidSignatureS);
  });
});
