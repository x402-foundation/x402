/**
 * Transaction message version negotiation.
 *
 * Facilitators advertise the versions they accept in `/supported`
 * (`extra.transactionVersions`), servers copy the list into the challenge,
 * clients build one of the advertised versions, and every verifier rejects
 * any other version before inspecting signatures or instructions.
 *
 * The verifier gates are exercised with genuine transaction-v1 and legacy
 * wire payloads, which `@solana/kit` >= 8 decodes.
 */
import { fetchMint } from "@solana-program/token-2022";
import {
  generateKeyPairSigner,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { PaymentPayloadV1, PaymentRequirementsV1 } from "@x402/core/types/v1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCEPTED_TRANSACTION_VERSIONS,
  ADVERTISED_TRANSACTION_VERSIONS,
  SOLANA_DEVNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { ExactSvmScheme as ExactSvmClientScheme } from "../../src/exact/client/scheme";
import * as Errors from "../../src/exact/facilitator/errors";
import { ExactSvmScheme as ExactSvmFacilitatorScheme } from "../../src/exact/facilitator/scheme";
import {
  assertFeePayerIsolated,
  validateComputeBudgetLimits,
} from "../../src/exact/facilitator/smartWalletVerification";
import { ExactSvmSchemeV1 } from "../../src/exact/v1/facilitator/scheme";
import { SettlementCache } from "../../src/settlement-cache";
import type { FacilitatorSvmSigner } from "../../src/signer";
import {
  decodeTransactionFromPayload,
  isAcceptedTransactionVersion,
  resolveTransactionVersion,
  selectHighestMutuallySupportedTransactionVersion,
  transactionMessageHash,
} from "../../src/utils";
import {
  buildExactPaymentTransaction,
  buildVersion1WireTransaction,
} from "./helpers/signedTransaction";

vi.mock("@solana-program/token-2022", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana-program/token-2022")>();
  return { ...actual, fetchMint: vi.fn() };
});

/** Facilitator fee payer; a real keypair so the address encodes to 32 bytes. */
let FEE_PAYER: string;
beforeAll(async () => {
  FEE_PAYER = (await generateKeyPairSigner()).address;
});
const PROVIDED_BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k";

function facilitatorSigner(): FacilitatorSvmSigner {
  return {
    address: FEE_PAYER as never,
    getAddresses: vi.fn().mockReturnValue([FEE_PAYER]) as never,
    getSigner: vi.fn() as never,
    signTransactions: vi.fn() as never,
    signMessages: vi.fn() as never,
    getRpcForNetwork: vi.fn() as never,
  };
}

function wireVersion(transactionBase64: string): number | string {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version;
}

describe("transaction version constants", () => {
  it("advertises version 0 only; legacy is tolerated but never advertised", () => {
    expect(ADVERTISED_TRANSACTION_VERSIONS).toEqual([0]);
    expect(ACCEPTED_TRANSACTION_VERSIONS).toEqual(["legacy", 0]);
    for (const v of ADVERTISED_TRANSACTION_VERSIONS) {
      expect(ACCEPTED_TRANSACTION_VERSIONS).toContain(v);
    }
  });
});

describe("isAcceptedTransactionVersion", () => {
  it("accepts legacy and version 0", () => {
    expect(isAcceptedTransactionVersion("legacy")).toBe(true);
    expect(isAcceptedTransactionVersion(0)).toBe(true);
  });

  it("rejects every other version", () => {
    expect(isAcceptedTransactionVersion(1)).toBe(false);
    expect(isAcceptedTransactionVersion(2)).toBe(false);
    expect(isAcceptedTransactionVersion(127)).toBe(false);
    expect(isAcceptedTransactionVersion("0")).toBe(false);
    expect(isAcceptedTransactionVersion("v0")).toBe(false);
  });
});

