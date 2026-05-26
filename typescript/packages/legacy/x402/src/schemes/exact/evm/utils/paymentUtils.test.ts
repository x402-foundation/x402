import { describe, it, expect } from "vitest";
import { encodePayment, decodePayment } from "./paymentUtils";
import { PaymentPayload, ExactEvmPayload, ExactSvmPayload } from "../../../../types/verify";
import { SupportedEVMNetworks, SupportedSVMNetworks } from "../../../../types";

// valid exact EVM payload
const validEvmPayload: ExactEvmPayload = {
  signature: "0x" + "a".repeat(130),
  authorization: {
    from: "0x" + "1".repeat(40),
    to: "0x" + "2".repeat(40),
    value: "100000000000000000", // 0.1 ETH in wei (18 chars max)
    validAfter: "0",
    validBefore: "9999999999",
    nonce: "0x" + "b".repeat(64),
  },
};

// valid evm payment payload
const defaultEvmNetwork = SupportedEVMNetworks[0] as (typeof SupportedEVMNetworks)[number];
const defaultSvmNetwork = SupportedSVMNetworks[0] as (typeof SupportedSVMNetworks)[number];

const validEvmPayment: PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: defaultEvmNetwork,
  payload: validEvmPayload,
};

// valid exact SVM payload
const validSvmPayload: ExactSvmPayload = {
  transaction: "QUJDREVGR0g=", // "ABCDEFGH" base64
};

// valid SVM payment payload
const validSvmPayment: PaymentPayload = {
  x402Version: 1,
  scheme: "exact",
  network: defaultSvmNetwork,
  payload: validSvmPayload,
};

describe("paymentUtils", () => {
  it("encodes and decodes EVM payment payloads (roundtrip)", () => {
    const encoded = encodePayment(validEvmPayment);
    const decoded = decodePayment(encoded);
    expect(decoded).toEqual(validEvmPayment);
  });

  it("encodes and decodes SVM payment payloads (roundtrip)", () => {
    const encoded = encodePayment(validSvmPayment);
    const decoded = decodePayment(encoded);
    expect(decoded).toEqual(validSvmPayment);
  });

  it("throws on invalid network in encodePayment", () => {
    const invalidPayment = {
      ...validEvmPayment,
      network: "invalid-network",
    } as unknown as PaymentPayload;
    expect(() => encodePayment(invalidPayment)).toThrow("Invalid network");
  });

  it("throws on invalid network in decodePayment", () => {
    const invalid = {
      ...validEvmPayment,
      network: "invalid-network",
    } as unknown as PaymentPayload;
    const encoded = Buffer.from(JSON.stringify(invalid)).toString("base64");
    expect(() => decodePayment(encoded)).toThrow("Invalid network");
  });

  it("throws on invalid base64 in decodePayment", () => {
    expect(() => decodePayment("not_base64!!")).toThrow();
  });

  it("throws on invalid payload shape in decodePayment", () => {
    // valid base64, but not a valid PaymentPayload
    const bad = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64");
    expect(() => decodePayment(bad)).toThrow();
  });
});
