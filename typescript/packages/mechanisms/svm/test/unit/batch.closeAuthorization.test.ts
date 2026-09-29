import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import {
  encodeCloseAuthorizationDigest,
  signCloseAuthorization,
  verifyCloseAuthorization,
} from "../../src/batch-settlement/closeAuthorization";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

let authorizer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let other: Awaited<ReturnType<typeof generateKeyPairSigner>>;

const NOW = 1_800_000_000;

beforeAll(async () => {
  authorizer = await generateKeyPairSigner();
  other = await generateKeyPairSigner();
});

function binding(validBefore = NOW + 120) {
  return {
    channelId: USDC_MAINNET_ADDRESS,
    feePayer: USDC_DEVNET_ADDRESS,
    maxClaimableAmount: 5_000n,
    network: SOLANA_DEVNET_CAIP2,
    validBefore,
    voucherExpiresAt: 0n,
  };
}

describe("batch-settlement close authorization", () => {
  it("hashes the domain-separated message to 32 bytes and binds every field", () => {
    const base = encodeCloseAuthorizationDigest(binding());
    expect(base.byteLength).toBe(32);
    const variants = [
      { ...binding(), channelId: USDC_DEVNET_ADDRESS },
      { ...binding(), feePayer: USDC_MAINNET_ADDRESS },
      { ...binding(), maxClaimableAmount: 5_001n },
      { ...binding(), voucherExpiresAt: 1n },
      { ...binding(), validBefore: NOW + 121 },
      { ...binding(), network: "solana:other" },
    ];
    for (const variant of variants) {
      expect(encodeCloseAuthorizationDigest(variant)).not.toEqual(base);
    }
  });

  it("rejects malformed bindings", () => {
    expect(() => encodeCloseAuthorizationDigest({ ...binding(), channelId: "short" })).toThrow(
      /32 bytes/,
    );
    expect(() => encodeCloseAuthorizationDigest({ ...binding(), validBefore: 0 })).toThrow(
      /validBefore/,
    );
    expect(() => encodeCloseAuthorizationDigest({ ...binding(), maxClaimableAmount: -1n })).toThrow(
      /u64/,
    );
  });

  it("signs and verifies within the validity window only", async () => {
    const authorization = await signCloseAuthorization(authorizer, binding());
    const { validBefore: _omitted, ...fields } = binding();
    void _omitted;
    expect(authorization.validBefore).toBe(NOW + 120);
    await expect(
      verifyCloseAuthorization(authorization, fields, authorizer.address, 300, NOW),
    ).resolves.toBe(true);
    // Signed by someone other than the trusted receiver authorizer.
    await expect(
      verifyCloseAuthorization(authorization, fields, other.address, 300, NOW),
    ).resolves.toBe(false);
    // Bound to a different final voucher.
    await expect(
      verifyCloseAuthorization(
        authorization,
        { ...fields, maxClaimableAmount: 4_999n },
        authorizer.address,
        300,
        NOW,
      ),
    ).resolves.toBe(false);
    // Expired, and further out than maxTimeoutSeconds allows.
    await expect(
      verifyCloseAuthorization(authorization, fields, authorizer.address, 300, NOW + 120),
    ).resolves.toBe(false);
    await expect(
      verifyCloseAuthorization(authorization, fields, authorizer.address, 60, NOW),
    ).resolves.toBe(false);
    // Garbage signature never throws.
    await expect(
      verifyCloseAuthorization(
        { ...authorization, signature: "nope" },
        fields,
        authorizer.address,
        300,
        NOW,
      ),
    ).resolves.toBe(false);
  });
});
