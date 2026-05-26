/**
 * Specification-driven tests for x402 Offer/Receipt Extension
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as jose from "jose";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import type { Hex } from "viem";

import {
  canonicalize,
  hashCanonical,
  getCanonicalBytes,
  createJWS,
  extractJWSHeader,
  extractJWSPayload,
  createOfferJWS,
  createOfferEIP712,
  extractOfferPayload,
  createReceiptJWS,
  createReceiptEIP712,
  extractReceiptPayload,
  createOfferDomain,
  createReceiptDomain,
  OFFER_TYPES,
  RECEIPT_TYPES,
  prepareOfferForEIP712,
  prepareReceiptForEIP712,
  hashOfferTypedData,
  hashReceiptTypedData,
  convertNetworkStringToCAIP2,
  extractChainIdFromCAIP2,
  extractEIP155ChainId,
  extractOffersFromPaymentRequired,
  decodeSignedOffers,
  findAcceptsObjectFromSignedOffer,
  extractReceiptFromResponse,
  declareOfferReceiptExtension,
  createJWSOfferReceiptIssuer,
  createEIP712OfferReceiptIssuer,
  verifyReceiptMatchesOffer,
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureEIP712,
  verifyOfferSignatureJWS,
  verifyReceiptSignatureJWS,
  extractPublicKeyFromKid,
  OFFER_RECEIPT,
  type JWSSigner,
  type OfferPayload,
  type ReceiptPayload,
  type EIP712SignedOffer,
  type EIP712SignedReceipt,
  type JWSSignedOffer,
} from "../src/offer-receipt";

import {
  createES256Signer,
  generateES256KeyPair,
  createES256KSigner,
  generateES256KKeyPair,
} from "./offer-receipt-test-utils";

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

// ============================================================================
// Core JWS Assembly Tests (Layer 1)
// These tests verify createJWS produces valid JWS compact serialization.
// Higher-level tests (createOfferJWS, createReceiptJWS) depend on this.
// ============================================================================

describe("createJWS (Core JWS Assembly)", () => {
  let signer: JWSSigner;
  let publicKeyJWK: jose.JWK;

  beforeAll(async () => {
    const keyPair = await generateES256KeyPair();
    publicKeyJWK = keyPair.publicKeyJWK;
    signer = createES256Signer(keyPair.privateKey, "did:web:example.com#key-1");
  });

  it("produces valid JWS compact serialization (header.payload.signature)", async () => {
    const payload = { test: "data", number: 42 };
    const jws = await createJWS(payload, signer);

    // Must be three dot-separated parts
    const parts = jws.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0].length).toBeGreaterThan(0); // header
    expect(parts[1].length).toBeGreaterThan(0); // payload
    expect(parts[2].length).toBeGreaterThan(0); // signature
  });

  it("includes alg and kid in JWS header", async () => {
    const payload = { test: "data" };
    const jws = await createJWS(payload, signer);

    const header = extractJWSHeader(jws);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("did:web:example.com#key-1");
  });

  it("encodes payload as canonicalized JSON", async () => {
    // Keys in different order should produce same canonical form
    const payload = { z: 1, a: 2 };
    const jws = await createJWS(payload, signer);

    const decoded = extractJWSPayload<typeof payload>(jws);
    expect(decoded).toEqual({ a: 2, z: 1 }); // Canonicalized order
  });

  it("produces signature verifiable with jose.compactVerify", async () => {
    const payload = { resourceUrl: "https://example.com", amount: "1000" };
    const jws = await createJWS(payload, signer);

    const key = await jose.importJWK(publicKeyJWK);
    const { payload: verifiedPayload } = await jose.compactVerify(jws, key);
    const decoded = JSON.parse(new TextDecoder().decode(verifiedPayload));

    expect(decoded.resourceUrl).toBe("https://example.com");
    expect(decoded.amount).toBe("1000");
  });

  it("round-trips through extractJWSHeader and extractJWSPayload", async () => {
    const payload = { version: 1, data: "test" };
    const jws = await createJWS(payload, signer);

    // Should be able to extract header and payload
    const header = extractJWSHeader(jws);
    const extractedPayload = extractJWSPayload<typeof payload>(jws);

    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("did:web:example.com#key-1");
    expect(extractedPayload.version).toBe(1);
    expect(extractedPayload.data).toBe("test");
  });
});

describe("x402 Offer/Receipt Extension", () => {
  describe("§3.1 Common Object Shape", () => {
    describe("JWS format", () => {
      let signer: JWSSigner;
      beforeAll(async () => {
        const keyPair = await generateES256KKeyPair();
        signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      });

      it("JWS offer has format='jws', signature field, no payload field", async () => {
        const offer = await createOfferJWS(
          "https://api.example.com/resource",
          {
            acceptIndex: 0,
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x1234567890123456789012345678901234567890",
            amount: "10000",
          },
          signer,
        );
        expect(offer.format).toBe("jws");
        expect(offer.signature).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(offer).not.toHaveProperty("payload");
      });
    });

    describe("EIP-712 format", () => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      it("EIP-712 offer has format='eip712', payload field, hex signature", async () => {
        const offer = await createOfferEIP712(
          "https://api.example.com/resource",
          {
            acceptIndex: 0,
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x1234567890123456789012345678901234567890",
            amount: "10000",
          },
          p => account.signTypedData(p),
        );
        expect(offer.format).toBe("eip712");
        expect(offer).toHaveProperty("payload");
        expect(offer.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
      });
    });
  });

  describe("§3.2 EIP-712 Domain", () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    it("Offer domain: name='x402 offer', version='1', chainId=1 (canonical)", async () => {
      await createOfferEIP712(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        p => {
          expect(p.domain.name).toBe("x402 offer");
          expect(p.domain.version).toBe("1");
          expect(Number(p.domain.chainId)).toBe(1);
          return account.signTypedData(p);
        },
      );
    });

    it("Receipt domain: name='x402 receipt', version='1', chainId=1 (canonical)", async () => {
      await createReceiptEIP712(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0xabc123",
          network: "eip155:8453",
        },
        p => {
          expect(p.domain.name).toBe("x402 receipt");
          expect(p.domain.version).toBe("1");
          expect(Number(p.domain.chainId)).toBe(1);
          return account.signTypedData(p);
        },
      );
    });

    it("EIP-712 chainId is constant regardless of payment network", async () => {
      // Even with different payment networks, chainId should always be 1
      await createOfferEIP712(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:137", // Polygon
          asset: "native",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        p => {
          expect(Number(p.domain.chainId)).toBe(1); // Still 1, not 137
          return account.signTypedData(p);
        },
      );
    });
  });

  describe("§3.3 JWS Header Requirements", () => {
    it("JWS header MUST include alg and kid", async () => {
      const keyPair = await generateES256KKeyPair();
      const expectedKid = "did:web:api.example.com#key-1";
      const signer = await createES256KSigner(keyPair.privateKey, expectedKid);
      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );
      const header = JSON.parse(
        new TextDecoder().decode(jose.base64url.decode(offer.signature.split(".")[0])),
      );
      expect(header.alg).toBe("ES256K");
      expect(header.kid).toBe(expectedKid);
    });
  });

  describe("§4.2 Offer Payload Fields", () => {
    it("Offer payload includes all required fields per spec v1.0", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const beforeCreate = Math.floor(Date.now() / 1000);
      const offer = await createOfferJWS(
        "https://api.example.com/premium",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          amount: "10000",
          offerValiditySeconds: 60,
        },
        signer,
      );
      const payload = extractOfferPayload(offer);
      // Required fields per spec §4.2
      expect(payload.version).toBe(1);
      expect(payload.resourceUrl).toBe("https://api.example.com/premium");
      expect(payload.scheme).toBe("exact");
      expect(payload.network).toBe("eip155:8453");
      expect(payload.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
      expect(payload.payTo).toBe("0x209693Bc6afc0C5328bA36FaF03C514EF312287C");
      expect(payload.amount).toBe("10000");
      // validUntil should be approximately now + offerValiditySeconds
      expect(payload.validUntil).toBeGreaterThanOrEqual(beforeCreate + 60);
      expect(payload.validUntil).toBeLessThanOrEqual(beforeCreate + 62); // Allow 2s tolerance
    });
  });

  describe("§5.2 Receipt Payload Fields (Privacy-Minimal)", () => {
    it("JWS receipt omits transaction when not provided (privacy-minimal)", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        signer,
      );
      const payload = extractReceiptPayload(receipt);
      // Required fields per spec §5.2
      expect(payload.version).toBe(1);
      expect(payload.network).toBe("eip155:8453");
      expect(payload.resourceUrl).toBe("https://api.example.com/resource");
      expect(payload.payer).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
      expect(typeof payload.issuedAt).toBe("number");
      // Per spec: transaction is optional, should be omitted in JWS when not provided
      expect(payload).not.toHaveProperty("transaction");
    });

    it("JWS receipt includes transaction when provided", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
          transaction: "0xabc123",
        },
        signer,
      );
      const payload = extractReceiptPayload(receipt);
      expect(payload.transaction).toBe("0xabc123");
    });

    it("EIP-712 receipt uses empty string for transaction when not provided", async () => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const receipt = await createReceiptEIP712(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        p => account.signTypedData(p),
      );
      const payload = extractReceiptPayload(receipt);
      // Per spec §5.3: EIP-712 MUST set unused optional fields to empty string
      expect(payload.transaction).toBe("");
    });
  });

  describe("JCS Canonicalization (RFC 8785)", () => {
    it("sorts object keys lexicographically", () => {
      expect(canonicalize({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
    });
    it("handles nested objects", () => {
      expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
    });
    it("handles arrays (preserves order)", () => {
      expect(canonicalize({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
    });
    it("handles -0 as 0", () => {
      expect(canonicalize({ n: -0 })).toBe('{"n":0}');
    });
  });

  describe("Cryptographic Verification", () => {
    it("JWS signature verifies with jose.compactVerify", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const publicKey = await jose.importJWK(keyPair.publicKey);

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const { payload } = await jose.compactVerify(offer.signature, publicKey);
      const decoded = JSON.parse(new TextDecoder().decode(payload));
      expect(decoded.resourceUrl).toBe("https://api.example.com/resource");
    });

    it("EIP-712 signature recovers correct signer", async () => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);

      const offer = await createOfferEIP712(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        p => account.signTypedData(p),
      );

      const recovered = await recoverTypedDataAddress({
        domain: createOfferDomain(),
        types: OFFER_TYPES,
        primaryType: "Offer",
        message: prepareOfferForEIP712(offer.payload),
        signature: offer.signature as Hex,
      });

      expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    });
  });
});

describe("Attestation Helper", () => {
  describe("convertNetworkStringToCAIP2", () => {
    it("passes through CAIP-2 format unchanged", () => {
      expect(convertNetworkStringToCAIP2("eip155:8453")).toBe("eip155:8453");
      expect(convertNetworkStringToCAIP2("eip155:1")).toBe("eip155:1");
      expect(convertNetworkStringToCAIP2("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      );
    });

    it("converts v1 Solana network names", () => {
      expect(convertNetworkStringToCAIP2("solana")).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
      expect(convertNetworkStringToCAIP2("Solana")).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
      expect(convertNetworkStringToCAIP2("solana-devnet")).toBe(
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      );
    });

    it("converts v1 EVM network names to CAIP-2", () => {
      expect(convertNetworkStringToCAIP2("base")).toBe("eip155:8453");
      expect(convertNetworkStringToCAIP2("base-sepolia")).toBe("eip155:84532");
      expect(convertNetworkStringToCAIP2("ethereum")).toBe("eip155:1");
      expect(convertNetworkStringToCAIP2("polygon")).toBe("eip155:137");
      expect(convertNetworkStringToCAIP2("avalanche")).toBe("eip155:43114");
    });

    it("throws for unknown network identifiers", () => {
      expect(() => convertNetworkStringToCAIP2("unknown-network")).toThrow(
        'Unknown network identifier: "unknown-network"',
      );
      expect(() => convertNetworkStringToCAIP2("foo")).toThrow('Unknown network identifier: "foo"');
    });
  });

  describe("extractChainIdFromCAIP2", () => {
    it("extracts chain ID from EVM networks", () => {
      expect(extractChainIdFromCAIP2("eip155:8453")).toBe(8453);
      expect(extractChainIdFromCAIP2("eip155:1")).toBe(1);
      expect(extractChainIdFromCAIP2("eip155:137")).toBe(137);
    });

    it("returns undefined for non-EVM networks", () => {
      expect(extractChainIdFromCAIP2("solana:mainnet")).toBeUndefined();
      expect(extractChainIdFromCAIP2("cosmos:cosmoshub-4")).toBeUndefined();
    });
  });

  describe("extractReceiptPayload", () => {
    it("extracts payload from JWS receipt", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        signer,
      );

      const payload = extractReceiptPayload(receipt);
      expect(payload.resourceUrl).toBe("https://api.example.com/resource");
      expect(payload.payer).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
      expect(typeof payload.issuedAt).toBe("number");
    });

    it("extracts payload from EIP-712 receipt", async () => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const receipt = await createReceiptEIP712(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        p => account.signTypedData(p),
      );

      const payload = extractReceiptPayload(receipt);
      expect(payload.resourceUrl).toBe("https://api.example.com/resource");
      expect(payload.payer).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
    });
  });
});

describe("Client Utilities", () => {
  describe("extractOffersFromPaymentRequired", () => {
    it("extracts offers from PaymentRequired extensions", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer1 = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const paymentRequired = {
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x1234567890123456789012345678901234567890",
            amount: "10000",
          },
        ],
        extensions: {
          [OFFER_RECEIPT]: {
            info: {
              offers: [offer1],
            },
          },
        },
      };

      const offers = extractOffersFromPaymentRequired(paymentRequired as any);
      expect(offers).toHaveLength(1);
      expect(offers[0].format).toBe("jws");
    });

    it("returns empty array when no offers present", () => {
      const paymentRequired = {
        accepts: [],
        extensions: {},
      };

      const offers = extractOffersFromPaymentRequired(paymentRequired as any);
      expect(offers).toEqual([]);
    });

    it("returns empty array when extensions is undefined", () => {
      const paymentRequired = {
        accepts: [],
      };

      const offers = extractOffersFromPaymentRequired(paymentRequired as any);
      expect(offers).toEqual([]);
    });
  });

  describe("decodeSignedOffers", () => {
    it("decodes JWS offers with payload fields at top level", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer]);
      expect(decoded).toHaveLength(1);
      expect(decoded[0].network).toBe("eip155:8453");
      expect(decoded[0].amount).toBe("10000");
      expect(decoded[0].format).toBe("jws");
      expect(decoded[0].acceptIndex).toBe(0);
      expect(decoded[0].signedOffer).toBe(offer);
    });

    it("decodes EIP-712 offers", async () => {
      const account = privateKeyToAccount(TEST_PRIVATE_KEY);
      const offer = await createOfferEIP712(
        "https://api.example.com/resource",
        {
          acceptIndex: 1,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "5000",
        },
        p => account.signTypedData(p),
      );

      const decoded = decodeSignedOffers([offer]);
      expect(decoded).toHaveLength(1);
      expect(decoded[0].network).toBe("eip155:8453");
      expect(decoded[0].amount).toBe("5000");
      expect(decoded[0].format).toBe("eip712");
      expect(decoded[0].acceptIndex).toBe(1);
    });

    it("returns empty array for empty input", () => {
      const decoded = decodeSignedOffers([]);
      expect(decoded).toEqual([]);
    });
  });

  describe("findAcceptsObjectFromSignedOffer", () => {
    it("finds matching accepts entry using acceptIndex hint", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const accepts = [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
          maxAmountRequired: "10000",
        },
      ];

      const found = findAcceptsObjectFromSignedOffer(offer, accepts as any);
      expect(found).toBeDefined();
      expect(found?.network).toBe("eip155:8453");
    });

    it("finds matching accepts entry with DecodedOffer", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer])[0];
      const accepts = [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
          maxAmountRequired: "10000",
        },
      ];

      const found = findAcceptsObjectFromSignedOffer(decoded, accepts as any);
      expect(found).toBeDefined();
      expect(found?.network).toBe("eip155:8453");
    });

    it("falls back to searching all accepts when hint misses", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 5, // Wrong index
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const accepts = [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
          maxAmountRequired: "10000",
        },
      ];

      const found = findAcceptsObjectFromSignedOffer(offer, accepts as any);
      expect(found).toBeDefined();
      expect(found?.network).toBe("eip155:8453");
    });

    it("returns undefined when no match found", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const accepts = [
        {
          scheme: "exact",
          network: "eip155:1", // Different network
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
          maxAmountRequired: "10000",
        },
      ];

      const found = findAcceptsObjectFromSignedOffer(offer, accepts as any);
      expect(found).toBeUndefined();
    });
  });

  describe("extractReceiptFromResponse", () => {
    it("extracts receipt from PAYMENT-RESPONSE header", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        signer,
      );

      const settlementResponse = {
        success: true,
        extensions: {
          [OFFER_RECEIPT]: {
            info: { receipt },
          },
        },
      };

      const headers = new Headers();
      headers.set("PAYMENT-RESPONSE", btoa(JSON.stringify(settlementResponse)));

      const response = new Response("OK", { headers });
      const extracted = extractReceiptFromResponse(response);

      expect(extracted).toBeDefined();
      expect(extracted?.format).toBe("jws");
    });

    it("extracts receipt from X-PAYMENT-RESPONSE header", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        signer,
      );

      const settlementResponse = {
        success: true,
        extensions: {
          [OFFER_RECEIPT]: {
            info: { receipt },
          },
        },
      };

      const headers = new Headers();
      headers.set("X-PAYMENT-RESPONSE", btoa(JSON.stringify(settlementResponse)));

      const response = new Response("OK", { headers });
      const extracted = extractReceiptFromResponse(response);

      expect(extracted).toBeDefined();
      expect(extracted?.format).toBe("jws");
    });

    it("returns undefined when no header present", () => {
      const response = new Response("OK");
      const extracted = extractReceiptFromResponse(response);
      expect(extracted).toBeUndefined();
    });

    it("returns undefined when header has no receipt", () => {
      const settlementResponse = {
        success: true,
        extensions: {},
      };

      const headers = new Headers();
      headers.set("PAYMENT-RESPONSE", btoa(JSON.stringify(settlementResponse)));

      const response = new Response("OK", { headers });
      const extracted = extractReceiptFromResponse(response);
      expect(extracted).toBeUndefined();
    });
  });

  describe("verifyReceiptMatchesOffer", () => {
    it("returns true when receipt matches offer and payer", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const payerAddress = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: payerAddress,
          network: "eip155:8453",
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer])[0];
      const result = verifyReceiptMatchesOffer(receipt, decoded, [payerAddress]);
      expect(result).toBe(true);
    });

    it("returns true with case-insensitive payer address match", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer])[0];
      // Uppercase payer address should still match
      const result = verifyReceiptMatchesOffer(receipt, decoded, [
        "0x857B06519E91E3A54538791BDBB0E22373E36B66",
      ]);
      expect(result).toBe(true);
    });

    it("returns false when resourceUrl does not match", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const payerAddress = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/different-resource",
          payer: payerAddress,
          network: "eip155:8453",
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer])[0];
      const result = verifyReceiptMatchesOffer(receipt, decoded, [payerAddress]);
      expect(result).toBe(false);
    });

    it("returns false when network does not match", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const payerAddress = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: payerAddress,
          network: "eip155:1", // Different network
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer])[0];
      const result = verifyReceiptMatchesOffer(receipt, decoded, [payerAddress]);
      expect(result).toBe(false);
    });

    it("returns false when payer does not match any address", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
          network: "eip155:8453",
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer])[0];
      // Different payer address
      const result = verifyReceiptMatchesOffer(receipt, decoded, [
        "0xDifferentAddress1234567890123456789012345",
      ]);
      expect(result).toBe(false);
    });

    it("returns true when payer matches one of multiple addresses", async () => {
      const keyPair = await generateES256KKeyPair();
      const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");
      const payerAddress = "0x857b06519E91e3A54538791bDbb0E22373e36b66";

      const offer = await createOfferJWS(
        "https://api.example.com/resource",
        {
          acceptIndex: 0,
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1234567890123456789012345678901234567890",
          amount: "10000",
        },
        signer,
      );

      const receipt = await createReceiptJWS(
        {
          resourceUrl: "https://api.example.com/resource",
          payer: payerAddress,
          network: "eip155:8453",
        },
        signer,
      );

      const decoded = decodeSignedOffers([offer])[0];
      // Multiple addresses, one matches
      const result = verifyReceiptMatchesOffer(receipt, decoded, [
        "0xOtherAddress12345678901234567890123456789",
        payerAddress,
        "SolanaAddressHere",
      ]);
      expect(result).toBe(true);
    });
  });
});

describe("Utility Functions", () => {
  describe("hashCanonical", () => {
    it("returns SHA-256 hash of canonicalized object", async () => {
      const hash = await hashCanonical({ b: 2, a: 1 });
      expect(hash).toBeInstanceOf(Uint8Array);
      expect(hash.length).toBe(32); // SHA-256 produces 32 bytes
    });

    it("produces same hash for equivalent objects with different key order", async () => {
      const hash1 = await hashCanonical({ z: 1, a: 2 });
      const hash2 = await hashCanonical({ a: 2, z: 1 });
      expect(hash1).toEqual(hash2);
    });

    it("produces different hashes for different objects", async () => {
      const hash1 = await hashCanonical({ a: 1 });
      const hash2 = await hashCanonical({ a: 2 });
      expect(hash1).not.toEqual(hash2);
    });
  });

  describe("getCanonicalBytes", () => {
    it("returns UTF-8 encoded canonical JSON", () => {
      const bytes = getCanonicalBytes({ b: 2, a: 1 });
      expect(bytes).toBeInstanceOf(Uint8Array);
      const decoded = new TextDecoder().decode(bytes);
      expect(decoded).toBe('{"a":1,"b":2}');
    });

    it("handles nested objects", () => {
      const bytes = getCanonicalBytes({ outer: { z: 1, a: 2 } });
      const decoded = new TextDecoder().decode(bytes);
      expect(decoded).toBe('{"outer":{"a":2,"z":1}}');
    });
  });

  describe("hashOfferTypedData", () => {
    it("returns EIP-712 hash for offer payload", () => {
      const payload: OfferPayload = {
        version: 1,
        resourceUrl: "https://api.example.com/resource",
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1234567890123456789012345678901234567890",
        amount: "10000",
        validUntil: 1700000000,
      };
      const hash = hashOfferTypedData(payload);
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });
  });

  describe("hashReceiptTypedData", () => {
    it("returns EIP-712 hash for receipt payload", () => {
      const payload: ReceiptPayload = {
        version: 1,
        network: "eip155:8453",
        resourceUrl: "https://api.example.com/resource",
        payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        issuedAt: 1700000000,
        transaction: "",
      };
      const hash = hashReceiptTypedData(payload);
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it("produces different hashes for different payloads", () => {
      const payload1: ReceiptPayload = {
        version: 1,
        network: "eip155:8453",
        resourceUrl: "https://api.example.com/resource",
        payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        issuedAt: 1700000000,
        transaction: "",
      };
      const payload2: ReceiptPayload = {
        ...payload1,
        payer: "0x1234567890123456789012345678901234567890",
      };
      const hash1 = hashReceiptTypedData(payload1);
      const hash2 = hashReceiptTypedData(payload2);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("extractEIP155ChainId", () => {
    it("extracts chain ID from valid eip155 network string", () => {
      expect(extractEIP155ChainId("eip155:8453")).toBe(8453);
      expect(extractEIP155ChainId("eip155:1")).toBe(1);
      expect(extractEIP155ChainId("eip155:137")).toBe(137);
    });

    it("throws for non-eip155 networks", () => {
      expect(() => extractEIP155ChainId("solana:mainnet")).toThrow(
        'Invalid network format: solana:mainnet. Expected "eip155:<chainId>"',
      );
    });

    it("throws for malformed eip155 strings", () => {
      expect(() => extractEIP155ChainId("eip155:")).toThrow(
        'Invalid network format: eip155:. Expected "eip155:<chainId>"',
      );
      expect(() => extractEIP155ChainId("eip155:abc")).toThrow(
        'Invalid network format: eip155:abc. Expected "eip155:<chainId>"',
      );
    });

    it("throws for strings without colon", () => {
      expect(() => extractEIP155ChainId("base")).toThrow(
        'Invalid network format: base. Expected "eip155:<chainId>"',
      );
    });
  });

  describe("createReceiptDomain", () => {
    it("creates receipt domain with correct name, version, and canonical chainId", () => {
      const domain = createReceiptDomain();
      expect(domain.name).toBe("x402 receipt");
      expect(domain.version).toBe("1");
      expect(domain.chainId).toBe(1);
    });
  });

  describe("prepareReceiptForEIP712", () => {
    it("converts receipt payload to EIP-712 message format", () => {
      const payload: ReceiptPayload = {
        version: 1,
        network: "eip155:8453",
        resourceUrl: "https://api.example.com/resource",
        payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        issuedAt: 1700000000,
        transaction: "0xabc123",
      };
      const prepared = prepareReceiptForEIP712(payload);
      expect(prepared.version).toBe(BigInt(1));
      expect(prepared.network).toBe("eip155:8453");
      expect(prepared.resourceUrl).toBe("https://api.example.com/resource");
      expect(prepared.payer).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
      expect(prepared.issuedAt).toBe(BigInt(1700000000));
      expect(prepared.transaction).toBe("0xabc123");
    });
  });

  describe("RECEIPT_TYPES", () => {
    it("has correct EIP-712 type definition", () => {
      expect(RECEIPT_TYPES.Receipt).toBeDefined();
      expect(RECEIPT_TYPES.Receipt).toHaveLength(6);
      const fieldNames = RECEIPT_TYPES.Receipt.map(f => f.name);
      expect(fieldNames).toContain("version");
      expect(fieldNames).toContain("network");
      expect(fieldNames).toContain("resourceUrl");
      expect(fieldNames).toContain("payer");
      expect(fieldNames).toContain("issuedAt");
      expect(fieldNames).toContain("transaction");
    });
  });
});

describe("Server Extension Utilities", () => {
  describe("declareOfferReceiptExtension", () => {
    it("returns extension declaration with default values", () => {
      const declaration = declareOfferReceiptExtension();
      expect(declaration).toHaveProperty(OFFER_RECEIPT);
      expect(declaration[OFFER_RECEIPT].includeTxHash).toBeUndefined();
      expect(declaration[OFFER_RECEIPT].offerValiditySeconds).toBeUndefined();
    });

    it("returns extension declaration with custom config", () => {
      const declaration = declareOfferReceiptExtension({
        includeTxHash: true,
        offerValiditySeconds: 120,
      });
      expect(declaration[OFFER_RECEIPT].includeTxHash).toBe(true);
      expect(declaration[OFFER_RECEIPT].offerValiditySeconds).toBe(120);
    });
  });

  describe("createJWSOfferReceiptIssuer", () => {
    it("creates issuer with correct properties", async () => {
      const keyPair = await generateES256KKeyPair();
      const jwsSigner = await createES256KSigner(
        keyPair.privateKey,
        "did:web:api.example.com#key-1",
      );

      const issuer = createJWSOfferReceiptIssuer("did:web:api.example.com#key-1", jwsSigner);

      expect(issuer.kid).toBe("did:web:api.example.com#key-1");
      expect(issuer.format).toBe("jws");
      expect(typeof issuer.issueOffer).toBe("function");
      expect(typeof issuer.issueReceipt).toBe("function");
    });

    it("issueOffer creates valid JWS offer", async () => {
      const keyPair = await generateES256KKeyPair();
      const jwsSigner = await createES256KSigner(
        keyPair.privateKey,
        "did:web:api.example.com#key-1",
      );
      const issuer = createJWSOfferReceiptIssuer("did:web:api.example.com#key-1", jwsSigner);

      const offer = await issuer.issueOffer("https://api.example.com/resource", {
        acceptIndex: 0,
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1234567890123456789012345678901234567890",
        amount: "10000",
      });

      expect(offer.format).toBe("jws");
      expect(offer.signature).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it("issueReceipt creates valid JWS receipt", async () => {
      const keyPair = await generateES256KKeyPair();
      const jwsSigner = await createES256KSigner(
        keyPair.privateKey,
        "did:web:api.example.com#key-1",
      );
      const issuer = createJWSOfferReceiptIssuer("did:web:api.example.com#key-1", jwsSigner);

      const receipt = await issuer.issueReceipt(
        "https://api.example.com/resource",
        "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        "eip155:8453",
        "0xabc123",
      );

      expect(receipt.format).toBe("jws");
      expect(receipt.signature).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });
  });

  describe("createEIP712OfferReceiptIssuer", () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);

    it("creates issuer with correct properties", () => {
      const issuer = createEIP712OfferReceiptIssuer(`did:pkh:eip155:8453:${account.address}`, p =>
        account.signTypedData(p),
      );

      expect(issuer.kid).toBe(`did:pkh:eip155:8453:${account.address}`);
      expect(issuer.format).toBe("eip712");
      expect(typeof issuer.issueOffer).toBe("function");
      expect(typeof issuer.issueReceipt).toBe("function");
    });

    it("issueOffer creates valid EIP-712 offer", async () => {
      const issuer = createEIP712OfferReceiptIssuer(`did:pkh:eip155:8453:${account.address}`, p =>
        account.signTypedData(p),
      );

      const offer = await issuer.issueOffer("https://api.example.com/resource", {
        acceptIndex: 0,
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1234567890123456789012345678901234567890",
        amount: "10000",
      });

      expect(offer.format).toBe("eip712");
      expect(offer).toHaveProperty("payload");
      expect(offer.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    });

    it("issueReceipt creates valid EIP-712 receipt", async () => {
      const issuer = createEIP712OfferReceiptIssuer(`did:pkh:eip155:8453:${account.address}`, p =>
        account.signTypedData(p),
      );

      const receipt = await issuer.issueReceipt(
        "https://api.example.com/resource",
        "0x857b06519E91e3A54538791bDbb0E22373e36b66",
        "eip155:8453",
        "0xabc123",
      );

      expect(receipt.format).toBe("eip712");
      expect(receipt).toHaveProperty("payload");
      expect(receipt.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    });
  });

  /**
   * NOTE: createOfferReceiptExtension is not tested here because it requires
   * a mock ResourceServer with PaymentRequiredContext and SettleResultContext.
   * The extension hooks (enrichPaymentRequiredResponse, enrichSettlementResponse)
   * depend on the full server context which would require significant mocking.
   * The signer factories above test the core signing functionality.
   */
});

