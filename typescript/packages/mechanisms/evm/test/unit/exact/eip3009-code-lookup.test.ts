import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { verifyEIP3009 } from "../../../src/exact/facilitator/eip3009";
import {
  ErrFailedToVerifySignature,
  ErrInvalidSignature,
} from "../../../src/exact/facilitator/errors";
import type { ExactEIP3009Payload } from "../../../src/types";

const PAYER = "0xabcA8d06A3925a6C06D142788a1A90ae431ccB00" as const;
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:84532",
    asset: ASSET,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
}

function payload(req: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted: req,
    payload: {},
  };
}

function eip3009(): ExactEIP3009Payload {
  return {
    signature: `0x${"ab".repeat(65)}`,
    authorization: {
      from: PAYER,
      to: PAY_TO,
      value: "10000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"11".repeat(32)}`,
    },
  };
}

function signer(getCode: FacilitatorEvmSigner["getCode"]): FacilitatorEvmSigner {
  return {
    getAddresses: () => [],
    readContract: vi.fn(),
    verifyTypedData: vi.fn(),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode,
  };
}

describe("verifyEIP3009 payer eth_getCode failure", () => {
  it("reports a failed payer code lookup as failed_to_verify_signature, not an invalid signature", async () => {
    const req = requirements();
    const getCode = vi.fn(async ({ address }: { address: `0x${string}` }) => {
      if (address.toLowerCase() === PAYER.toLowerCase()) {
        throw new Error(
          "HTTP request failed. Status: 503 URL: https://rpc.example/v1/base?token=secret-key",
        );
      }
      return "0x6080604052" as `0x${string}`;
    });

    const { response } = await verifyEIP3009(signer(getCode), payload(req), req, eip3009());

    expect(response).toMatchObject({
      isValid: false,
      invalidReason: ErrFailedToVerifySignature,
      payer: PAYER,
    });
    expect(response.invalidMessage).toContain("503");
    expect(response.invalidMessage).not.toContain("secret-key");
    expect(response.invalidMessage).not.toContain("https://");
    expect(response.invalidReason).not.toBe(ErrInvalidSignature);
  });

  it("reuses the first payer code lookup when a second call would fail", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const req = requirements();
    req.payTo = PAY_TO;
    const authorization = {
      from: account.address,
      to: PAY_TO,
      value: "10000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"11".repeat(32)}` as `0x${string}`,
    };
    const signature = await account.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: ASSET },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: 10000n, validAfter: 0n, validBefore: 9999999999n },
    });

    let payerLookups = 0;
    const getCode = vi.fn(async ({ address }: { address: `0x${string}` }) => {
      if (address.toLowerCase() !== account.address.toLowerCase()) {
        return "0x6080604052" as `0x${string}`;
      }
      payerLookups += 1;
      if (payerLookups > 1) throw new Error("HTTP request failed. Status: 503");
      return "0x" as `0x${string}`;
    });

    const signed = eip3009();
    signed.authorization.from = account.address;
    signed.signature = signature;

    const { response } = await verifyEIP3009(signer(getCode), payload(req), req, signed);

    expect(payerLookups).toBe(1);
    expect(response.invalidReason).not.toBe(ErrInvalidSignature);
    expect(response.invalidReason).not.toBe(ErrFailedToVerifySignature);
  });
});