describe("resolveTransactionVersion", () => {
  it("defaults to version 0 when the field is absent", () => {
    expect(resolveTransactionVersion(undefined)).toBe(0);
    expect(resolveTransactionVersion({})).toBe(0);
    expect(resolveTransactionVersion({ feePayer: FEE_PAYER })).toBe(0);
  });

  it.each(["0", 0, null])("rejects malformed transactionVersions metadata (%j)", advertised => {
    expect(() => resolveTransactionVersion({ transactionVersions: advertised })).toThrow(
      /^unsupported_transaction_version/,
    );
  });

  it("builds version 0 whenever it is advertised", () => {
    expect(resolveTransactionVersion({ transactionVersions: [0] })).toBe(0);
    expect(resolveTransactionVersion({ transactionVersions: ["legacy", 0] })).toBe(0);
    expect(resolveTransactionVersion({ transactionVersions: [0, 1] })).toBe(0);
    expect(resolveTransactionVersion({ transactionVersions: [1, 0] })).toBe(0);
  });

  it("selects the highest mutually supported version", () => {
    expect(selectHighestMutuallySupportedTransactionVersion([0, 2, 1], [0, 1])).toBe(1);
  });

  it("never falls back to legacy and throws when version 0 is not advertised", () => {
    expect(() => resolveTransactionVersion({ transactionVersions: ["legacy"] })).toThrow(
      /^unsupported_transaction_version/,
    );
    expect(() => resolveTransactionVersion({ transactionVersions: [1] })).toThrow(
      /^unsupported_transaction_version/,
    );
    expect(() => resolveTransactionVersion({ transactionVersions: [] })).toThrow(
      /^unsupported_transaction_version/,
    );
    expect(() => resolveTransactionVersion({ transactionVersions: ["0"] })).toThrow(
      /^unsupported_transaction_version/,
    );
  });
});

describe("exact client honours extra.transactionVersions", () => {
  beforeEach(() => {
    vi.mocked(fetchMint).mockResolvedValue({
      data: { decimals: 6 },
      programAddress: TOKEN_PROGRAM_ADDRESS,
    } as never);
  });

  function requirements(extra: Record<string, unknown>): PaymentRequirements {
    return {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: USDC_DEVNET_ADDRESS,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: FEE_PAYER, recentBlockhash: PROVIDED_BLOCKHASH, ...extra },
    };
  }

  it("builds a version 0 transaction when the field is absent", async () => {
    const payer = await generateKeyPairSigner();
    const client = new ExactSvmClientScheme(payer);
    const { payload } = await client.createPaymentPayload(2, requirements({}));
    expect(wireVersion((payload as { transaction: string }).transaction)).toBe(0);
  });

  it("builds a version 0 transaction when 0 is advertised alongside newer versions", async () => {
    const payer = await generateKeyPairSigner();
    const client = new ExactSvmClientScheme(payer);
    const { payload } = await client.createPaymentPayload(
      2,
      requirements({ transactionVersions: [2, 1, 0] }),
    );
    expect(wireVersion((payload as { transaction: string }).transaction)).toBe(0);
  });

  it("refuses to build when the facilitator does not accept version 0", async () => {
    const payer = await generateKeyPairSigner();
    const client = new ExactSvmClientScheme(payer);
    vi.mocked(fetchMint).mockClear();
    await expect(
      client.createPaymentPayload(2, requirements({ transactionVersions: [1] })),
    ).rejects.toThrow(/^unsupported_transaction_version/);
    await expect(
      client.createPaymentPayload(2, requirements({ transactionVersions: ["legacy"] })),
    ).rejects.toThrow(/^unsupported_transaction_version/);
    expect(fetchMint).not.toHaveBeenCalled();
  });
});

