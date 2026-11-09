/**
 * Transaction message version negotiation.
 *
 * Facilitators advertise the versions they accept in `/supported`
 * (`extra.transactionVersions`), servers copy the list into the challenge,
 * clients build the highest advertised version they support, and every
 * verifier rejects any other version before inspecting signatures or
 * instructions. Version 1 (SIMD-0385) is accepted and checked through its
 * message config; an unknown future version (2) is rejected.
 */
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { fetchMint } from "@solana-program/token-2022";
import {
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionDecoder,
} from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { PaymentPayloadV1, PaymentRequirementsV1 } from "@x402/core/types/v1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCEPTED_TRANSACTION_VERSIONS,
  ADVERTISED_TRANSACTION_VERSIONS,
  MEMO_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { ExactSvmScheme as ExactSvmClientScheme } from "../../src/exact/client/scheme";
import * as Errors from "../../src/exact/facilitator/errors";
import { registerExactSvmScheme } from "../../src/exact/facilitator/register";
import { ExactSvmScheme as ExactSvmFacilitatorScheme } from "../../src/exact/facilitator/scheme";
import {
  assertFeePayerIsolated,
  validateComputeBudgetLimits,
} from "../../src/exact/facilitator/smartWalletVerification";
import { ExactSvmSchemeV1 } from "../../src/exact/v1/facilitator/scheme";
import { verifyEd25519Signature } from "../../src/payment-channels/voucher";
import { toFacilitatorSvmSigner, type FacilitatorSvmSigner } from "../../src/signer";
import {
  DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  readTransactionV1Config,
} from "../../src/transactionV1";
import {
  decodeTransactionFromPayload,
  isAcceptedTransactionVersion,
  normalizeAcceptedTransactionVersions,
  normalizeClientTransactionVersions,
  peekWireTransactionVersion,
  resolveTransactionVersion,
  selectHighestMutuallySupportedTransactionVersion,
} from "../../src/utils";
import { buildExactPaymentTransaction } from "./helpers/signedTransaction";

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
    simulateTransaction: vi.fn().mockResolvedValue(undefined) as never,
  };
}

function compiledMessage(transactionBase64: string) {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
}

function wireVersion(transactionBase64: string): number | string {
  return compiledMessage(transactionBase64).version;
}

describe("transaction version constants", () => {
  it("advertises versions 0 and 1; legacy is tolerated but never advertised", () => {
    expect(ADVERTISED_TRANSACTION_VERSIONS).toEqual([0, 1]);
    expect(ACCEPTED_TRANSACTION_VERSIONS).toEqual(["legacy", 0, 1]);
    for (const v of ADVERTISED_TRANSACTION_VERSIONS) {
      expect(ACCEPTED_TRANSACTION_VERSIONS).toContain(v);
    }
  });
});

describe("isAcceptedTransactionVersion", () => {
  it("accepts legacy, version 0 and version 1", () => {
    expect(isAcceptedTransactionVersion("legacy")).toBe(true);
    expect(isAcceptedTransactionVersion(0)).toBe(true);
    expect(isAcceptedTransactionVersion(1)).toBe(true);
  });

  it("rejects every other version", () => {
    expect(isAcceptedTransactionVersion(2)).toBe(false);
    expect(isAcceptedTransactionVersion(127)).toBe(false);
    expect(isAcceptedTransactionVersion("0")).toBe(false);
    expect(isAcceptedTransactionVersion("1")).toBe(false);
    expect(isAcceptedTransactionVersion("v0")).toBe(false);
  });
});

