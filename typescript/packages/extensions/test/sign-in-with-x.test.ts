/**
 * Tests for Sign-In-With-X Extension
 */

import { describe, it, expect, vi } from "vitest";
import {
  SIWxPayloadSchema,
  parseSIWxHeader,
  encodeSIWxHeader,
  declareSIWxExtension,
  validateSIWxMessage,
  createSIWxMessage,
  createSIWxPayload,
  verifySIWxSignature,
  SOLANA_MAINNET,
  SOLANA_DEVNET,
  formatSIWSMessage,
  decodeBase58,
  encodeBase58,
  extractSolanaChainReference,
  verifySolanaSignature,
  getEVMAddress,
  getSolanaAddress,
  signSolanaMessage,
  InMemorySIWxStorage,
  createSIWxSettleHook,
  createSIWxRequestHook,
  createSIWxClientHook,
  siwxResourceServerExtension,
  type SIWxHookEvent,
  type SolanaSigner,
  type EVMSigner,
  type EVMMessageVerifier,
} from "../src/sign-in-with-x/index";
import { safeBase64Encode } from "@x402/core/utils";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import nacl from "tweetnacl";
import { randomBytes } from "crypto";
import type { SIWxExtension } from "../src/sign-in-with-x/index";

/**
 * Test-only helper: builds a complete SIWX extension with nonce/issuedAt.
 *
 * @param opts - Challenge configuration
 * @param opts.domain - Server domain
 * @param opts.resourceUri - Full resource URI
 * @param opts.network - CAIP-2 network identifier(s)
 * @param opts.statement - Human-readable signing statement
 * @param opts.expirationSeconds - Challenge TTL in seconds
 * @returns Extension object keyed by "sign-in-with-x"
 */
function createTestChallenge(opts: {
  domain: string;
  resourceUri: string;
  network: string | string[];
  statement?: string;
  expirationSeconds?: number;
}): Record<string, SIWxExtension> {
  const networks = Array.isArray(opts.network) ? opts.network : [opts.network];
  return {
    "sign-in-with-x": {
      info: {
        domain: opts.domain,
        uri: opts.resourceUri,
        version: "1",
        nonce: randomBytes(16).toString("hex"),
        issuedAt: new Date().toISOString(),
        ...(opts.expirationSeconds !== undefined && {
          expirationTime: new Date(Date.now() + opts.expirationSeconds * 1000).toISOString(),
        }),
        ...(opts.statement && { statement: opts.statement }),
        resources: [opts.resourceUri],
      },
      supportedChains: networks.map(n => ({
        chainId: n,
        type: n.startsWith("solana:") ? ("ed25519" as const) : ("eip191" as const),
      })),
      schema: { header: "sign-in-with-x", type: "object" },
    },
  };
}

const validPayload = {
  domain: "api.example.com",
  address: "0x1234567890123456789012345678901234567890",
  statement: "Sign in to access your content",
  uri: "https://api.example.com/data",
  version: "1",
  chainId: "eip155:8453",
  type: "eip191" as const,
  nonce: "abc123def456",
  issuedAt: new Date().toISOString(),
  expirationTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  resources: ["https://api.example.com/data"],
  signature: "0xabcdef1234567890",
};

