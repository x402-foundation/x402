/**
 * Concrete signer crypto, on a real MainNet prepared-transaction fixture.
 *
 * Exercises the hard part end-to-end and OFFLINE (no participant): the client
 * signer recomputes the Canton hash from the exact prepared bytes with the
 * official `@canton-network/core-tx-visualizer` and Ed25519-signs it; the
 * facilitator payer-proof recomputes the SAME hash and verifies that signature
 * against the payer's topology key. Tamper cases (bad signature, wrong claimed
 * hash, wrong scheme, no key) all refuse.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { toClientCantonSigner } from "../../src/signer-factory.js";
import { recomputeHash } from "../../src/ledger/canton-hash.js";
import { createPayerProofVerifier, rawEd25519ToDerSpki } from "../../src/ledger/payer-proof.js";

const FIX = fileURLToPath(new URL("../../src/__fixtures__/", import.meta.url));
const CC_RAW = readFileSync(FIX + "mainnet-transfer-preapproval-0.1.21.b64", "utf8").trim();

const V2 = "HASHING_SCHEME_VERSION_V2";

/** A fresh Ed25519 party: PKCS8 PEM for signing, raw 32-byte point for verify. */
function newParty() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rawPub = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { privateKeyPem, rawPub: Buffer.from(rawPub) };
}

// A client signer needs no live participant to SIGN — prepareTransfer talks to
// the ledger, but signPrepared only hashes + signs the bytes it is handed.
function clientSigner(privateKeyPem: string, party: string) {
  return toClientCantonSigner({
    participantUrl: "http://unused.invalid",
    token: "unused",
    userId: "unused",
    synchronizerId: "global-domain::1220test",
    scanUrl: "http://unused.invalid",
    party,
    privateKeyPem,
  });
}

describe("toClientCantonSigner.signPrepared", () => {
  it("recomputes the hash FROM the exact bytes with the official hasher", async () => {
    const { privateKeyPem } = newParty();
    const party = "agent::1220" + "aa".repeat(32);
    const signed = await clientSigner(privateKeyPem, party).signPrepared(CC_RAW);

    const expectedHex = Buffer.from(await recomputeHash(CC_RAW), "base64").toString("hex");
    expect(signed.preparedTxHashHex).toBe(expectedHex);
    expect(signed.hashingSchemeVersion).toBe(V2);
    expect(Buffer.from(signed.signatureB64, "base64").length).toBe(64);
  });
});

describe("client sign → facilitator verify round-trip (real hashing + Ed25519)", () => {
  it("verifies a signature the client produced over the real fixture", async () => {
    const { privateKeyPem, rawPub } = newParty();
    const party = "agent::1220" + "bb".repeat(32);
    const signed = await clientSigner(privateKeyPem, party).signPrepared(CC_RAW);

    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [rawEd25519ToDerSpki(rawPub)],
    });
    const res = await verify({
      preparedTransactionBytes: Buffer.from(CC_RAW, "base64"),
      claimedPreparedTxHash: signed.preparedTxHashHex,
      signatureB64: signed.signatureB64,
      payer: party,
      hashingSchemeVersion: V2,
    });
    expect(res.verified).toBe(true);
    expect(res.preparedTxHashHex).toBe(signed.preparedTxHashHex);
    expect(res.publishedProtocolKeys).toBe(1);
  });

  it("refuses a tampered signature", async () => {
    const { privateKeyPem, rawPub } = newParty();
    const party = "agent::1220" + "cc".repeat(32);
    const signed = await clientSigner(privateKeyPem, party).signPrepared(CC_RAW);

    const bad = Buffer.from(signed.signatureB64, "base64");
    bad[0] ^= 0xff;
    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [rawEd25519ToDerSpki(rawPub)],
    });
    const res = await verify({
      preparedTransactionBytes: Buffer.from(CC_RAW, "base64"),
      claimedPreparedTxHash: signed.preparedTxHashHex,
      signatureB64: bad.toString("base64"),
      payer: party,
      hashingSchemeVersion: V2,
    });
    expect(res.verified).toBe(false);
  });

  it("refuses when the claimed hash is not the hash of the bytes", async () => {
    const { privateKeyPem, rawPub } = newParty();
    const party = "agent::1220" + "dd".repeat(32);
    const signed = await clientSigner(privateKeyPem, party).signPrepared(CC_RAW);

    const verify = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [rawEd25519ToDerSpki(rawPub)],
    });
    const res = await verify({
      preparedTransactionBytes: Buffer.from(CC_RAW, "base64"),
      claimedPreparedTxHash: "ab".repeat(32), // not the real hash
      signatureB64: signed.signatureB64,
      payer: party,
      hashingSchemeVersion: V2,
    });
    expect(res.verified).toBe(false);
  });

  it("refuses an unknown hashing scheme and a missing key", async () => {
    const { privateKeyPem, rawPub } = newParty();
    const party = "agent::1220" + "ee".repeat(32);
    const signed = await clientSigner(privateKeyPem, party).signPrepared(CC_RAW);

    const withKey = createPayerProofVerifier({
      fetchPayerSigningKey: async () => [rawEd25519ToDerSpki(rawPub)],
    });
    const wrongScheme = await withKey({
      preparedTransactionBytes: Buffer.from(CC_RAW, "base64"),
      claimedPreparedTxHash: signed.preparedTxHashHex,
      signatureB64: signed.signatureB64,
      payer: party,
      hashingSchemeVersion: "HASHING_SCHEME_VERSION_V1",
    });
    expect(wrongScheme.verified).toBe(false);

    const noKey = createPayerProofVerifier({ fetchPayerSigningKey: async () => [] });
    const missing = await noKey({
      preparedTransactionBytes: Buffer.from(CC_RAW, "base64"),
      claimedPreparedTxHash: signed.preparedTxHashHex,
      signatureB64: signed.signatureB64,
      payer: party,
      hashingSchemeVersion: V2,
    });
    expect(missing.verified).toBe(false);
  });
});
