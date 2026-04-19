import { describe, it, expect } from "vitest";
import {
  DefaultIdempotencyKeyGenerator,
  createIdempotencyKeyGenerator,
  defaultIdempotencyKeyGenerator,
} from "../src/idempotency";
import { PaymentPayload } from "@x402/core/types";

describe("DefaultIdempotencyKeyGenerator", () => {
  const generator = new DefaultIdempotencyKeyGenerator();

  const createMockPayload = (overrides?: Partial<PaymentPayload>): PaymentPayload => ({
    x402Version: 2,
    resource: {
      url: "https://api.example.com/resource",
      description: "Test resource",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000000",
      payTo: "0x1234567890123456789012345678901234567890",
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload: {
      sender: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      recipient: "0x1234567890123456789012345678901234567890",
      value: "1000000",
      validUntil: 1234567890,
      nonce: "12345",
      signature: "0xsig...",
    },
    ...overrides,
  });

  it("should generate a key with idk_ prefix", () => {
    const payload = createMockPayload();
    const key = generator.generateKey(payload);

    expect(key).toMatch(/^idk_/);
  });

  it("should generate URL-safe keys", () => {
    const payload = createMockPayload();
    const key = generator.generateKey(payload);

    // base64url should not contain +, /, or =
    expect(key).not.toMatch(/[+/=]/);
  });

  it("should generate same key for identical payloads", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload();

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).toBe(key2);
  });

  it("should generate different keys for different amounts", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload({
      accepted: {
        ...payload1.accepted,
        amount: "2000000",
      },
    });

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).not.toBe(key2);
  });

  it("should generate different keys for different recipients", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload({
      accepted: {
        ...payload1.accepted,
        payTo: "0x9999999999999999999999999999999999999999",
      },
    });

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).not.toBe(key2);
  });

  it("should generate different keys for different networks", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload({
      accepted: {
        ...payload1.accepted,
        network: "eip155:1",
      },
    });

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).not.toBe(key2);
  });

  it("should generate different keys for different schemes", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload({
      accepted: {
        ...payload1.accepted,
        scheme: "different-scheme",
      },
    });

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).not.toBe(key2);
  });

  it("should generate different keys for different nonces in payload", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload({
      payload: {
        ...payload1.payload,
        nonce: "67890",
      },
    });

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).not.toBe(key2);
  });

  it("should generate different keys for different validUntil in payload", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload({
      payload: {
        ...payload1.payload,
        validUntil: 9876543210,
      },
    });

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).not.toBe(key2);
  });

  it("should generate different keys for different timeouts", () => {
    const payload1 = createMockPayload();
    const payload2 = createMockPayload({
      accepted: {
        ...payload1.accepted,
        maxTimeoutSeconds: 600,
      },
    });

    const key1 = generator.generateKey(payload1);
    const key2 = generator.generateKey(payload2);

    expect(key1).not.toBe(key2);
  });
});

describe("createIdempotencyKeyGenerator", () => {
  it("should create generator from custom function", () => {
    const customFn = (payload: PaymentPayload) => `custom_${payload.accepted.payTo}`;
    const generator = createIdempotencyKeyGenerator(customFn);

    const payload = {
      x402Version: 2,
      resource: { url: "", description: "", mimeType: "" },
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x1234",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
    };

    const key = generator.generateKey(payload);
    expect(key).toBe("custom_0x1234");
  });

  it("should allow time-based keys", () => {
    const timeFn = () => `time_${Date.now()}`;
    const generator = createIdempotencyKeyGenerator(timeFn);

    const payload = {
      x402Version: 2,
      resource: { url: "", description: "", mimeType: "" },
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x1234",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
    };

    const key = generator.generateKey(payload);
    expect(key).toMatch(/^time_\d+$/);
  });
});

describe("defaultIdempotencyKeyGenerator", () => {
  it("should be an instance of DefaultIdempotencyKeyGenerator", () => {
    expect(defaultIdempotencyKeyGenerator).toBeInstanceOf(DefaultIdempotencyKeyGenerator);
  });

  it("should generate valid keys", () => {
    const payload = {
      x402Version: 2,
      resource: { url: "", description: "", mimeType: "" },
      accepted: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1000000",
        payTo: "0x1234",
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: {},
    };

    const key = defaultIdempotencyKeyGenerator.generateKey(payload);
    expect(key).toMatch(/^idk_/);
  });
});