describe("Sign-In-With-X Extension", () => {
  describe("SIWxPayloadSchema", () => {
    it("should validate a correct payload", () => {
      const result = SIWxPayloadSchema.safeParse(validPayload);
      expect(result.success).toBe(true);
    });

    it("should reject payload missing required fields", () => {
      const invalidPayload = { domain: "example.com" };
      const result = SIWxPayloadSchema.safeParse(invalidPayload);
      expect(result.success).toBe(false);
    });

    it("should accept payload with optional fields omitted", () => {
      const minimalPayload = {
        domain: "api.example.com",
        address: "0x1234567890123456789012345678901234567890",
        uri: "https://api.example.com",
        version: "1",
        chainId: "eip155:8453",
        type: "eip191" as const,
        nonce: "abc123",
        issuedAt: new Date().toISOString(),
        signature: "0xabcdef",
      };
      const result = SIWxPayloadSchema.safeParse(minimalPayload);
      expect(result.success).toBe(true);
    });
  });

  describe("parseSIWxHeader", () => {
    it("should parse base64-encoded header", () => {
      const encoded = safeBase64Encode(JSON.stringify(validPayload));
      const parsed = parseSIWxHeader(encoded);
      expect(parsed.domain).toBe(validPayload.domain);
      expect(parsed.address).toBe(validPayload.address);
      expect(parsed.signature).toBe(validPayload.signature);
    });

    it("should throw on invalid base64", () => {
      expect(() => parseSIWxHeader("not-valid-base64!@#")).toThrow("not valid base64");
    });

    it("should throw on invalid JSON in base64", () => {
      const invalidJson = safeBase64Encode("not valid json");
      expect(() => parseSIWxHeader(invalidJson)).toThrow("not valid JSON");
    });

    it("should throw on missing required fields", () => {
      const incomplete = safeBase64Encode(JSON.stringify({ domain: "example.com" }));
      expect(() => parseSIWxHeader(incomplete)).toThrow("Invalid SIWX header");
    });
  });

  describe("encodeSIWxHeader", () => {
    it("should encode payload as base64 and round-trip correctly", () => {
      const encoded = encodeSIWxHeader(validPayload);
      const decoded = parseSIWxHeader(encoded);
      expect(decoded.domain).toBe(validPayload.domain);
      expect(decoded.address).toBe(validPayload.address);
      expect(decoded.signature).toBe(validPayload.signature);
    });
  });

  describe("declareSIWxExtension", () => {
    it("should create static declaration without time-based fields", () => {
      const result = declareSIWxExtension({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/data",
        network: "eip155:8453",
        statement: "Sign in to access",
        expirationSeconds: 300,
      });

      expect(result).toHaveProperty("sign-in-with-x");
      const extension = result["sign-in-with-x"];
      expect(extension.info.domain).toBe("api.example.com");
      expect(extension.info.uri).toBe("https://api.example.com/data");
      expect(extension.schema).toBeDefined();

      // Time-based fields are NOT generated by declareSIWxExtension;
      // they are generated per-request by enrichPaymentRequiredResponse
      expect(extension.info.nonce).toBeUndefined();
      expect(extension.info.issuedAt).toBeUndefined();

      // Check supportedChains array
      expect(extension.supportedChains).toHaveLength(1);
      expect(extension.supportedChains[0].chainId).toBe("eip155:8453");
      expect(extension.supportedChains[0].type).toBe("eip191");

      // Options are stored for enrichPaymentRequiredResponse
      expect(extension._options.expirationSeconds).toBe(300);
    });

    it("should support multiple chains in single extension", () => {
      const result = declareSIWxExtension({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/data",
        network: ["eip155:8453", SOLANA_DEVNET],
        expirationSeconds: 300,
      });

      const extension = result["sign-in-with-x"];
      expect(extension.supportedChains).toHaveLength(2);
      expect(extension.supportedChains[0].chainId).toBe("eip155:8453");
      expect(extension.supportedChains[0].type).toBe("eip191");
      expect(extension.supportedChains[1].chainId).toBe(SOLANA_DEVNET);
      expect(extension.supportedChains[1].type).toBe("ed25519");

      // Static declaration — no time-based fields
      expect(extension.info.nonce).toBeUndefined();
      expect(extension.info.issuedAt).toBeUndefined();
      expect(extension._options.expirationSeconds).toBe(300);
    });

    it("should support infinite expiration", () => {
      const result = declareSIWxExtension({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/data",
        network: "eip155:8453",
        expirationSeconds: undefined,
      });

      const extension = result["sign-in-with-x"];
      expect(extension.info.expirationTime).toBeUndefined();
    });
  });

  describe("validateSIWxMessage", () => {
    it("should validate correct message", async () => {
      const now = new Date();
      const payload = {
        ...validPayload,
        issuedAt: now.toISOString(),
        expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      };

      const result = await validateSIWxMessage(payload, "https://api.example.com/data");
      expect(result.valid).toBe(true);
    });

    it("should reject domain mismatch", async () => {
      const result = await validateSIWxMessage(validPayload, "https://different.example.com/data");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Domain mismatch");
    });
  });

  describe("createSIWxMessage", () => {
    it("should create EIP-4361 format message", () => {
      const serverInfo = {
        domain: "api.example.com",
        uri: "https://api.example.com",
        statement: "Sign in to access",
        version: "1",
        chainId: "eip155:8453",
        type: "eip191" as const,
        nonce: "abc12345def67890",
        issuedAt: "2024-01-01T00:00:00.000Z",
        resources: ["https://api.example.com"],
      };

      const message = createSIWxMessage(serverInfo, "0x1234567890123456789012345678901234567890");

      expect(message).toContain("api.example.com wants you to sign in");
      expect(message).toContain("0x1234567890123456789012345678901234567890");
      expect(message).toContain("Nonce: abc12345def67890");
      expect(message).toContain("Chain ID: 8453");
    });
  });

  describe("Integration - encode/parse roundtrip", () => {
    it("should roundtrip through encode and parse", () => {
      const encoded = encodeSIWxHeader(validPayload);
      const parsed = parseSIWxHeader(encoded);

      expect(parsed.domain).toBe(validPayload.domain);
      expect(parsed.address).toBe(validPayload.address);
      expect(parsed.signature).toBe(validPayload.signature);
    });
  });

  describe("Integration - full signing and verification", () => {
    it("should sign and verify a message with a real wallet", async () => {
      const account = privateKeyToAccount(generatePrivateKey());

      const extension = createTestChallenge({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/resource",
        network: "eip155:8453",
        statement: "Sign in to access your content",
      });

      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);
      const header = encodeSIWxHeader(payload);
      const parsed = parseSIWxHeader(header);

      const validation = await validateSIWxMessage(parsed, "https://api.example.com/resource");
      expect(validation.valid).toBe(true);

      const verification = await verifySIWxSignature(parsed);
      expect(verification.valid).toBe(true);
      expect(verification.address?.toLowerCase()).toBe(account.address.toLowerCase());
    });

    it("should reject tampered signature", async () => {
      const account = privateKeyToAccount(generatePrivateKey());

      const extension = createTestChallenge({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/resource",
        network: "eip155:8453",
      });

      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);
      payload.signature = "0x" + "00".repeat(65); // Invalid signature

      const verification = await verifySIWxSignature(payload);
      expect(verification.valid).toBe(false);
    });

    it("should work for auth-only endpoints (no enrichment)", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const resourceUri = "https://api.example.com/resource";

      const extensions = createTestChallenge({
        domain: "api.example.com",
        resourceUri,
        network: "eip155:8453",
        statement: "Sign in to access",
        expirationSeconds: 300,
      });

      const ext = extensions["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);
      const header = encodeSIWxHeader(payload);

      const parsed = parseSIWxHeader(header);
      const validation = await validateSIWxMessage(parsed, resourceUri);
      expect(validation.valid).toBe(true);

      const result = await verifySIWxSignature(parsed);
      expect(result.valid).toBe(true);
      expect(result.address?.toLowerCase()).toBe(account.address.toLowerCase());
    });
  });

  describe("Smart wallet verification (evmVerifier option)", () => {
    it("should use provided verifier for EVM signatures", async () => {
      const mockVerifier: EVMMessageVerifier = vi.fn().mockResolvedValue(true);
      const account = privateKeyToAccount(generatePrivateKey());

      const extension = createTestChallenge({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/resource",
        network: "eip155:8453",
      });

      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);

      const result = await verifySIWxSignature(payload, {
        evmVerifier: mockVerifier,
      });

      expect(mockVerifier).toHaveBeenCalledOnce();
      expect(mockVerifier).toHaveBeenCalledWith({
        address: expect.any(String),
        message: expect.any(String),
        signature: expect.any(String),
      });
      expect(result.valid).toBe(true);
    });

    it("should fallback to EOA verification when no verifier provided", async () => {
      const account = privateKeyToAccount(generatePrivateKey());

      const extension = createTestChallenge({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/resource",
        network: "eip155:8453",
      });

      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);

      // No verifier - should still work for EOA
      const result = await verifySIWxSignature(payload);
      expect(result.valid).toBe(true);
      expect(result.address?.toLowerCase()).toBe(account.address.toLowerCase());
    });

    it("should return error when verifier returns false", async () => {
      const mockVerifier: EVMMessageVerifier = vi.fn().mockResolvedValue(false);
      const account = privateKeyToAccount(generatePrivateKey());

      const extension = createTestChallenge({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/resource",
        network: "eip155:8453",
      });

      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);

      const result = await verifySIWxSignature(payload, {
        evmVerifier: mockVerifier,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Signature verification failed");
    });

    it("should return error when verifier throws", async () => {
      const mockVerifier: EVMMessageVerifier = vi.fn().mockRejectedValue(new Error("RPC error"));
      const account = privateKeyToAccount(generatePrivateKey());

      const extension = createTestChallenge({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/resource",
        network: "eip155:8453",
      });

      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);

      const result = await verifySIWxSignature(payload, {
        evmVerifier: mockVerifier,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("RPC error");
    });

    it("should not use verifier for Solana signatures", async () => {
      const mockVerifier: EVMMessageVerifier = vi.fn();
      const keypair = nacl.sign.keyPair();
      const address = encodeBase58(keypair.publicKey);

      const solanaSigner: SolanaSigner = {
        signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, keypair.secretKey),
        publicKey: address,
      };

      const extension = createTestChallenge({
        domain: "api.example.com",
        resourceUri: "https://api.example.com/resource",
        network: SOLANA_MAINNET,
      });

      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, solanaSigner);

      const result = await verifySIWxSignature(payload, {
        evmVerifier: mockVerifier,
      });

      // Verifier should NOT be called for Solana
      expect(mockVerifier).not.toHaveBeenCalled();
      expect(result.valid).toBe(true);
      expect(result.address).toBe(address);
    });
  });

  describe("Solana constants", () => {
    it("should export Solana network constants", () => {
      expect(SOLANA_MAINNET).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
      expect(SOLANA_DEVNET).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    });
  });

  describe("Base58 encoding/decoding", () => {
    it("should roundtrip encode/decode", () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const encoded = encodeBase58(original);
      const decoded = decodeBase58(encoded);
      expect(decoded).toEqual(original);
    });

    it("should handle leading zeros", () => {
      const withLeadingZeros = new Uint8Array([0, 0, 1, 2, 3]);
      const encoded = encodeBase58(withLeadingZeros);
      const decoded = decodeBase58(encoded);
      expect(decoded).toEqual(withLeadingZeros);
    });

    it("should decode known Solana addresses", () => {
      // This is a valid 32-byte Solana public key
      const address = "11111111111111111111111111111111";
      const decoded = decodeBase58(address);
      expect(decoded.length).toBe(32);
    });

    it("should throw on invalid Base58 characters", () => {
      expect(() => decodeBase58("invalid0OIl")).toThrow("Unknown letter");
    });
  });

  describe("extractSolanaChainReference", () => {
    it("should extract mainnet reference", () => {
      expect(extractSolanaChainReference(SOLANA_MAINNET)).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    });

    it("should extract devnet reference", () => {
      expect(extractSolanaChainReference(SOLANA_DEVNET)).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    });

    it("should return reference for custom networks", () => {
      expect(extractSolanaChainReference("solana:customnetwork123")).toBe("customnetwork123");
    });
  });

  describe("formatSIWSMessage", () => {
    it("should format SIWS message correctly", () => {
      const info = {
        domain: "api.example.com",
        uri: "https://api.example.com/data",
        statement: "Sign in to access",
        version: "1",
        chainId: SOLANA_MAINNET,
        type: "ed25519" as const,
        nonce: "abc123",
        issuedAt: "2024-01-01T00:00:00.000Z",
        resources: ["https://api.example.com/data"],
      };

      const message = formatSIWSMessage(info, "BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW");

      expect(message).toContain("wants you to sign in with your Solana account:");
      expect(message).toContain("BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW");
      expect(message).toContain("Chain ID: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
      expect(message).toContain("Nonce: abc123");
      expect(message).toContain("Sign in to access");
    });

    it("should handle message without statement", () => {
      const info = {
        domain: "api.example.com",
        uri: "https://api.example.com",
        version: "1",
        chainId: SOLANA_DEVNET,
        type: "ed25519" as const,
        nonce: "xyz789",
        issuedAt: "2024-01-01T00:00:00.000Z",
      };

      const message = formatSIWSMessage(info, "TestAddress123");

      expect(message).toContain("wants you to sign in with your Solana account:");
      expect(message).toContain("Chain ID: EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
      expect(message).not.toContain("Sign in to access");
    });
  });

  describe("createSIWxMessage - chain routing", () => {
    it("should route EVM chains to SIWE format", () => {
      const info = {
        domain: "api.example.com",
        uri: "https://api.example.com",
        version: "1",
        chainId: "eip155:1",
        type: "eip191" as const,
        nonce: "abc12345678",
        issuedAt: "2024-01-01T00:00:00.000Z",
      };

      const message = createSIWxMessage(info, "0x1234567890123456789012345678901234567890");

      expect(message).toContain("wants you to sign in with your Ethereum account:");
      expect(message).toContain("Chain ID: 1");
    });

    it("should route Solana chains to SIWS format", () => {
      const info = {
        domain: "api.example.com",
        uri: "https://api.example.com",
        version: "1",
        chainId: SOLANA_MAINNET,
        type: "ed25519" as const,
        nonce: "abc12345678",
        issuedAt: "2024-01-01T00:00:00.000Z",
      };

      const message = createSIWxMessage(info, "BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW");

      expect(message).toContain("wants you to sign in with your Solana account:");
      expect(message).toContain("Chain ID: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    });

    it("should throw for unsupported chain namespaces", () => {
      const info = {
        domain: "api.example.com",
        uri: "https://api.example.com",
        version: "1",
        chainId: "cosmos:cosmoshub-4",
        type: "eip191" as const,
        nonce: "abc12345678",
        issuedAt: "2024-01-01T00:00:00.000Z",
      };

      expect(() => createSIWxMessage(info, "cosmos1...")).toThrow("Unsupported chain namespace");
    });
  });

  describe("Solana signature verification", () => {
    it("should verify valid Ed25519 signature", () => {
      // Generate a test keypair
      const keypair = nacl.sign.keyPair();
      const message = "Test message for signing";
      const messageBytes = new TextEncoder().encode(message);
      const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

      const valid = verifySolanaSignature(message, signature, keypair.publicKey);
      expect(valid).toBe(true);
    });

    it("should reject invalid signature", () => {
      const keypair = nacl.sign.keyPair();
      const message = "Test message";
      const wrongSignature = new Uint8Array(64).fill(0);

      const valid = verifySolanaSignature(message, wrongSignature, keypair.publicKey);
      expect(valid).toBe(false);
    });

    it("should reject signature from different key", () => {
      const keypair1 = nacl.sign.keyPair();
      const keypair2 = nacl.sign.keyPair();
      const message = "Test message";
      const messageBytes = new TextEncoder().encode(message);
      const signature = nacl.sign.detached(messageBytes, keypair1.secretKey);

      // Verify with different public key
      const valid = verifySolanaSignature(message, signature, keypair2.publicKey);
      expect(valid).toBe(false);
    });
  });

  describe("verifySIWxSignature - chain routing", () => {
    it("should reject unsupported chain namespace", async () => {
      const payload = {
        ...validPayload,
        chainId: "cosmos:cosmoshub-4",
        type: "eip191" as const,
      };

      const result = await verifySIWxSignature(payload);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unsupported chain namespace");
    });

    it("should verify Solana signatures", async () => {
      // Generate Solana keypair
      const keypair = nacl.sign.keyPair();
      const address = encodeBase58(keypair.publicKey);

      const serverInfo = {
        domain: "api.example.com",
        uri: "https://api.example.com/data",
        version: "1",
        chainId: SOLANA_MAINNET,
        type: "ed25519" as const,
        nonce: "test123",
        issuedAt: new Date().toISOString(),
      };

      // Create and sign SIWS message
      const message = formatSIWSMessage(serverInfo, address);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
      const signature = encodeBase58(signatureBytes);

      const payload = {
        ...serverInfo,
        address,
        signature,
      };

      const result = await verifySIWxSignature(payload);
      expect(result.valid).toBe(true);
      expect(result.address).toBe(address);
    });

    it("should reject invalid Solana signature length", async () => {
      const payload = {
        domain: "api.example.com",
        uri: "https://api.example.com",
        version: "1",
        chainId: SOLANA_MAINNET,
        type: "ed25519" as const,
        nonce: "test123",
        issuedAt: new Date().toISOString(),
        address: encodeBase58(new Uint8Array(32).fill(1)), // Valid 32-byte key
        signature: encodeBase58(new Uint8Array(32).fill(0)), // Invalid 32-byte sig (should be 64)
      };

      const result = await verifySIWxSignature(payload);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid signature length");
    });
  });

  describe("Solana client-side signing", () => {
    describe("getSolanaAddress", () => {
      it("should get address from string publicKey", () => {
        const signer: SolanaSigner = {
          signMessage: async () => new Uint8Array(64),
          publicKey: "BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW",
        };
        expect(getSolanaAddress(signer)).toBe("BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW");
      });

      it("should get address from PublicKey object", () => {
        const signer: SolanaSigner = {
          signMessage: async () => new Uint8Array(64),
          publicKey: { toBase58: () => "BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW" },
        };
        expect(getSolanaAddress(signer)).toBe("BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW");
      });
    });

    describe("getEVMAddress", () => {
      it("should get address from account property", () => {
        const signer: EVMSigner = {
          signMessage: async () => "0x...",
          account: { address: "0x1234567890123456789012345678901234567890" },
        };
        expect(getEVMAddress(signer)).toBe("0x1234567890123456789012345678901234567890");
      });

      it("should get address from direct address property", () => {
        const signer: EVMSigner = {
          signMessage: async () => "0x...",
          address: "0xabcdef1234567890123456789012345678901234",
        };
        expect(getEVMAddress(signer)).toBe("0xabcdef1234567890123456789012345678901234");
      });

      it("should throw for signer without address", () => {
        const signer: EVMSigner = {
          signMessage: async () => "0x...",
        };
        expect(() => getEVMAddress(signer)).toThrow("EVM signer missing address");
      });
    });

    describe("signSolanaMessage", () => {
      it("should sign and return Base58 encoded signature", async () => {
        const keypair = nacl.sign.keyPair();

        const solanaSigner: SolanaSigner = {
          signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, keypair.secretKey),
          publicKey: encodeBase58(keypair.publicKey),
        };

        const message = "Test message for Solana signing";
        const signature = await signSolanaMessage(message, solanaSigner);

        // Signature should be Base58 encoded
        const decoded = decodeBase58(signature);
        expect(decoded.length).toBe(64); // Ed25519 signature

        // Verify the signature works
        const valid = verifySolanaSignature(message, decoded, keypair.publicKey);
        expect(valid).toBe(true);
      });
    });

    describe("createSIWxPayload with Solana signer", () => {
      it("should create valid payload with Solana signer", async () => {
        const keypair = nacl.sign.keyPair();
        const address = encodeBase58(keypair.publicKey);

        const solanaSigner: SolanaSigner = {
          signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, keypair.secretKey),
          publicKey: address,
        };

        const serverInfo = {
          domain: "api.example.com",
          uri: "https://api.example.com/data",
          version: "1",
          chainId: SOLANA_MAINNET,
          type: "ed25519" as const,
          nonce: "test123456789",
          issuedAt: new Date().toISOString(),
        };

        const payload = await createSIWxPayload(serverInfo, solanaSigner);

        expect(payload.address).toBe(address);
        expect(payload.chainId).toBe(SOLANA_MAINNET);

        // Verify the signature is valid
        const result = await verifySIWxSignature(payload);
        expect(result.valid).toBe(true);
        expect(result.address).toBe(address);
      });

      it("should roundtrip through encode/parse/verify with Solana", async () => {
        const keypair = nacl.sign.keyPair();
        const address = encodeBase58(keypair.publicKey);

        const solanaSigner: SolanaSigner = {
          signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, keypair.secretKey),
          publicKey: address,
        };

        const extension = createTestChallenge({
          domain: "api.example.com",
          resourceUri: "https://api.example.com/resource",
          network: SOLANA_MAINNET,
          statement: "Sign in to access",
        });

        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, solanaSigner);
        const header = encodeSIWxHeader(payload);
        const parsed = parseSIWxHeader(header);

        const validation = await validateSIWxMessage(parsed, "https://api.example.com/resource");
        expect(validation.valid).toBe(true);

        const verification = await verifySIWxSignature(parsed);
        expect(verification.valid).toBe(true);
        expect(verification.address).toBe(address);
      });

      it("should work with PublicKey object style signer", async () => {
        const keypair = nacl.sign.keyPair();
        const address = encodeBase58(keypair.publicKey);

        // Mimic @solana/wallet-adapter style
        const solanaSigner: SolanaSigner = {
          signMessage: async (msg: Uint8Array) => nacl.sign.detached(msg, keypair.secretKey),
          publicKey: { toBase58: () => address },
        };

        const extension = createTestChallenge({
          domain: "api.example.com",
          resourceUri: "https://api.example.com/resource",
          network: SOLANA_DEVNET,
        });

        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, solanaSigner);

        expect(payload.address).toBe(address);
        expect(payload.chainId).toBe(SOLANA_DEVNET);

        const verification = await verifySIWxSignature(payload);
        expect(verification.valid).toBe(true);
      });
    });

    describe("signatureScheme behavior", () => {
      it("verification ignores signatureScheme and uses chainId", async () => {
        // This test documents that signatureScheme is a hint only
        const keypair = nacl.sign.keyPair();
        const address = encodeBase58(keypair.publicKey);

        const serverInfo = {
          domain: "api.example.com",
          uri: "https://api.example.com",
          version: "1",
          chainId: SOLANA_MAINNET,
          type: "ed25519" as const,
          nonce: "test12345",
          issuedAt: new Date().toISOString(),
          signatureScheme: "eip191" as const, // Wrong hint - should be "siws"
        };

        // Create message and sign
        const message = formatSIWSMessage(serverInfo, address);
        const messageBytes = new TextEncoder().encode(message);
        const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);

        const payload = {
          ...serverInfo,
          address,
          signature: encodeBase58(signatureBytes),
          signatureScheme: "eip191" as const, // Wrong hint
        };

        // Verification should still work because it uses chainId, not signatureScheme
        const result = await verifySIWxSignature(payload);
        expect(result.valid).toBe(true); // Proves signatureScheme is ignored
      });
    });
  });
});

