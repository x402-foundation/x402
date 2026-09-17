/**
 * Tests for version-2 delivery-binding receipts (proof-of-delivery, §5.6)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import {
  createReceiptEIP712,
  createReceiptJWS,
  extractReceiptPayload,
  hashResponseBody,
  receiptTypesForVersion,
  RECEIPT_TYPES,
  RECEIPT_TYPES_V2,
  verifyReceiptSignatureEIP712,
  verifyReceiptSignatureJWS,
  type EIP712SignedReceipt,
  type JWSSignedReceipt,
} from "../src/offer-receipt";

import { createES256KSigner, generateES256KKeyPair } from "./offer-receipt-test-utils";

// anvil account #0
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const RESOURCE = "https://api.example.com/premium-data";
const NETWORK = "eip155:8453";
const BODY = { registered: true, name: "Karl Altmann Gesellschaft m.b.H.", country: "AT" };

describe("hashResponseBody (§5.6)", () => {
  it("defaults to jcs for JSON values and is stable under key reordering", async () => {
    const a = await hashResponseBody({ a: 1, b: 2 });
    const b = await hashResponseBody({ b: 2, a: 1 });
    expect(a.encoding).toBe("jcs");
    expect(a.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash); // JCS canonicalization is order-independent
  });

  it("defaults to raw for strings/bytes and detects any byte change", async () => {
    const s = await hashResponseBody("hello");
    const s2 = await hashResponseBody("hello ");
    expect(s.encoding).toBe("raw");
    expect(s.hash).not.toBe(s2.hash);
  });

  it("raw and jcs differ for the same JSON (whitespace-sensitive vs canonical)", async () => {
    const raw = await hashResponseBody('{"a": 1}', "raw");
    const jcs = await hashResponseBody({ a: 1 }, "jcs");
    expect(raw.hash).not.toBe(jcs.hash);
  });
});

describe("receiptTypesForVersion (§5.5)", () => {
  it("selects v1 types for version 1 and v2 types for version 2", () => {
    expect(receiptTypesForVersion(1)).toBe(RECEIPT_TYPES);
    expect(receiptTypesForVersion(2)).toBe(RECEIPT_TYPES_V2);
    expect(RECEIPT_TYPES_V2.Receipt.map(f => f.name)).toContain("responseHash");
  });
});

describe("EIP-712 delivery receipt (v2)", () => {
  it("issues a version-2 receipt bound to the response and recovers the signer", async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const receipt = (await createReceiptEIP712(
      { resourceUrl: RESOURCE, payer: account.address, network: NETWORK, response: { body: BODY } },
      p => account.signTypedData(p as any),
    )) as EIP712SignedReceipt;

    expect(receipt.payload.version).toBe(2);
    expect(receipt.payload.responseHashAlg).toBe("sha256");
    expect(receipt.payload.responseHashEncoding).toBe("jcs");
    expect(receipt.payload.responseHash).toMatch(/^0x[0-9a-f]{64}$/);

    const { signer, payload } = await verifyReceiptSignatureEIP712(receipt);
    expect(signer.toLowerCase()).toBe(account.address.toLowerCase());

    // Attested delivery: recompute the digest over the delivered body.
    const recomputed = await hashResponseBody(BODY, payload.responseHashEncoding as any);
    expect(recomputed.hash).toBe(payload.responseHash);
  });

  it("detects a tampered response body (digest no longer matches)", async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const receipt = (await createReceiptEIP712(
      { resourceUrl: RESOURCE, payer: account.address, network: NETWORK, response: { body: BODY } },
      p => account.signTypedData(p as any),
    )) as EIP712SignedReceipt;

    const tampered = { ...BODY, registered: false };
    const recomputed = await hashResponseBody(tampered, "jcs");
    expect(recomputed.hash).not.toBe(receipt.payload.responseHash);
  });

  it("keeps version-1 receipts unchanged when no response is bound", async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const receipt = (await createReceiptEIP712(
      { resourceUrl: RESOURCE, payer: account.address, network: NETWORK },
      p => account.signTypedData(p as any),
    )) as EIP712SignedReceipt;

    expect(receipt.payload.version).toBe(1);
    expect(receipt.payload.responseHash).toBeUndefined();
    const { signer } = await verifyReceiptSignatureEIP712(receipt);
    expect(signer.toLowerCase()).toBe(account.address.toLowerCase());
  });
});

describe("JWS delivery receipt (v2)", () => {
  it("carries the delivery-binding fields through a JWS roundtrip", async () => {
    const keyPair = await generateES256KKeyPair();
    const signer = await createES256KSigner(keyPair.privateKey, "did:web:example.com#key-1");
    const receipt = (await createReceiptJWS(
      { resourceUrl: RESOURCE, payer: "0xabc", network: NETWORK, response: { body: BODY } },
      signer,
    )) as JWSSignedReceipt;

    const payload = extractReceiptPayload(receipt);
    expect(payload.version).toBe(2);
    expect(payload.responseHashEncoding).toBe("jcs");

    const verified = await verifyReceiptSignatureJWS(receipt, keyPair.publicKey);
    expect(verified.responseHash).toBe(payload.responseHash);

    const recomputed = await hashResponseBody(BODY, "jcs");
    expect(verified.responseHash).toBe(recomputed.hash);
  });
});
