import { Address, COSE } from "@evolution-sdk/evolution";
import LZString from "lz-string";
import { describe, expect, it } from "vitest";

import {
  MASUMI_BLUEPRINT_DIGEST,
  MASUMI_DEFAULT_DEPLOYMENT,
  masumiEscrowAddress,
  masumiEscrowScriptHash,
} from "../../src/exact/masumi/blueprint";
import { verifySellerTermsSignature } from "../../src/exact/masumi/cose";
import { commitmentPartDigest, computeInputHash } from "../../src/exact/masumi/digests";
import {
  buildIdentifierText,
  decodeBlockchainIdentifier,
  encodeBlockchainIdentifier,
} from "../../src/exact/masumi/identifier";
import { jcs } from "../../src/exact/masumi/jcs";
import { CARDANO_MAINNET_CAIP2, CARDANO_PREPROD_CAIP2 } from "../../src/constants";
import { MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES } from "../../src/limits";
import { freshKeyAddress } from "../helpers/masumi";

/** The escrow address both spec identifier vectors are built against. */
const SPEC_ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g";

describe("RFC 8785 JCS", () => {
  it("sorts object members by UTF-16 code units", () => {
    expect(jcs({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
  });

  it("is insensitive to insertion order", () => {
    expect(jcs({ z: [1, { y: 2, x: 3 }], a: null })).toBe(jcs({ a: null, z: [1, { x: 3, y: 2 }] }));
  });

  it("omits members whose value is undefined, but keeps null", () => {
    expect(jcs({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("preserves array order and serializes numbers in ECMAScript form", () => {
    expect(jcs([3, 1, 2])).toBe("[3,1,2]");
    expect(jcs({ n: 1e21, m: -0.5 })).toBe('{"m":-0.5,"n":1e+21}');
  });

  it("refuses values JSON cannot represent", () => {
    expect(() => jcs({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => jcs({ n: 1n })).toThrow(/bigint/);
  });

  // RFC 8785 requires canonicalization to fail on invalid Unicode. JSON.stringify
  // would instead escape it, producing a digest a conforming peer refuses to
  // compute — a silent disagreement on inputHash and termsDigest.
  it("refuses unpaired surrogates in values and member names", () => {
    expect(() => jcs({ a: "\ud800" })).toThrow(/unpaired surrogate/);
    expect(() => jcs({ a: "\udc00x" })).toThrow(/unpaired surrogate/);
    expect(() => jcs({ "\ud800": 1 })).toThrow(/unpaired surrogate/);
    expect(() => jcs(["ok", "\ud83d"])).toThrow(/unpaired surrogate/);
  });

  it("accepts a correctly paired surrogate", () => {
    expect(jcs({ a: "😀" })).toBe('{"a":"😀"}');
  });
});

// The spec fixes these two encoding-only vectors for the compatibility codec.
// The short key and signature values are deliberately not valid COSE objects.
describe("blockchainIdentifier codec (spec vectors)", () => {
  const vectors = [
    {
      name: "unregistered seller with an empty buyer nonce",
      parts: {
        sellerNonce: "11".repeat(32),
        agentIdentifier: "",
        buyerNonce: "",
        referenceSignature: "55".repeat(16),
        referenceKey: "a10101",
        contractAddress: SPEC_ESCROW,
      },
      text: `${"11".repeat(32)}..${"55".repeat(16)}.a10101.${SPEC_ESCROW}`,
      hex: "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80",
    },
    {
      name: "registered seller",
      parts: {
        sellerNonce: "22".repeat(32),
        agentIdentifier: `${"aa".repeat(28)}01`,
        buyerNonce: "01020304050607",
        referenceSignature: "66".repeat(16),
        referenceKey: "a10102",
        contractAddress: SPEC_ESCROW,
      },
      text: `${"22".repeat(32)}${"aa".repeat(28)}01.01020304050607.${"66".repeat(16)}.a10102.${SPEC_ESCROW}`,
      hex: "130d7c6574f4218314e4b56f46e00602300e972d82c0662c0162c0562c0362c0763d6975b7d8f3b6f3874381e004d0402700fa005c0298067093803b802f19e4a6d05018c02715001601ac154a5006d36680560bb405b4100dc0239611ae64073001eb494192e4700e000e121e70240066610076240c0ae41e400000",
    },
  ];

  for (const vector of vectors) {
    it(`builds the exact identifierText for the ${vector.name}`, () => {
      expect(buildIdentifierText(vector.parts)).toBe(vector.text);
    });

    it(`encodes the exact blockchainIdentifier for the ${vector.name}`, () => {
      expect(encodeBlockchainIdentifier(vector.parts)).toBe(vector.hex);
    });

    it(`decompresses the ${vector.name} back to every segment`, () => {
      expect(decodeBlockchainIdentifier(vector.hex)).toEqual(vector.parts);
    });
  }

  it("preserves an empty buyer-nonce segment", () => {
    expect(decodeBlockchainIdentifier(vectors[0].hex)?.buyerNonce).toBe("");
  });

  it("rejects malformed input", () => {
    expect(decodeBlockchainIdentifier("")).toBeNull();
    expect(decodeBlockchainIdentifier("zz")).toBeNull();
    expect(decodeBlockchainIdentifier("abc")).toBeNull();
  });
});

describe("blockchainIdentifier resource limits", () => {
  it("rejects compressed identifiers above the implementation budget", () => {
    expect(
      decodeBlockchainIdentifier("00".repeat(MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES + 1)),
    ).toBeNull();
  });

  it("aborts a compressed identifier whose expanded text exceeds the limit", () => {
    const compressed = LZString.compressToUint8Array("a".repeat(100_000));
    expect(compressed.length).toBeLessThan(MAX_MASUMI_IDENTIFIER_COMPRESSED_BYTES);
    expect(decodeBlockchainIdentifier(Buffer.from(compressed).toString("hex"))).toBeNull();
  });
});

describe("canonical vested_pay deployment", () => {
  it("pins the blueprint digest the spec names", () => {
    expect(MASUMI_BLUEPRINT_DIGEST).toBe(
      "6249de17bb87c5246106af6b0f33de22b44ca24b9c1445fa36d10eb8b583dec7",
    );
  });

  // The un-applied blueprint hash is NOT an escrow address; the parameters are
  // baked into the script hash. The applied preprod address is the one the
  // spec's identifier vectors are built against.
  it("derives the spec's escrow address by applying the default parameters", () => {
    expect(masumiEscrowAddress(CARDANO_PREPROD_CAIP2)).toBe(SPEC_ESCROW);
    expect(masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT)).toBe(
      "a15ce9d82d2f67645fc624e2edac03c6f1c106d0ad1af5815a3b14ad",
    );
  });

  it("keeps the same script hash across networks, changing only the header", () => {
    expect(masumiEscrowAddress(CARDANO_MAINNET_CAIP2)).toBe(
      "addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d",
    );
  });

  it("yields a different address for a different parameterization", () => {
    const custom = masumiEscrowScriptHash({
      ...MASUMI_DEFAULT_DEPLOYMENT,
      requiredAdmins: "3",
    });
    expect(custom).not.toBe(masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT));
  });

  it("treats a duplicated admin key as a distinct deployment", () => {
    const weighted = masumiEscrowScriptHash({
      requiredAdmins: "2",
      adminVkeys: [
        MASUMI_DEFAULT_DEPLOYMENT.adminVkeys[0],
        MASUMI_DEFAULT_DEPLOYMENT.adminVkeys[0],
        MASUMI_DEFAULT_DEPLOYMENT.adminVkeys[1],
      ],
      cooldownPeriod: "420000",
    });
    expect(weighted).not.toBe(masumiEscrowScriptHash(MASUMI_DEFAULT_DEPLOYMENT));
  });
});

describe("input commitment", () => {
  it("derives inputHash from the content-free manifest", () => {
    const part = {
      name: "body",
      canonicalization: "jcs" as const,
      mediaType: "application/json",
      content: { days: 3, units: "metric" },
    };
    const commitment = {
      version: "1",
      algorithm: "sha256",
      parts: [{ ...part, digest: commitmentPartDigest(part) }],
      digest: "",
    };
    const digest = computeInputHash(commitment);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // Omitting `content` on the wire must not change inputHash: the manifest
    // excludes it by construction.
    const withoutContent = {
      ...commitment,
      parts: commitment.parts.map(({ content: _content, ...rest }) => rest),
    };
    expect(computeInputHash(withoutContent)).toBe(digest);

    // A changed part digest DOES change inputHash.
    expect(
      computeInputHash({
        ...commitment,
        parts: commitment.parts.map(p => ({ ...p, digest: "0".repeat(64) })),
      }),
    ).not.toBe(digest);
  });

  it("digests a raw part from its base64url bytes", () => {
    // "hi" -> base64url "aGk"; SHA-256("hi") is the well-known value below.
    expect(commitmentPartDigest({ canonicalization: "raw", content: "aGk" })).toBe(
      "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    );
  });

  it("refuses base64url content that is not base64url", () => {
    expect(() => commitmentPartDigest({ canonicalization: "raw", content: "a+b/c=" })).toThrow(
      /base64url/,
    );
  });

  it("refuses non-canonical base64url encodings", () => {
    expect(() => commitmentPartDigest({ canonicalization: "raw", content: "a" })).toThrow(
      /canonical/,
    );
    expect(() => commitmentPartDigest({ canonicalization: "raw", content: "Zh" })).toThrow(
      /canonical/,
    );
  });
});

describe("seller COSE authorization", () => {
  const digest = "ab".repeat(32);

  /**
   * Signs a digest with a fresh key, returning the wire hex pair.
   *
   * @param payloadHex - The payload to sign.
   * @returns The seller address plus the COSE key/signature hex.
   */
  const sign = (payloadHex: string) => {
    const { privateKey, address } = freshKeyAddress(CARDANO_PREPROD_CAIP2);
    const signed = COSE.SignData.signData(
      Address.toHex(Address.fromBech32(address)),
      Uint8Array.from(Buffer.from(payloadHex, "hex")),
      privateKey,
    );
    return {
      address,
      key: Buffer.from(signed.key).toString("hex"),
      signature: Buffer.from(signed.signature).toString("hex"),
    };
  };

  it("accepts a CIP-30 signData result over the terms digest", () => {
    const { address, key, signature } = sign(digest);
    expect(verifySellerTermsSignature(key, signature, address, digest)).toBe(true);
  });

  it("rejects a signature over a different digest", () => {
    const { address, key, signature } = sign("cd".repeat(32));
    expect(verifySellerTermsSignature(key, signature, address, digest)).toBe(false);
  });

  it("rejects a signature bound to a different address", () => {
    const { key, signature } = sign(digest);
    const other = freshKeyAddress(CARDANO_PREPROD_CAIP2).address;
    expect(verifySellerTermsSignature(key, signature, other, digest)).toBe(false);
  });

  it("rejects a key swapped for another seller's", () => {
    const { address, signature } = sign(digest);
    const otherKey = sign(digest).key;
    expect(verifySellerTermsSignature(otherKey, signature, address, digest)).toBe(false);
  });

  it("rejects a COSE_Key carrying private material", () => {
    const { address, signature } = sign(digest);
    // a5 map(5): kty=OKP, alg=EdDSA, crv=Ed25519, x=<32>, d=<32>
    const tampered = `a5010103272006215820${"11".repeat(32)}235820${"22".repeat(32)}`;
    expect(verifySellerTermsSignature(tampered, signature, address, digest)).toBe(false);
  });

  it("rejects a malformed COSE pair rather than throwing", () => {
    const { address } = sign(digest);
    expect(verifySellerTermsSignature("a10101", "deadbeef", address, digest)).toBe(false);
    expect(verifySellerTermsSignature("zz", "zz", address, digest)).toBe(false);
  });
});