describe("SIWxStorage", () => {
  describe("InMemorySIWxStorage", () => {
    it("should record and check payments", () => {
      const storage = new InMemorySIWxStorage();

      expect(storage.hasPaid("/resource", "0xABC")).toBe(false);

      storage.recordPayment("/resource", "0xABC");
      expect(storage.hasPaid("/resource", "0xABC")).toBe(true);
      expect(storage.hasPaid("/resource", "0xDEF")).toBe(false);
      expect(storage.hasPaid("/other", "0xABC")).toBe(false);
    });

    it("should normalize addresses to lowercase", () => {
      const storage = new InMemorySIWxStorage();

      storage.recordPayment("/resource", "0xABCDEF");
      expect(storage.hasPaid("/resource", "0xabcdef")).toBe(true);
      expect(storage.hasPaid("/resource", "0xABCDEF")).toBe(true);
    });

    it("should handle multiple resources independently", () => {
      const storage = new InMemorySIWxStorage();

      storage.recordPayment("/a", "0x1");
      storage.recordPayment("/b", "0x2");

      expect(storage.hasPaid("/a", "0x1")).toBe(true);
      expect(storage.hasPaid("/a", "0x2")).toBe(false);
      expect(storage.hasPaid("/b", "0x1")).toBe(false);
      expect(storage.hasPaid("/b", "0x2")).toBe(true);
    });
  });
});