describe("configured accepted transaction-version sets", () => {
  it("polices legacy as version 0", () => {
    expect(isAcceptedTransactionVersion("legacy", [0])).toBe(true);
    expect(isAcceptedTransactionVersion("legacy", [1])).toBe(false);
    expect(isAcceptedTransactionVersion(0, [1])).toBe(false);
    expect(isAcceptedTransactionVersion(1, [0])).toBe(false);
    expect(isAcceptedTransactionVersion(1, [0, 1])).toBe(true);
    expect(isAcceptedTransactionVersion(2, [0, 1, 2])).toBe(false);
  });

  it("normalizes a facilitator's transactionVersions option", () => {
    expect(normalizeAcceptedTransactionVersions(undefined)).toEqual([0, 1]);
    expect(normalizeAcceptedTransactionVersions([1, 0, 1])).toEqual([0, 1]);
    expect(normalizeAcceptedTransactionVersions([0])).toEqual([0]);
    expect(() => normalizeAcceptedTransactionVersions([])).toThrow(/non-empty/);
    expect(() => normalizeAcceptedTransactionVersions([0, 2])).toThrow(/non-empty/);
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

  it("builds the highest advertised version, independent of list order", () => {
    expect(resolveTransactionVersion({ transactionVersions: [0] })).toBe(0);
    expect(resolveTransactionVersion({ transactionVersions: [1] })).toBe(1);
    expect(resolveTransactionVersion({ transactionVersions: [0, 1] })).toBe(1);
    expect(resolveTransactionVersion({ transactionVersions: [1, 0] })).toBe(1);
  });

  it("honours a client restricted to version 0", () => {
    expect(resolveTransactionVersion({ transactionVersions: [0, 1] }, [0])).toBe(0);
    expect(() => resolveTransactionVersion({ transactionVersions: [1] }, [0])).toThrow(
      /^unsupported_transaction_version/,
    );
  });

  it.each([[[]], [[2]], [[0, 2]], [["1"]]])(
    "rejects an invalid client transactionVersions option (%j)",
    supported => {
      expect(() =>
        resolveTransactionVersion({ transactionVersions: [0, 1] }, supported as never),
      ).toThrow(/transactionVersions must be a non-empty list/);
      expect(() => normalizeClientTransactionVersions(supported as never)).toThrow();
    },
  );

  it.each([[["legacy", 0]], [["1", 0]], [[null, 0]], [[2, 1, 0]], [[0.5, 0]], [[true, 0]]])(
    "fails closed when any entry is not the integer 0 or 1 (%j)",
    advertised => {
      expect(() => resolveTransactionVersion({ transactionVersions: advertised })).toThrow(
        /^unsupported_transaction_version/,
      );
    },
  );

  it("selects the highest mutually supported version", () => {
    expect(selectHighestMutuallySupportedTransactionVersion([0, 2, 1], [0, 1])).toBe(1);
  });

  it("never falls back to legacy and throws when nothing is mutually supported", () => {
    expect(() => resolveTransactionVersion({ transactionVersions: ["legacy"] })).toThrow(
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

  it("builds a version 1 transaction when version 1 is advertised", async () => {
    const payer = await generateKeyPairSigner();
    const client = new ExactSvmClientScheme(payer);
    const { payload } = await client.createPaymentPayload(
      2,
      requirements({ transactionVersions: [0, 1] }),
    );
    const transaction = (payload as { transaction: string }).transaction;
    expect(wireVersion(transaction)).toBe(1);
    const compiled = compiledMessage(transaction);
    expect(readTransactionV1Config(compiled)).toMatchObject({
      computeUnitLimit: 20_000,
      loadedAccountsDataSizeLimit: DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
      priorityFeeLamports: 1n,
    });
    // No ComputeBudget prefix: the transfer leads, then the memo.
    const programs = getInstructionsFromCompiledTransactionMessage(compiled).map(ix =>
      ix.programAddress.toString(),
    );
    expect(programs).toEqual([TOKEN_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS]);
  });

  it("builds version 0 when the client is restricted to it", async () => {
    const payer = await generateKeyPairSigner();
    const client = new ExactSvmClientScheme(payer, { transactionVersions: [0] });
    const { payload } = await client.createPaymentPayload(
      2,
      requirements({ transactionVersions: [0, 1] }),
    );
    expect(wireVersion((payload as { transaction: string }).transaction)).toBe(0);
  });

  it("refuses to build when nothing is mutually supported", async () => {
    const payer = await generateKeyPairSigner();
    const client = new ExactSvmClientScheme(payer, { transactionVersions: [0] });
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

  async function exactPayment(
    version: 0 | "legacy" | 1 = 0,
    options: Pick<
      Parameters<typeof buildExactPaymentTransaction>[0],
      "v1Config" | "leadingInstructions" | "memo"
    > = {},
  ): Promise<{
    transaction: string;
    requirements: PaymentRequirements;
  }> {
    const payer = await generateKeyPairSigner();
    const transaction = await buildExactPaymentTransaction({
      amount: 100000n,
      feePayer: FEE_PAYER as never,
      mint: USDC_DEVNET_ADDRESS as never,
      payTo: payTo as never,
      payer,
      version,
      ...options,
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

  function v2Payload(transaction: string, requirements: PaymentRequirements): PaymentPayload {
    return {
      x402Version: 2,
      resource: { url: "http://example.com/p", description: "", mimeType: "application/json" },
      accepted: requirements,
      payload: { transaction },
    };
  }

  function v1ProtocolRequirements(): PaymentRequirementsV1 {
    return {
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
  }

  function v1ProtocolPayload(transaction: string): PaymentPayloadV1 {
    return {
      x402Version: 1,
      scheme: "exact",
      network: "solana-devnet",
      payload: { transaction },
    };
  }

  it("exact facilitator verifies a version 1 payment through Path 1", async () => {
    const { transaction, requirements } = await exactPayment(1);
    expect(wireVersion(transaction)).toBe(1);
    const signer = facilitatorSigner();
    const facilitator = new ExactSvmFacilitatorScheme(signer);

    const result = await facilitator.verify(v2Payload(transaction, requirements), requirements);
    expect(result).toMatchObject({ isValid: true });
    expect(signer.simulateTransaction).toHaveBeenCalledOnce();
  });

  it("exact facilitator verifies the client's own version 1 payload", async () => {
    vi.mocked(fetchMint).mockResolvedValue({
      data: { decimals: 6 },
      programAddress: TOKEN_PROGRAM_ADDRESS,
    } as never);
    const client = new ExactSvmClientScheme(await generateKeyPairSigner());
    const { requirements } = await exactPayment();
    const advertised = {
      ...requirements,
      extra: {
        ...requirements.extra,
        recentBlockhash: PROVIDED_BLOCKHASH,
        transactionVersions: [0, 1],
      },
    };
    const { payload } = await client.createPaymentPayload(2, advertised);
    const transaction = (payload as { transaction: string }).transaction;
    expect(wireVersion(transaction)).toBe(1);

    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner());
    const result = await facilitator.verify(v2Payload(transaction, advertised), advertised);
    expect(result).toMatchObject({ isValid: true });
  });

  it("legacy x402 v1 exact facilitator verifies a version 1 payment", async () => {
    const { transaction } = await exactPayment(1);
    const facilitator = new ExactSvmSchemeV1(facilitatorSigner());
    const result = await facilitator.verify(
      v1ProtocolPayload(transaction),
      v1ProtocolRequirements(),
    );
    expect(result).toMatchObject({ isValid: true });
  });

  it("the facilitator signer co-signs a version 1 payment over its versioned message bytes", async () => {
    const feePayer = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const transaction = await buildExactPaymentTransaction({
      amount: 100000n,
      feePayer: feePayer.address,
      mint: USDC_DEVNET_ADDRESS as never,
      payTo: payTo as never,
      payer,
      version: 1,
    });
    const signed = await toFacilitatorSvmSigner(feePayer).signTransaction(
      transaction,
      feePayer.address,
      SOLANA_DEVNET_CAIP2,
    );
    const decoded = decodeTransactionFromPayload({ transaction: signed });
    expect(decoded.messageBytes[0]).toBe(0x81);
    for (const signer of [feePayer, payer]) {
      const signature = decoded.signatures[signer.address];
      expect(signature).toBeTruthy();
      await expect(
        verifyEd25519Signature({
          message: decoded.messageBytes as unknown as Uint8Array,
          publicKey: getBase58Encoder().encode(signer.address) as Uint8Array,
          signature: signature as unknown as Uint8Array,
        }),
      ).resolves.toBe(true);
    }
  });

  it("exact facilitator advertises and enforces its configured accepted set", async () => {
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner(), undefined, {
      transactionVersions: [0],
    });
    expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)?.transactionVersions).toEqual([0]);

    // A sponsor accepting [0] refuses a valid version 1 payment before any
    // instruction check (scheme_exact_svm.md §1.5), and still takes version 0
    // and legacy (policed as version 0) past the gate.
    const v1 = await exactPayment(1);
    await expect(
      facilitator.verify(v2Payload(v1.transaction, v1.requirements), v1.requirements),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrUnsupportedTransactionVersion,
    });
    for (const version of [0, "legacy"] as const) {
      const { transaction, requirements } = await exactPayment(version);
      const result = await facilitator.verify(v2Payload(transaction, requirements), requirements);
      expect(result.invalidReason).not.toBe(Errors.ErrUnsupportedTransactionVersion);
    }
  });

  it("exact facilitator accepting [1] only refuses version 0 and legacy", async () => {
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner(), undefined, {
      transactionVersions: [1],
    });
    for (const version of [0, "legacy"] as const) {
      const { transaction, requirements } = await exactPayment(version);
      await expect(
        facilitator.verify(v2Payload(transaction, requirements), requirements),
      ).resolves.toMatchObject({ invalidReason: Errors.ErrUnsupportedTransactionVersion });
    }
  });

  it("legacy x402 v1 exact facilitator advertises and enforces its configured accepted set", async () => {
    const facilitator = new ExactSvmSchemeV1(facilitatorSigner(), undefined, {
      transactionVersions: [0],
    });
    expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)?.transactionVersions).toEqual([0]);

    const v1 = await exactPayment(1);
    await expect(
      facilitator.verify(v1ProtocolPayload(v1.transaction), v1ProtocolRequirements()),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrUnsupportedTransactionVersion,
    });
    const v0 = await exactPayment(0);
    await expect(
      facilitator.verify(v1ProtocolPayload(v0.transaction), v1ProtocolRequirements()),
    ).resolves.toMatchObject({ isValid: true });
    await expect(
      facilitator.settle(v1ProtocolPayload(v1.transaction), v1ProtocolRequirements()),
    ).resolves.toMatchObject({
      success: false,
      errorReason: Errors.ErrUnsupportedTransactionVersion,
    });
    expect(
      () => new ExactSvmSchemeV1(facilitatorSigner(), undefined, { transactionVersions: [] }),
    ).toThrow(/transactionVersions must be a non-empty list of 0 and\/or 1/);
  });

  it("registerExactSvmScheme applies transactionVersions to the v2 and v1 schemes", () => {
    const facilitator = new x402Facilitator();
    registerExactSvmScheme(facilitator, {
      signer: facilitatorSigner(),
      networks: SOLANA_DEVNET_CAIP2,
      transactionVersions: [0],
    });
    const kinds = facilitator.getSupported().kinds;
    expect(kinds.length).toBeGreaterThan(1);
    for (const kind of kinds) expect(kind.extra?.transactionVersions).toEqual([0]);
  });

  it("exact facilitator rejects an invalid transactionVersions option at construction", () => {
    for (const transactionVersions of [[], [2], ["legacy"]] as unknown as (0 | 1)[][]) {
      expect(
        () =>
          new ExactSvmFacilitatorScheme(facilitatorSigner(), undefined, { transactionVersions }),
      ).toThrow(/transactionVersions must be a non-empty list of 0 and\/or 1/);
    }
  });

  it("exact facilitator caps a version 1 compute unit limit at the 400,000 default", async () => {
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner());
    const { transaction, requirements } = await exactPayment(1, {
      v1Config: { computeUnitLimit: 400_001, loadedAccountsDataSizeLimit: 4_194_304 },
    });
    await expect(
      facilitator.verify(v2Payload(transaction, requirements), requirements),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: Errors.ErrComputeLimitInstructionTooHigh,
    });
  });

  it("exact facilitator still accepts a real legacy message past the gate", async () => {
    const { transaction, requirements } = await exactPayment("legacy");
    expect(wireVersion(transaction)).toBe("legacy");
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner());
    const result = await facilitator.verify(v2Payload(transaction, requirements), requirements);
    expect(result.invalidReason).not.toBe(Errors.ErrUnsupportedTransactionVersion);
  });

  // Path 1 caps a 20k-CU transaction's fee at 5,000,000 microlamports/CU, i.e. 100,000 lamports.
  const budgetRejections: Array<
    [string, Parameters<typeof buildExactPaymentTransaction>[0]["v1Config"], string]
  > = [
    [
      "an unset compute unit limit",
      { loadedAccountsDataSizeLimit: 4_194_304 },
      Errors.ErrComputeLimitInstruction,
    ],
    [
      "an unset loaded-account-data budget",
      { computeUnitLimit: 20_000 },
      Errors.ErrLoadedAccountsDataSizeLimitMissing,
    ],
    [
      "a heap size request",
      { computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 4_194_304, heapSize: 65_536 },
      Errors.ErrTransactionV1HeapSize,
    ],
    [
      "a priority fee one lamport over the cap",
      {
        computeUnitLimit: 20_000,
        loadedAccountsDataSizeLimit: 4_194_304,
        priorityFeeLamports: 100_001n,
      },
      Errors.ErrComputePriceInstructionTooHigh,
    ],
    [
      "a u64-max priority fee",
      {
        computeUnitLimit: 20_000,
        loadedAccountsDataSizeLimit: 4_194_304,
        priorityFeeLamports: (1n << 64n) - 1n,
      },
      Errors.ErrComputePriceInstructionTooHigh,
    ],
  ];

  it.each(budgetRejections)(
    "exact Path 1 rejects a version 1 payment with %s",
    async (_n, v1Config, reason) => {
      const { transaction, requirements } = await exactPayment(1, { v1Config });
      const signer = facilitatorSigner();
      const facilitator = new ExactSvmFacilitatorScheme(signer);
      const result = await facilitator.verify(v2Payload(transaction, requirements), requirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(reason);
      expect(signer.simulateTransaction).not.toHaveBeenCalled();

      const v1Protocol = await new ExactSvmSchemeV1(facilitatorSigner()).verify(
        v1ProtocolPayload(transaction),
        v1ProtocolRequirements(),
      );
      expect(v1Protocol.invalidReason).toBe(reason);
    },
  );

  it("exact Path 1 accepts a priority fee exactly at the cap", async () => {
    const { transaction, requirements } = await exactPayment(1, {
      v1Config: {
        computeUnitLimit: 20_000,
        loadedAccountsDataSizeLimit: 4_194_304,
        priorityFeeLamports: 100_000n,
      },
    });
    const result = await new ExactSvmFacilitatorScheme(facilitatorSigner()).verify(
      v2Payload(transaction, requirements),
      requirements,
    );
    expect(result).toMatchObject({ isValid: true });
  });

  it("exact Path 1 rejects a compute unit limit above maxComputeUnits", async () => {
    const { transaction, requirements } = await exactPayment(1);
    const facilitator = new ExactSvmFacilitatorScheme(facilitatorSigner(), undefined, {
      maxComputeUnits: 10_000,
    });
    const result = await facilitator.verify(v2Payload(transaction, requirements), requirements);
    expect(result.invalidReason).toBe(Errors.ErrComputeLimitInstructionTooHigh);
  });

  it("exact Path 1 rejects a ComputeBudget instruction in a version 1 payment", async () => {
    const { transaction, requirements } = await exactPayment(1, {
      leadingInstructions: [getSetComputeUnitPriceInstruction({ microLamports: 1 })],
    });
    const result = await new ExactSvmFacilitatorScheme(facilitatorSigner()).verify(
      v2Payload(transaction, requirements),
      requirements,
    );
    expect(result.invalidReason).toBe(Errors.ErrTransactionV1ComputeBudgetInstruction);
  });

  /** Serialized size of a base64 wire transaction. */
  function wireSize(transaction: string): number {
    return getBase64Codec().encode(transaction).byteLength;
  }

  /** An exact payment padded through its memo to exactly `size` bytes. */
  async function paymentOfSize(version: 0 | 1, size: number) {
    const probe = await exactPayment(version, { memo: "a".repeat(500) });
    const memo = "a".repeat(500 + size - wireSize(probe.transaction));
    const sized = await exactPayment(version, { memo });
    expect(wireSize(sized.transaction)).toBe(size);
    return sized;
  }

  it.each([
    [0, 1232, true],
    [0, 1233, false],
    [1, 1233, true],
    [1, 4096, true],
    [1, 4097, false],
  ] as const)(
    "exact verify enforces the version %s size limit at %s bytes",
    async (version, size, accepted) => {
      const { transaction, requirements } = await paymentOfSize(version, size);
      const signer = facilitatorSigner();
      const result = await new ExactSvmFacilitatorScheme(signer).verify(
        v2Payload(transaction, requirements),
        requirements,
      );
      if (accepted) {
        expect(result).toMatchObject({ isValid: true });
      } else {
        expect(result.invalidReason).toBe(Errors.ErrTransactionSizeExceeded);
        expect(signer.simulateTransaction).not.toHaveBeenCalled();
      }

      const v1Protocol = await new ExactSvmSchemeV1(facilitatorSigner()).verify(
        v1ProtocolPayload(transaction),
        v1ProtocolRequirements(),
      );
      if (accepted) {
        expect(v1Protocol).toMatchObject({ isValid: true });
      } else {
        expect(v1Protocol.invalidReason).toBe(Errors.ErrTransactionSizeExceeded);
      }
    },
  );

  it("smart wallet checks apply their own caps to a version 1 message", async () => {
    const v1 = decodeTransactionFromPayload({ transaction: (await exactPayment(1)).transaction });
    expect(() => validateComputeBudgetLimits(v1)).not.toThrow();
    await expect(assertFeePayerIsolated(v1, FEE_PAYER)).resolves.toBeUndefined();

    // Path 2 caps a 20k-CU transaction's fee at 50,000 microlamports/CU, i.e. 1,000 lamports.
    const expensive = decodeTransactionFromPayload({
      transaction: (
        await exactPayment(1, {
          v1Config: {
            computeUnitLimit: 20_000,
            loadedAccountsDataSizeLimit: 4_194_304,
            priorityFeeLamports: 1_001n,
          },
        })
      ).transaction,
    });
    expect(() => validateComputeBudgetLimits(expensive)).toThrow(
      new RegExp(`^${Errors.ErrSmartWalletPriorityFeeTooHigh}`),
    );

    const smuggled = decodeTransactionFromPayload({
      transaction: (
        await exactPayment(1, {
          leadingInstructions: [getSetComputeUnitPriceInstruction({ microLamports: 1 })],
        })
      ).transaction,
    });
    expect(() => validateComputeBudgetLimits(smuggled)).toThrow(
      new RegExp(`^${Errors.ErrSmartWalletUnsupportedComputeBudget}`),
    );
  });

  /**
   * Re-encode a signed version 0 transaction with its message version prefix
   * replaced, as the Go facilitator tests do. No decoder override is active,
   * so this exercises what the installed decoder does with the bytes.
   */
  function retagMessageVersion(transactionBase64: string, prefix: number): string {
    const bytes = new Uint8Array(getBase64Codec().encode(transactionBase64));
    const offset = 1 + 64 * bytes[0];
    expect(bytes[offset]).toBe(0x80);
    bytes[offset] = prefix;
    return getBase64Codec().decode(bytes);
  }

  /** A message-first wire transaction, as SIMD-0385 lays out v1, tagged version 2. */
  function messageFirstVersion2Transaction(): string {
    const bytes = new Uint8Array(1 + 3 + 4 + 32 + 1 + 1 + 32 + 64);
    bytes.set([0x82, 1, 0, 0], 0);
    bytes[40] = 0; // NumInstructions
    bytes[41] = 1; // NumAddresses (the fee payer)
    bytes.fill(7, 42, 74);
    return getBase64Codec().decode(bytes);
  }

  const version2Wires: Array<[string, () => Promise<string>]> = [
    [
      "retagged 0x82 prefix",
      async () => retagMessageVersion((await exactPayment()).transaction, 0x82),
    ],
    ["message-first layout", async () => messageFirstVersion2Transaction()],
  ];

  it.each(version2Wires)("peeks version 2 from a %s", async (_name, build) => {
    expect(peekWireTransactionVersion(await build())).toBe(2);
  });

  it.each(version2Wires)(
    "exact verify and settle reject a version 2 %s before any signing",
    async (_name, build) => {
      const { requirements } = await exactPayment();
      const payload = v2Payload(await build(), requirements);
      const signer = facilitatorSigner();
      const facilitator = new ExactSvmFacilitatorScheme(signer);

      const verified = await facilitator.verify(payload, requirements);
      expect(verified.isValid).toBe(false);
      expect(verified.invalidReason).toBe(Errors.ErrUnsupportedTransactionVersion);

      const settled = await facilitator.settle(payload, requirements);
      expect(settled.success).toBe(false);
      expect(settled.errorReason).toBe(Errors.ErrUnsupportedTransactionVersion);
      expect(signer.signTransactions).not.toHaveBeenCalled();
      expect(signer.getRpcForNetwork).not.toHaveBeenCalled();
    },
  );

  it.each(version2Wires)(
    "legacy x402 v1 exact verify and settle reject a version 2 %s before any signing",
    async (_name, build) => {
      const payload = v1ProtocolPayload(await build());
      const signer = facilitatorSigner();
      const facilitator = new ExactSvmSchemeV1(signer);

      const verified = await facilitator.verify(payload, v1ProtocolRequirements());
      expect(verified.isValid).toBe(false);
      expect(verified.invalidReason).toBe(Errors.ErrUnsupportedTransactionVersion);

      const settled = await facilitator.settle(payload, v1ProtocolRequirements());
      expect(settled.success).toBe(false);
      expect(settled.errorReason).toBe(Errors.ErrUnsupportedTransactionVersion);
      expect(signer.signTransactions).not.toHaveBeenCalled();
      expect(signer.getRpcForNetwork).not.toHaveBeenCalled();
    },
  );

  it("peeks legacy, version 0 and version 1 from real wire transactions", async () => {
    const { transaction } = await exactPayment();
    expect(peekWireTransactionVersion(transaction)).toBe(0);
    expect(peekWireTransactionVersion(retagMessageVersion(transaction, 0x01))).toBe("legacy");
    expect(peekWireTransactionVersion((await exactPayment(1)).transaction)).toBe(1);
    expect(peekWireTransactionVersion("")).toBeUndefined();
  });

  it("a real version 0 wire transaction reports version 0", async () => {
    const { transaction } = await exactPayment();
    expect(wireVersion(transaction)).toBe(0);
    // Sanity: the wire encoder round-trips, so the gate sees the same bytes the client sent.
    const decoded = decodeTransactionFromPayload({ transaction });
    expect(getBase64EncodedWireTransaction(decoded)).toBe(transaction);
  });
});