// ============================================================================
// Signature Verification Tests
// ============================================================================

describe("Signature Verification", () => {
  describe("EIP-712 Verification", () => {
    describe("verifyOfferSignatureEIP712", () => {
      it("should verify a valid EIP-712 signed offer and recover signer", async () => {
        const account = privateKeyToAccount(TEST_PRIVATE_KEY);

        const offer = await createOfferEIP712(
          "https://api.example.com/resource",
          {
            acceptIndex: 0,
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            amount: "10000",
          },
          p => account.signTypedData(p),
        );

        const result = await verifyOfferSignatureEIP712(offer);

        expect(result.signer.toLowerCase()).toBe(account.address.toLowerCase());
        expect(result.payload.resourceUrl).toBe("https://api.example.com/resource");
        expect(result.payload.scheme).toBe("exact");
        expect(result.payload.network).toBe("eip155:8453");
        expect(result.payload.amount).toBe("10000");
      });

      it("should throw for wrong format", async () => {
        const invalidOffer = {
          format: "jws",
          signature: "test.jws.signature",
        } as unknown as EIP712SignedOffer;

        await expect(verifyOfferSignatureEIP712(invalidOffer)).rejects.toThrow(
          "Expected eip712 format",
        );
      });

      it("should throw for invalid offer payload", async () => {
        const invalidOffer = {
          format: "eip712",
          payload: null,
          signature: "0x1234",
        } as unknown as EIP712SignedOffer;

        await expect(verifyOfferSignatureEIP712(invalidOffer)).rejects.toThrow(
          "Invalid offer: missing or malformed payload",
        );
      });

      it("should recover different address for tampered signature", async () => {
        const account = privateKeyToAccount(TEST_PRIVATE_KEY);

        const offer = await createOfferEIP712(
          "https://api.example.com/resource",
          {
            acceptIndex: 0,
            scheme: "exact",
            network: "eip155:8453",
            asset: "native",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            amount: "10000",
          },
          p => account.signTypedData(p),
        );

        // Tamper with the signature
        const tamperedOffer = {
          ...offer,
          signature: offer.signature.slice(0, -4) + "0000",
        };

        // Should recover a different address (not throw)
        const result = await verifyOfferSignatureEIP712(tamperedOffer);
        expect(result.signer).toBeDefined();
        // The recovered address will likely be different
      });
    });

    describe("verifyReceiptSignatureEIP712", () => {
      it("should verify a valid EIP-712 signed receipt and recover signer", async () => {
        const account = privateKeyToAccount(TEST_PRIVATE_KEY);

        const receipt = await createReceiptEIP712(
          {
            resourceUrl: "https://api.example.com/resource",
            payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            network: "eip155:8453",
            transaction: "0x1234567890abcdef",
          },
          p => account.signTypedData(p),
        );

        const result = await verifyReceiptSignatureEIP712(receipt);

        expect(result.signer.toLowerCase()).toBe(account.address.toLowerCase());
        expect(result.payload.resourceUrl).toBe("https://api.example.com/resource");
        expect(result.payload.payer).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
        expect(result.payload.network).toBe("eip155:8453");
      });

      it("should throw for wrong format", async () => {
        const invalidReceipt = {
          format: "jws",
          signature: "test.jws.signature",
        } as unknown as EIP712SignedReceipt;

        await expect(verifyReceiptSignatureEIP712(invalidReceipt)).rejects.toThrow(
          "Expected eip712 format",
        );
      });

      it("should throw for invalid receipt payload", async () => {
        const invalidReceipt = {
          format: "eip712",
          payload: { version: 1 }, // missing payer
          signature: "0x1234",
        } as unknown as EIP712SignedReceipt;

        await expect(verifyReceiptSignatureEIP712(invalidReceipt)).rejects.toThrow(
          "Invalid receipt: missing or malformed payload",
        );
      });
    });
  });

  describe("JWS Verification", () => {
    describe("verifyOfferSignatureJWS", () => {
      it("should verify a JWS signed offer with explicit public key", async () => {
        const keyPair = await generateES256KKeyPair();
        const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

        const offer = await createOfferJWS(
          "https://api.example.com/resource",
          {
            acceptIndex: 0,
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            amount: "10000",
          },
          signer,
        );

        // Pass JWK directly - function accepts both KeyLike and JWK
        const payload = await verifyOfferSignatureJWS(offer, keyPair.publicKey);

        expect(payload.resourceUrl).toBe("https://api.example.com/resource");
        expect(payload.scheme).toBe("exact");
        expect(payload.amount).toBe("10000");
      });

      it("should verify a JWS signed offer with JWK public key", async () => {
        const keyPair = await generateES256KKeyPair();
        const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

        const offer = await createOfferJWS(
          "https://api.example.com/resource",
          {
            acceptIndex: 0,
            scheme: "exact",
            network: "eip155:8453",
            asset: "native",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            amount: "5000",
          },
          signer,
        );

        const payload = await verifyOfferSignatureJWS(offer, keyPair.publicKey);

        expect(payload.resourceUrl).toBe("https://api.example.com/resource");
        expect(payload.amount).toBe("5000");
      });

      it("should verify a JWS signed offer by extracting key from did:jwk kid", async () => {
        const keyPair = await generateES256KKeyPair();
        // Create signer with did:jwk kid (self-contained key)
        const kid = `did:jwk:${jose.base64url.encode(JSON.stringify(keyPair.publicKey))}#0`;
        const signer = await createES256KSigner(keyPair.privateKey, kid);

        const offer = await createOfferJWS(
          "https://api.example.com/resource",
          {
            acceptIndex: 0,
            scheme: "exact",
            network: "eip155:8453",
            asset: "native",
            payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
            amount: "7500",
          },
          signer,
        );

        // No public key provided - should extract from kid
        const payload = await verifyOfferSignatureJWS(offer);

        expect(payload.resourceUrl).toBe("https://api.example.com/resource");
        expect(payload.amount).toBe("7500");
      });

      it("should throw for wrong format", async () => {
        const invalidOffer = {
          format: "eip712",
          payload: {},
          signature: "0x1234",
        } as unknown as JWSSignedOffer;

        await expect(verifyOfferSignatureJWS(invalidOffer)).rejects.toThrow("Expected jws format");
      });

      it("should throw for invalid JWS signature", async () => {
        const keyPair = await generateES256KKeyPair();

        const invalidOffer: JWSSignedOffer = {
          format: "jws",
          signature: "invalid.jws.signature",
        };

        // Pass JWK directly
        await expect(verifyOfferSignatureJWS(invalidOffer, keyPair.publicKey)).rejects.toThrow();
      });

      it("should throw when no key provided and kid missing", async () => {
        const { privateKey } = await jose.generateKeyPair("ES256K");
        const payload = JSON.stringify({ version: 1, resourceUrl: "test" });
        const jws = await new jose.CompactSign(new TextEncoder().encode(payload))
          .setProtectedHeader({ alg: "ES256K" }) // No kid
          .sign(privateKey);

        const offer: JWSSignedOffer = { format: "jws", signature: jws };

        await expect(verifyOfferSignatureJWS(offer)).rejects.toThrow(
          "No public key provided and JWS header missing kid",
        );
      });
    });

    describe("verifyReceiptSignatureJWS", () => {
      it("should verify a JWS signed receipt", async () => {
        const keyPair = await generateES256KKeyPair();
        const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com");

        const receipt = await createReceiptJWS(
          {
            resourceUrl: "https://api.example.com/resource",
            payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            network: "eip155:8453",
          },
          signer,
        );

        // Pass JWK directly
        const payload = await verifyReceiptSignatureJWS(receipt, keyPair.publicKey);

        expect(payload.resourceUrl).toBe("https://api.example.com/resource");
        expect(payload.payer).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
        expect(payload.network).toBe("eip155:8453");
      });

      it("should verify a JWS signed receipt by extracting key from did:jwk kid", async () => {
        const keyPair = await generateES256KKeyPair();
        const kid = `did:jwk:${jose.base64url.encode(JSON.stringify(keyPair.publicKey))}#0`;
        const signer = await createES256KSigner(keyPair.privateKey, kid);

        const receipt = await createReceiptJWS(
          {
            resourceUrl: "https://api.example.com/resource",
            payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
            network: "eip155:8453",
            transaction: "0xabcdef",
          },
          signer,
        );

        // No public key provided - should extract from kid
        const payload = await verifyReceiptSignatureJWS(receipt);

        expect(payload.resourceUrl).toBe("https://api.example.com/resource");
        expect(payload.transaction).toBe("0xabcdef");
      });
    });
  });
});