describe("SIWX Hooks", () => {
  describe("createSIWxSettleHook", () => {
    it("should record payment using result.payer (EVM flow)", async () => {
      const storage = new InMemorySIWxStorage();
      const hook = createSIWxSettleHook({ storage });

      // Payer comes from facilitator result, not extracted from payload
      await hook({
        paymentPayload: {
          payload: { authorization: { from: "0xABC123" } },
          resource: { url: "http://example.com/weather" },
        },
        result: { success: true, payer: "0xABC123" },
      });

      expect(storage.hasPaid("/weather", "0xABC123")).toBe(true);
    });

    it("should record payment using result.payer (SVM flow)", async () => {
      const storage = new InMemorySIWxStorage();
      const hook = createSIWxSettleHook({ storage });

      // SVM payload is just { transaction: string }, payer comes from facilitator result
      await hook({
        paymentPayload: {
          payload: { transaction: "base64EncodedTransaction" },
          resource: { url: "http://example.com/data" },
        },
        result: { success: true, payer: "SolanaAddress123" },
      });

      expect(storage.hasPaid("/data", "SolanaAddress123")).toBe(true);
    });

    it("should call onEvent when payment is recorded", async () => {
      const storage = new InMemorySIWxStorage();
      const events: unknown[] = [];
      const hook = createSIWxSettleHook({
        storage,
        onEvent: e => events.push(e),
      });

      await hook({
        paymentPayload: {
          payload: { authorization: { from: "0x123" } },
          resource: { url: "http://example.com/test" },
        },
        result: { success: true, payer: "0x123" },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "payment_recorded",
        resource: "/test",
        address: "0x123",
      });
    });

    it("should not record if result.payer is undefined", async () => {
      const storage = new InMemorySIWxStorage();
      const hook = createSIWxSettleHook({ storage });

      // When facilitator doesn't return payer (e.g., older facilitator version)
      await hook({
        paymentPayload: {
          payload: { transaction: "someTransaction" },
          resource: { url: "http://example.com/test" },
        },
        result: { success: true },
      });

      // No exception, just silently skips since no payer available
      expect(storage.hasPaid("/test", "anything")).toBe(false);
    });

    it("should NOT record payment if settlement failed", async () => {
      const storage = new InMemorySIWxStorage();
      const hook = createSIWxSettleHook({ storage });

      // Even if payer is provided, don't record on failed settlement
      await hook({
        paymentPayload: {
          payload: { authorization: { from: "0xABC123" } },
          resource: { url: "http://example.com/weather" },
        },
        result: { success: false, payer: "0xABC123" },
      });

      // Payment should NOT be recorded when settlement fails
      expect(storage.hasPaid("/weather", "0xABC123")).toBe(false);
    });
  });

  describe("createSIWxRequestHook", () => {
    it("should return undefined when no SIWX header", async () => {
      const storage = new InMemorySIWxStorage();
      const hook = createSIWxRequestHook({ storage });

      const result = await hook({
        adapter: {
          getHeader: () => undefined,
          getUrl: () => "http://example.com/test",
        },
        path: "/test",
      });

      expect(result).toBeUndefined();
    });

    it("should grant access when address has paid", async () => {
      const storage = new InMemorySIWxStorage();
      const account = privateKeyToAccount(generatePrivateKey());

      // Pre-record payment
      storage.recordPayment("/resource", account.address);

      // Create valid SIWX header
      const extension = createTestChallenge({
        domain: "example.com",
        resourceUri: "http://example.com/resource",
        network: "eip155:8453",
      });
      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);
      const header = encodeSIWxHeader(payload);

      const hook = createSIWxRequestHook({ storage });
      const result = await hook({
        adapter: {
          getHeader: (name: string) =>
            name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
          getUrl: () => "http://example.com/resource",
        },
        path: "/resource",
      });

      expect(result).toEqual({ grantAccess: true });
    });

    it("should return undefined when address has not paid", async () => {
      const storage = new InMemorySIWxStorage();
      const account = privateKeyToAccount(generatePrivateKey());

      // Don't pre-record payment

      const extension = createTestChallenge({
        domain: "example.com",
        resourceUri: "http://example.com/resource",
        network: "eip155:8453",
      });
      const ext = extension["sign-in-with-x"];
      const completeInfo = {
        ...ext.info,
        chainId: ext.supportedChains[0].chainId,
        type: ext.supportedChains[0].type,
      };
      const payload = await createSIWxPayload(completeInfo, account);
      const header = encodeSIWxHeader(payload);

      const hook = createSIWxRequestHook({ storage });
      const result = await hook({
        adapter: {
          getHeader: (name: string) => (name === "sign-in-with-x" ? header : undefined),
          getUrl: () => "http://example.com/resource",
        },
        path: "/resource",
      });

      expect(result).toBeUndefined();
    });

    it("should emit validation_failed event on invalid signature", async () => {
      const storage = new InMemorySIWxStorage();
      const events: unknown[] = [];
      const hook = createSIWxRequestHook({
        storage,
        onEvent: e => events.push(e),
      });

      // Create invalid header (valid base64/json but bad signature)
      const invalidPayload = {
        domain: "example.com",
        address: "0x1234567890123456789012345678901234567890",
        uri: "http://example.com/resource",
        version: "1",
        chainId: "eip155:8453",
        type: "eip191",
        nonce: "test123",
        issuedAt: new Date().toISOString(),
        signature: "0x" + "00".repeat(65),
      };
      const header = safeBase64Encode(JSON.stringify(invalidPayload));

      await hook({
        adapter: {
          getHeader: (name: string) => (name === "sign-in-with-x" ? header : undefined),
          getUrl: () => "http://example.com/resource",
        },
        path: "/resource",
      });

      expect(events.some((e: SIWxHookEvent) => e.type === "validation_failed")).toBe(true);
    });

    describe("nonce tracking", () => {
      it("should throw if only hasUsedNonce is implemented", () => {
        const storage = new InMemorySIWxStorage();
        const partialStorage = {
          ...storage,
          hasPaid: storage.hasPaid.bind(storage),
          recordPayment: storage.recordPayment.bind(storage),
          hasUsedNonce: () => false,
          // recordNonce intentionally missing
        };

        expect(() => createSIWxRequestHook({ storage: partialStorage })).toThrow(
          "SIWxStorage nonce tracking requires both hasUsedNonce and recordNonce to be implemented",
        );
      });

      it("should throw if only recordNonce is implemented", () => {
        const storage = new InMemorySIWxStorage();
        const partialStorage = {
          ...storage,
          hasPaid: storage.hasPaid.bind(storage),
          recordPayment: storage.recordPayment.bind(storage),
          // hasUsedNonce intentionally missing
          recordNonce: () => {},
        };

        expect(() => createSIWxRequestHook({ storage: partialStorage })).toThrow(
          "SIWxStorage nonce tracking requires both hasUsedNonce and recordNonce to be implemented",
        );
      });

      /**
       * Creates a storage implementation with nonce tracking for testing.
       *
       * @returns Storage with hasUsedNonce/recordNonce methods and exposed _usedNonces set
       */
      function createNonceTrackingStorage() {
        const storage = new InMemorySIWxStorage();
        const usedNonces = new Set<string>();
        return {
          ...storage,
          hasPaid: storage.hasPaid.bind(storage),
          recordPayment: storage.recordPayment.bind(storage),
          hasUsedNonce: (nonce: string) => usedNonces.has(nonce),
          recordNonce: (nonce: string) => {
            usedNonces.add(nonce);
          },
          // Expose for test assertions
          _usedNonces: usedNonces,
        };
      }

      it("should reject access when nonce is already used", async () => {
        const storage = createNonceTrackingStorage();
        const account = privateKeyToAccount(generatePrivateKey());
        const events: SIWxHookEvent[] = [];

        // Pre-record payment
        storage.recordPayment("/resource", account.address);

        // Create valid SIWX header
        const extension = createTestChallenge({
          domain: "example.com",
          resourceUri: "http://example.com/resource",
          network: "eip155:8453",
        });
        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, account);
        const header = encodeSIWxHeader(payload);

        // Mark nonce as already used
        storage.recordNonce(payload.nonce);

        const hook = createSIWxRequestHook({ storage, onEvent: e => events.push(e) });
        const result = await hook({
          adapter: {
            getHeader: (name: string) =>
              name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
            getUrl: () => "http://example.com/resource",
          },
          path: "/resource",
        });

        // Should reject even though address has paid
        expect(result).toBeUndefined();
        expect(events.some(e => e.type === "nonce_reused")).toBe(true);
      });

      it("should record nonce when granting access", async () => {
        const storage = createNonceTrackingStorage();
        const account = privateKeyToAccount(generatePrivateKey());

        // Pre-record payment
        storage.recordPayment("/resource", account.address);

        // Create valid SIWX header
        const extension = createTestChallenge({
          domain: "example.com",
          resourceUri: "http://example.com/resource",
          network: "eip155:8453",
        });
        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, account);
        const header = encodeSIWxHeader(payload);

        const hook = createSIWxRequestHook({ storage });
        const result = await hook({
          adapter: {
            getHeader: (name: string) =>
              name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
            getUrl: () => "http://example.com/resource",
          },
          path: "/resource",
        });

        // Should grant access
        expect(result).toEqual({ grantAccess: true });
        // Nonce should be recorded
        expect(storage._usedNonces.has(payload.nonce)).toBe(true);
      });

      it("should work without nonce tracking (InMemorySIWxStorage)", async () => {
        // This tests that the hook works when storage doesn't implement nonce methods
        const storage = new InMemorySIWxStorage();
        const account = privateKeyToAccount(generatePrivateKey());

        // Pre-record payment
        storage.recordPayment("/resource", account.address);

        // Create valid SIWX header
        const extension = createTestChallenge({
          domain: "example.com",
          resourceUri: "http://example.com/resource",
          network: "eip155:8453",
        });
        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, account);
        const header = encodeSIWxHeader(payload);

        const hook = createSIWxRequestHook({ storage });

        // First request should succeed
        const result1 = await hook({
          adapter: {
            getHeader: (name: string) =>
              name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
            getUrl: () => "http://example.com/resource",
          },
          path: "/resource",
        });
        expect(result1).toEqual({ grantAccess: true });

        // Second request with same header should also succeed (no nonce tracking)
        const result2 = await hook({
          adapter: {
            getHeader: (name: string) =>
              name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
            getUrl: () => "http://example.com/resource",
          },
          path: "/resource",
        });
        expect(result2).toEqual({ grantAccess: true });
      });
    });

    describe("auth-only routes (accepts: [])", () => {
      it("should grant access with valid SIWX when accepts is empty array", async () => {
        const storage = new InMemorySIWxStorage();
        const account = privateKeyToAccount(generatePrivateKey());

        // Do NOT record any payment — auth-only should not require it

        const extension = createTestChallenge({
          domain: "example.com",
          resourceUri: "http://example.com/profile",
          network: "eip155:8453",
        });
        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, account);
        const header = encodeSIWxHeader(payload);

        const hook = createSIWxRequestHook({ storage });
        const result = await hook(
          {
            adapter: {
              getHeader: (name: string) =>
                name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
              getUrl: () => "http://example.com/profile",
            },
            path: "/profile",
          },
          { accepts: [] },
        );

        expect(result).toEqual({ grantAccess: true });
      });

      it("should reject nonce replay on auth-only routes", async () => {
        const base = new InMemorySIWxStorage();
        const usedNonces = new Set<string>();
        const storage = {
          ...base,
          hasPaid: base.hasPaid.bind(base),
          recordPayment: base.recordPayment.bind(base),
          hasUsedNonce: (nonce: string) => usedNonces.has(nonce),
          recordNonce: (nonce: string) => {
            usedNonces.add(nonce);
          },
        };

        const account = privateKeyToAccount(generatePrivateKey());
        const events: SIWxHookEvent[] = [];

        const extension = createTestChallenge({
          domain: "example.com",
          resourceUri: "http://example.com/profile",
          network: "eip155:8453",
        });
        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, account);
        const header = encodeSIWxHeader(payload);

        const hook = createSIWxRequestHook({ storage, onEvent: e => events.push(e) });
        const authOnlyRoute = { accepts: [] };
        const context = {
          adapter: {
            getHeader: (name: string) =>
              name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
            getUrl: () => "http://example.com/profile",
          },
          path: "/profile",
        };

        // First request should succeed
        const result1 = await hook(context, authOnlyRoute);
        expect(result1).toEqual({ grantAccess: true });

        // Second request with same nonce should be rejected
        const result2 = await hook(context, authOnlyRoute);
        expect(result2).toBeUndefined();
        expect(events.some(e => e.type === "nonce_reused")).toBe(true);
      });

      it("should NOT grant access without routeConfig when address has not paid", async () => {
        const storage = new InMemorySIWxStorage();
        const account = privateKeyToAccount(generatePrivateKey());

        // No payment recorded, no routeConfig passed — should behave as before
        const extension = createTestChallenge({
          domain: "example.com",
          resourceUri: "http://example.com/resource",
          network: "eip155:8453",
        });
        const ext = extension["sign-in-with-x"];
        const completeInfo = {
          ...ext.info,
          chainId: ext.supportedChains[0].chainId,
          type: ext.supportedChains[0].type,
        };
        const payload = await createSIWxPayload(completeInfo, account);
        const header = encodeSIWxHeader(payload);

        const hook = createSIWxRequestHook({ storage });
        const result = await hook({
          adapter: {
            getHeader: (name: string) =>
              name === "sign-in-with-x" || name === "SIGN-IN-WITH-X" ? header : undefined,
            getUrl: () => "http://example.com/resource",
          },
          path: "/resource",
        });

        expect(result).toBeUndefined();
      });
    });
  });

  describe("createSIWxClientHook", () => {
    it("should return undefined when no SIWX extension", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const hook = createSIWxClientHook(account);

      const result = await hook({
        paymentRequired: { extensions: {} },
      });

      expect(result).toBeUndefined();
    });

    it("should return headers when SIWX extension present", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      const hook = createSIWxClientHook(account);

      const challenge = createTestChallenge({
        domain: "example.com",
        resourceUri: "http://example.com/resource",
        network: "eip155:1",
      });

      const result = await hook({
        paymentRequired: {
          accepts: [{ network: "eip155:1" }],
          extensions: challenge,
        },
      });

      expect(result).toHaveProperty("headers");
      expect(result!.headers).toHaveProperty("sign-in-with-x");

      // Verify the header is valid
      const parsed = parseSIWxHeader(result!.headers["sign-in-with-x"]);
      expect(parsed.address.toLowerCase()).toBe(account.address.toLowerCase());
    });
  });
});