describe("verifier version gates", () => {
  // Any valid 32-byte base58 pubkey works as the recipient.
  const payTo = USDC_DEVNET_ADDRESS;

  async function exactPayment(version: 0 | "legacy" | 1 = 0): Promise<{
    transaction: string;
    requirements: PaymentRequirements;
  }> {
    const payer = await generateKeyPairSigner();
    const transaction =
      version === 1
        ? await buildVersion1WireTransaction({ feePayer: FEE_PAYER as never, payer })
        : await buildExactPaymentTransaction({
            amount: 100000n,
            feePayer: FEE_PAYER as never,
            mint: USDC_DEVNET_ADDRESS as never,
            payTo: payTo as never,
            payer,
            version,
          });
    return {
      transaction,
      requirements: {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: FEE_PAYER },
      },
    };
  }

  it("exact facilitator rejects a version 1 message before any other check", async () => {
    const { transaction, requirements } = await exactPayment(1);
    expect(wireVersion(transaction)).toBe(1);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: "http://example.com/p", description: "", mimeType: "application/json" },
      accepted: requirements,
      payload: { transaction },
    };
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner());

    // The v1 payload carries no transfer at all; a layout or amount error
    // would surface first if the gate did not run before every other check.
    const rejected = await facilitator.verify(payload, requirements);
    expect(rejected.isValid).toBe(false);
    expect(rejected.invalidReason).toBe(Errors.ErrUnsupportedTransactionVersion);
    expect(rejected.invalidReason).toBe("unsupported_transaction_version");

    const control = await exactPayment(0);
    const accepted = await facilitator.verify(
      { ...payload, accepted: control.requirements, payload: { transaction: control.transaction } },
      control.requirements,
    );
    expect(accepted.invalidReason).not.toBe(Errors.ErrUnsupportedTransactionVersion);
  });

  it("exact settle rejects a version 1 message before duplicate detection", async () => {
    const { transaction, requirements } = await exactPayment(1);
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: "http://example.com/p", description: "", mimeType: "application/json" },
      accepted: requirements,
      payload: { transaction },
    };
    const cache = new SettlementCache();
    cache.isDuplicate(transactionMessageHash(decodeTransactionFromPayload({ transaction })));
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner(), cache);

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrUnsupportedTransactionVersion);
  });

  it("exact facilitator still accepts a real legacy message past the gate", async () => {
    const { transaction, requirements } = await exactPayment("legacy");
    expect(wireVersion(transaction)).toBe("legacy");
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: "http://example.com/p", description: "", mimeType: "application/json" },
      accepted: requirements,
      payload: { transaction },
    };
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner());
    const result = await facilitator.verify(payload, requirements);
    expect(result.invalidReason).not.toBe(Errors.ErrUnsupportedTransactionVersion);
  });

  it("legacy x402 v1 exact facilitator rejects a version 1 message", async () => {
    const { transaction } = await exactPayment(1);
    const requirements: PaymentRequirementsV1 = {
      scheme: "exact",
      network: "solana-devnet",
      asset: USDC_DEVNET_ADDRESS,
      maxAmountRequired: "100000",
      payTo: payTo,
      maxTimeoutSeconds: 3600,
      resource: "http://example.com/p",
      description: "",
      mimeType: "application/json",
      extra: { feePayer: FEE_PAYER },
    };
    const payload: PaymentPayloadV1 = {
      x402Version: 1,
      scheme: "exact",
      network: "solana-devnet",
      payload: { transaction },
    };
    const facilitator = new ExactSvmSchemeV1(facilitatorSigner());

    const rejected = await facilitator.verify(payload, requirements);
    expect(rejected.isValid).toBe(false);
    expect(rejected.invalidReason).toBe("unsupported_transaction_version");

    const v0 = await exactPayment(0);
    const control = await facilitator.verify(
      { ...payload, payload: { transaction: v0.transaction } },
      requirements,
    );
    expect(control.invalidReason).not.toBe("unsupported_transaction_version");
  });

  it("legacy x402 v1 settle rejects a version 1 message before duplicate detection", async () => {
    const { transaction } = await exactPayment(1);
    const requirements: PaymentRequirementsV1 = {
      scheme: "exact",
      network: "solana-devnet",
      asset: USDC_DEVNET_ADDRESS,
      maxAmountRequired: "100000",
      payTo,
      maxTimeoutSeconds: 3600,
      resource: "http://example.com/p",
      description: "",
      mimeType: "application/json",
      extra: { feePayer: FEE_PAYER },
    };
    const payload: PaymentPayloadV1 = {
      x402Version: 1,
      scheme: "exact",
      network: "solana-devnet",
      payload: { transaction },
    };
    const cache = new SettlementCache();
    cache.isDuplicate(transactionMessageHash(decodeTransactionFromPayload({ transaction })));
    const facilitator = new ExactSvmSchemeV1(facilitatorSigner(), cache);

    const result = await facilitator.settle(payload, requirements);
    expect(result.success).toBe(false);
    expect(result.errorReason).toBe(Errors.ErrUnsupportedTransactionVersion);
  });

  it("smart wallet checks fail closed on a version 1 message", async () => {
    const v1 = decodeTransactionFromPayload({ transaction: (await exactPayment(1)).transaction });
    expect(() => validateComputeBudgetLimits(v1)).toThrow(/^unsupported_transaction_version/);
    await expect(assertFeePayerIsolated(v1, FEE_PAYER)).rejects.toThrow(
      /^unsupported_transaction_version/,
    );

    const v0 = decodeTransactionFromPayload({ transaction: (await exactPayment(0)).transaction });
    expect(() => validateComputeBudgetLimits(v0)).not.toThrow();
  });

  it("a real version 0 wire transaction reports version 0", async () => {
    const { transaction } = await exactPayment();
    expect(wireVersion(transaction)).toBe(0);
    // Sanity: the wire encoder round-trips, so the gate sees the same bytes the client sent.
    const decoded = decodeTransactionFromPayload({ transaction });
    expect(getBase64EncodedWireTransaction(decoded)).toBe(transaction);
  });
});