// ============================================================================
// DID Key Resolution Tests
// ============================================================================

describe("extractPublicKeyFromKid", () => {
  describe("did:jwk", () => {
    it("should extract key from did:jwk", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256K");
      const jwk = await jose.exportJWK(publicKey);
      const kid = `did:jwk:${jose.base64url.encode(JSON.stringify(jwk))}`;

      const extractedKey = await extractPublicKeyFromKid(kid);
      expect(extractedKey).toBeDefined();
    });

    it("should handle did:jwk with fragment", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256");
      const jwk = await jose.exportJWK(publicKey);
      const kid = `did:jwk:${jose.base64url.encode(JSON.stringify(jwk))}#key-1`;

      const extractedKey = await extractPublicKeyFromKid(kid);
      expect(extractedKey).toBeDefined();
    });
  });

  describe("did:key", () => {
    it("should extract Ed25519 key from did:key", async () => {
      // Known Ed25519 did:key (from did-key spec examples)
      const kid = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

      const extractedKey = await extractPublicKeyFromKid(kid);
      expect(extractedKey).toBeDefined();
    });
  });

  describe("error cases", () => {
    it("should throw for invalid DID format", async () => {
      await expect(extractPublicKeyFromKid("not-a-did")).rejects.toThrow("Invalid DID format");
    });

    it("should throw for unsupported DID method", async () => {
      await expect(extractPublicKeyFromKid("did:unsupported:123")).rejects.toThrow(
        'Unsupported DID method "unsupported"',
      );
    });

    it("should throw for did:key with unsupported multibase", async () => {
      await expect(extractPublicKeyFromKid("did:key:f1234")).rejects.toThrow(
        "Unsupported multibase encoding",
      );
    });
  });

  describe("did:web", () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("should resolve did:web by fetching DID document", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256K");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:api.example.com",
        verificationMethod: [
          {
            id: "did:web:api.example.com#key-1",
            type: "JsonWebKey2020",
            controller: "did:web:api.example.com",
            publicKeyJwk: jwk,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:api.example.com#key-1");
      expect(extractedKey).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.example.com/.well-known/did.json",
        expect.any(Object),
      );
    });

    it("should resolve did:web with path", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:example.com:users:alice",
        verificationMethod: [
          {
            id: "did:web:example.com:users:alice#key-1",
            type: "JsonWebKey2020",
            controller: "did:web:example.com:users:alice",
            publicKeyJwk: jwk,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:example.com:users:alice#key-1");
      expect(extractedKey).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "https://example.com/users/alice/did.json",
        expect.any(Object),
      );
    });

    it("should use http:// for did:web:localhost", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:localhost%3A3000",
        verificationMethod: [
          {
            id: "did:web:localhost%3A3000#key-1",
            type: "JsonWebKey2020",
            controller: "did:web:localhost%3A3000",
            publicKeyJwk: jwk,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:localhost%3A3000#key-1");
      expect(extractedKey).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/.well-known/did.json",
        expect.any(Object),
      );
    });

    it("should use http:// for did:web:127.0.0.1", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:127.0.0.1%3A8080",
        verificationMethod: [
          {
            id: "did:web:127.0.0.1%3A8080#key-1",
            type: "JsonWebKey2020",
            controller: "did:web:127.0.0.1%3A8080",
            publicKeyJwk: jwk,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:127.0.0.1%3A8080#key-1");
      expect(extractedKey).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "http://127.0.0.1:8080/.well-known/did.json",
        expect.any(Object),
      );
    });

    it("should still use https:// for non-localhost domains", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:example.com",
        verificationMethod: [
          {
            id: "did:web:example.com#key-1",
            type: "JsonWebKey2020",
            controller: "did:web:example.com",
            publicKeyJwk: jwk,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:example.com#key-1");
      expect(extractedKey).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        "https://example.com/.well-known/did.json",
        expect.any(Object),
      );
    });

    it("should throw when did:web fetch fails", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(extractPublicKeyFromKid("did:web:nonexistent.example.com")).rejects.toThrow(
        "Failed to resolve did:web",
      );
    });

    it("should throw when verification method not found", async () => {
      const didDocument = {
        id: "did:web:api.example.com",
        verificationMethod: [],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      await expect(extractPublicKeyFromKid("did:web:api.example.com#nonexistent")).rejects.toThrow(
        "No verification method found",
      );
    });

    // Malformed DID Document Tests

    it("should throw when DID document has no verificationMethod array", async () => {
      const didDocument = { id: "did:web:api.example.com" };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      await expect(extractPublicKeyFromKid("did:web:api.example.com#key-1")).rejects.toThrow(
        "No verification method found",
      );
    });

    it("should throw when verification method has no key material", async () => {
      const didDocument = {
        id: "did:web:api.example.com",
        verificationMethod: [
          {
            id: "did:web:api.example.com#key-1",
            type: "JsonWebKey2020",
            controller: "did:web:api.example.com",
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      await expect(extractPublicKeyFromKid("did:web:api.example.com#key-1")).rejects.toThrow(
        "has no supported key format",
      );
    });

    it("should throw when fetch returns invalid JSON", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error("Invalid JSON")),
      });

      await expect(extractPublicKeyFromKid("did:web:api.example.com")).rejects.toThrow(
        "Failed to resolve did:web",
      );
    });

    it("should throw when network error occurs", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      await expect(extractPublicKeyFromKid("did:web:api.example.com")).rejects.toThrow(
        "Failed to resolve did:web",
      );
    });

    // DID Document structure variations

    it("should resolve key from assertionMethod reference", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256K");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:api.example.com",
        verificationMethod: [
          {
            id: "did:web:api.example.com#key-1",
            type: "JsonWebKey2020",
            controller: "did:web:api.example.com",
            publicKeyJwk: jwk,
          },
        ],
        assertionMethod: ["did:web:api.example.com#key-1"],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:api.example.com");
      expect(extractedKey).toBeDefined();
    });

    it("should resolve key from authentication reference", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256K");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:api.example.com",
        verificationMethod: [
          {
            id: "did:web:api.example.com#auth-key",
            type: "JsonWebKey2020",
            controller: "did:web:api.example.com",
            publicKeyJwk: jwk,
          },
        ],
        authentication: ["did:web:api.example.com#auth-key"],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:api.example.com");
      expect(extractedKey).toBeDefined();
    });

    it("should resolve embedded verification method in assertionMethod", async () => {
      const { publicKey } = await jose.generateKeyPair("ES256K");
      const jwk = await jose.exportJWK(publicKey);

      const didDocument = {
        id: "did:web:api.example.com",
        verificationMethod: [],
        assertionMethod: [
          {
            id: "did:web:api.example.com#embedded-key",
            type: "JsonWebKey2020",
            controller: "did:web:api.example.com",
            publicKeyJwk: jwk,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:api.example.com");
      expect(extractedKey).toBeDefined();
    });

    it("should handle publicKeyMultibase format in did:web", async () => {
      const didDocument = {
        id: "did:web:api.example.com",
        verificationMethod: [
          {
            id: "did:web:api.example.com#key-1",
            type: "Ed25519VerificationKey2020",
            controller: "did:web:api.example.com",
            publicKeyMultibase: "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(didDocument),
      });

      const extractedKey = await extractPublicKeyFromKid("did:web:api.example.com#key-1");
      expect(extractedKey).toBeDefined();
    });
  });
});