describe("siwxResourceServerExtension", () => {
  const mockContext = (networks: string[], url = "https://api.example.com/resource") => ({
    requirements: networks.map(network => ({ network, scheme: "exact" })),
    resourceInfo: { url },
  });

  it("derives single network from requirements", async () => {
    const declaration = declareSIWxExtension({});
    const ext = declaration["sign-in-with-x"];

    const result = (await siwxResourceServerExtension.enrichPaymentRequiredResponse!(
      ext,
      mockContext(["eip155:8453"]),
    )) as SIWxExtension;

    expect(result.supportedChains).toHaveLength(1);
    expect(result.supportedChains[0]).toEqual({ chainId: "eip155:8453", type: "eip191" });
  });

  it("derives multiple networks from requirements (EVM + Solana)", async () => {
    const declaration = declareSIWxExtension({});
    const ext = declaration["sign-in-with-x"];

    const result = (await siwxResourceServerExtension.enrichPaymentRequiredResponse!(
      ext,
      mockContext(["eip155:8453", SOLANA_MAINNET]),
    )) as SIWxExtension;

    expect(result.supportedChains).toHaveLength(2);
    expect(result.supportedChains[0]).toEqual({ chainId: "eip155:8453", type: "eip191" });
    expect(result.supportedChains[1]).toEqual({ chainId: SOLANA_MAINNET, type: "ed25519" });
  });

  it("generates fresh time-based fields", async () => {
    const declaration = declareSIWxExtension({ expirationSeconds: 300 });
    const ext = declaration["sign-in-with-x"];

    const result = (await siwxResourceServerExtension.enrichPaymentRequiredResponse!(
      ext,
      mockContext(["eip155:8453"]),
    )) as SIWxExtension;

    expect(result.info.nonce).toHaveLength(32);
    expect(result.info.issuedAt).toBeDefined();
    expect(result.info.expirationTime).toBeDefined();
  });

  it("derives domain and uri from request context", async () => {
    const declaration = declareSIWxExtension({});
    const ext = declaration["sign-in-with-x"];

    const result = (await siwxResourceServerExtension.enrichPaymentRequiredResponse!(
      ext,
      mockContext(["eip155:8453"], "https://api.example.com/data"),
    )) as SIWxExtension;

    expect(result.info.domain).toBe("api.example.com");
    expect(result.info.uri).toBe("https://api.example.com/data");
  });

  it("should generate time-based fields from static declaration", async () => {
    const declaration = declareSIWxExtension({ expirationSeconds: 300 });
    const ext = declaration["sign-in-with-x"];

    // Static declaration has no nonce/issuedAt
    expect(ext.info.nonce).toBeUndefined();
    expect(ext.info.issuedAt).toBeUndefined();

    const result = (await siwxResourceServerExtension.enrichPaymentRequiredResponse!(
      ext,
      mockContext(["eip155:8453"]),
    )) as SIWxExtension;

    // Enrichment generates fresh time-based fields
    expect(result.info.nonce).toHaveLength(32);
    expect(result.info.issuedAt).toBeDefined();
    expect(result.info.expirationTime).toBeDefined();
  });
});
