import { describe, it, expect } from "vitest";
import { isUptoPermit2Payload } from "../../../src/types";
import { buildUptoPermit2SettleArgs } from "../../../src/shared/permit2";
import type { UptoPermit2Payload } from "../../../src/types";
import { getAddress } from "viem";

const VALID_PAYLOAD = {
  signature: "0xmocksig" as `0x${string}`,
  permit2Authorization: {
    from: "0x1234567890123456789012345678901234567890",
    permitted: {
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
    },
    spender: "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002",
    nonce: "12345",
    deadline: "1700000000",
    witness: {
      to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
      facilitator: "0xFAC11174700123456789012345678901234aBCDe",
      validAfter: "1699999400",
    },
  },
};

describe("isUptoPermit2Payload", () => {
  it("should return true for a valid payload", () => {
    expect(isUptoPermit2Payload(VALID_PAYLOAD)).toBe(true);
  });

  it("should return false when signature is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { signature: _signature, ...rest } = VALID_PAYLOAD;
    expect(isUptoPermit2Payload(rest as Record<string, unknown>)).toBe(false);
  });

  it("should return false when signature is not a string", () => {
    expect(isUptoPermit2Payload({ ...VALID_PAYLOAD, signature: 123 })).toBe(false);
  });

  it("should return false when permit2Authorization is missing", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { permit2Authorization: _permit2Authorization, ...rest } = VALID_PAYLOAD;
    expect(isUptoPermit2Payload(rest as Record<string, unknown>)).toBe(false);
  });

  it("should return false when permit2Authorization is null", () => {
    expect(isUptoPermit2Payload({ ...VALID_PAYLOAD, permit2Authorization: null })).toBe(false);
  });

  it("should return false when permit2Authorization is not an object", () => {
    expect(isUptoPermit2Payload({ ...VALID_PAYLOAD, permit2Authorization: "bad" })).toBe(false);
  });

  it("should return false when from is missing", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.permit2Authorization as Record<string, unknown>).from;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when from is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization as Record<string, unknown>).from = 42;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when spender is missing", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.permit2Authorization as Record<string, unknown>).spender;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when nonce is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization as Record<string, unknown>).nonce = 12345;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when deadline is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization as Record<string, unknown>).deadline = 1700000000;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when permitted is missing", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.permit2Authorization as Record<string, unknown>).permitted;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when permitted is null", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization as Record<string, unknown>).permitted = null;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when permitted.token is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization.permitted as Record<string, unknown>).token = 0x833589;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when permitted.amount is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization.permitted as Record<string, unknown>).amount = 1000000;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness is missing", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.permit2Authorization as Record<string, unknown>).witness;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness is null", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization as Record<string, unknown>).witness = null;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness.facilitator is missing", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.permit2Authorization.witness as Record<string, unknown>).facilitator;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness.facilitator is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization.witness as Record<string, unknown>).facilitator = 123;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness.to is missing", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.permit2Authorization.witness as Record<string, unknown>).to;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness.to is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization.witness as Record<string, unknown>).to = 42;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness.validAfter is missing", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    delete (payload.permit2Authorization.witness as Record<string, unknown>).validAfter;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false when witness.validAfter is not a string", () => {
    const payload = structuredClone(VALID_PAYLOAD);
    (payload.permit2Authorization.witness as Record<string, unknown>).validAfter = 1699999400;
    expect(isUptoPermit2Payload(payload)).toBe(false);
  });

  it("should return false for an empty object", () => {
    expect(isUptoPermit2Payload({})).toBe(false);
  });

  it("should return false for an exact scheme payload (no facilitator in witness)", () => {
    const exactPayload = {
      signature: "0xsig",
      permit2Authorization: {
        from: "0x1234567890123456789012345678901234567890",
        permitted: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1000000" },
        spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
        nonce: "1",
        deadline: "999999999",
        witness: { to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0", validAfter: "0" },
      },
    };
    expect(isUptoPermit2Payload(exactPayload as Record<string, unknown>)).toBe(false);
  });
});

describe("buildUptoPermit2SettleArgs", () => {
  const FACILITATOR = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
  const payload: UptoPermit2Payload = {
    signature: "0xdeadbeef" as `0x${string}`,
    permit2Authorization: {
      from: "0x1234567890123456789012345678901234567890",
      permitted: {
        token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "5000000",
      },
      spender: "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002",
      nonce: "99",
      deadline: "1700000000",
      witness: {
        to: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        facilitator: FACILITATOR,
        validAfter: "1699999400",
      },
    },
  };

  it("should return a 5-element tuple with correct types", () => {
    const args = buildUptoPermit2SettleArgs(payload, 1000000n, FACILITATOR);
    expect(args).toHaveLength(5);
  });

  it("should place the settlement amount as the second element", () => {
    const args = buildUptoPermit2SettleArgs(payload, 750000n, FACILITATOR);
    expect(args[1]).toBe(750000n);
  });

  it("should convert permitted.amount to BigInt", () => {
    const args = buildUptoPermit2SettleArgs(payload, 1000000n, FACILITATOR);
    expect(args[0].permitted.amount).toBe(5000000n);
  });

  it("should checksum all addresses", () => {
    const args = buildUptoPermit2SettleArgs(payload, 1000000n, FACILITATOR);
    const checksummedToken = getAddress(payload.permit2Authorization.permitted.token);
    const checksummedTo = getAddress(payload.permit2Authorization.witness.to);
    const checksummedFacilitator = getAddress(FACILITATOR);
    const checksummedFrom = getAddress(payload.permit2Authorization.from);

    expect(args[0].permitted.token).toBe(checksummedToken);
    expect(args[2]).toBe(checksummedFrom);
    expect(args[3].to).toBe(checksummedTo);
    expect(args[3].facilitator).toBe(checksummedFacilitator);
  });

  it("should convert nonce, deadline, and validAfter to BigInt", () => {
    const args = buildUptoPermit2SettleArgs(payload, 1000000n, FACILITATOR);
    expect(args[0].nonce).toBe(99n);
    expect(args[0].deadline).toBe(1700000000n);
    expect(args[3].validAfter).toBe(1699999400n);
  });

  it("should pass through the signature unchanged", () => {
    const args = buildUptoPermit2SettleArgs(payload, 1000000n, FACILITATOR);
    expect(args[4]).toBe("0xdeadbeef");
  });
});