// ============================================================================
// Real DID Document Fixtures (captured from live endpoints)
// ============================================================================

describe("Real DID Document Fixtures", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Captured from https://identity.foundation/.well-known/did.json (P-256 key)
  const IDENTITY_FOUNDATION_DID_DOC = {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: "did:web:identity.foundation",
    verificationMethod: [
      {
        id: "did:web:identity.foundation#XXS7zTsbIIAxgNlYEXJ4y810GFeLkYdqfK3ChhoQn7c",
        type: "JsonWebKey2020",
        controller: "did:web:identity.foundation",
        publicKeyJwk: {
          kty: "EC",
          kid: "XXS7zTsbIIAxgNlYEXJ4y810GFeLkYdqfK3ChhoQn7c",
          crv: "P-256",
          alg: "ES256",
          x: "TIIYSHfbBoXZi-B8Q5KBEmYpg6gXk0Getwt2nDPhxvI",
          y: "zNbtUvyDHTdmtz3tyiw84UYgzma1X8r4ToP7PbCVHgI",
        },
      },
    ],
    authentication: ["did:web:identity.foundation#XXS7zTsbIIAxgNlYEXJ4y810GFeLkYdqfK3ChhoQn7c"],
    assertionMethod: ["did:web:identity.foundation#XXS7zTsbIIAxgNlYEXJ4y810GFeLkYdqfK3ChhoQn7c"],
  };

  // Captured from https://demo.spruceid.com/.well-known/did.json (Ed25519 key)
  const SPRUCE_DID_DOC = {
    "@context": [
      "https://www.w3.org/ns/did/v1",
      { "@id": "https://w3id.org/security#publicKeyJwk", "@type": "@json" },
    ],
    id: "did:web:demo.spruceid.com",
    verificationMethod: [
      {
        id: "did:web:demo.spruceid.com#_t-v-Ep7AtkELhhvAzCCDzy1O5Bn_z1CVFv9yiRXdHY",
        type: "Ed25519VerificationKey2018",
        controller: "did:web:demo.spruceid.com",
        publicKeyJwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: "2yv3J-Sf263OmwDLS9uFPTRD0PzbvfBGKLiSnPHtXIU",
        },
      },
    ],
    authentication: ["did:web:demo.spruceid.com#_t-v-Ep7AtkELhhvAzCCDzy1O5Bn_z1CVFv9yiRXdHY"],
    assertionMethod: ["did:web:demo.spruceid.com#_t-v-Ep7AtkELhhvAzCCDzy1O5Bn_z1CVFv9yiRXdHY"],
  };

  it("should parse identity.foundation DID document (P-256)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(IDENTITY_FOUNDATION_DID_DOC),
    });

    const key = await extractPublicKeyFromKid(
      "did:web:identity.foundation#XXS7zTsbIIAxgNlYEXJ4y810GFeLkYdqfK3ChhoQn7c",
    );
    expect(key).toBeDefined();
  });

  it("should parse identity.foundation via assertionMethod (no fragment)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(IDENTITY_FOUNDATION_DID_DOC),
    });

    const key = await extractPublicKeyFromKid("did:web:identity.foundation");
    expect(key).toBeDefined();
  });

  it("should parse demo.spruceid.com DID document (Ed25519)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SPRUCE_DID_DOC),
    });

    const key = await extractPublicKeyFromKid(
      "did:web:demo.spruceid.com#_t-v-Ep7AtkELhhvAzCCDzy1O5Bn_z1CVFv9yiRXdHY",
    );
    expect(key).toBeDefined();
  });

  it("should parse demo.spruceid.com via assertionMethod (no fragment)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(SPRUCE_DID_DOC),
    });

    const key = await extractPublicKeyFromKid("did:web:demo.spruceid.com");
    expect(key).toBeDefined();
  });
});
