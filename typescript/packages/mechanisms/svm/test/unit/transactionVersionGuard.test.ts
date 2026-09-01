/**
 * Guards against transaction versions this codebase predates. Kit 8 cannot
 * even decode a hypothetical version 2 transaction, so these tests force the
 * compiled-message decoder to report one: the scenario being defended against
 * is a future kit (satisfying the open `>=8.0.0` peer range) that learns to
 * decode a new version before the schemes learn to police it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from "@solana/kit";
import { validateComputeBudgetLimits } from "../../src/exact/facilitator/smartWalletVerification";
import { decodeTransactionFromPayload, isSupportedTransactionVersion } from "../../src/utils";
import { MEMO_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

let forcedVersion: number | string | null = null;

vi.mock("@solana/kit", async () => {
  const actual = await vi.importActual<typeof import("@solana/kit")>("@solana/kit");
  return {
    ...actual,
    getCompiledTransactionMessageDecoder: () => {
      const real = actual.getCompiledTransactionMessageDecoder();
      return {
        decode: (bytes: Parameters<typeof real.decode>[0]) => {
          const decoded = real.decode(bytes);
          return forcedVersion === null ? decoded : { ...decoded, version: forcedVersion };
        },
      };
    },
  };
});

const FAKE_BLOCKHASH = {
  blockhash: "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF" as Blockhash,
  lastValidBlockHeight: 1000n,
};

async function buildV0Transaction(feePayer: Address): Promise<string> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
    m =>
      appendTransactionMessageInstruction(
        { programAddress: MEMO_PROGRAM_ADDRESS as Address, data: new Uint8Array([1]) },
        m,
      ),
  );
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(msg),
  );
  return getBase64EncodedWireTransaction({
    messageBytes,
    signatures: { [feePayer]: new Uint8Array(64) },
  } as never);
}

describe("isSupportedTransactionVersion", () => {
  it("allows legacy, 0, and 1 and nothing else", () => {
    expect(isSupportedTransactionVersion("legacy")).toBe(true);
    expect(isSupportedTransactionVersion(0)).toBe(true);
    expect(isSupportedTransactionVersion(1)).toBe(true);
    expect(isSupportedTransactionVersion(2)).toBe(false);
    expect(isSupportedTransactionVersion(127)).toBe(false);
  });
});

describe("unknown-version rejection", () => {
  beforeEach(() => {
    forcedVersion = null;
    vi.clearAllMocks();
  });

  it("ExactSvmScheme rejects a transaction reporting an unknown version", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");
    const feePayer = await generateKeyPairSigner();
    const transaction = await buildV0Transaction(feePayer.address);

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      signTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
    };
    const scheme = new ExactSvmScheme(mockSigner as never);
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: feePayer.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    } as PaymentRequirements;

    forcedVersion = 2;
    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      } as unknown as PaymentPayload,
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_transaction_version");
  });

  it("validateComputeBudgetLimits rejects a transaction reporting an unknown version", async () => {
    const feePayer = await generateKeyPairSigner();
    const txBase64 = await buildV0Transaction(feePayer.address);
    const transaction = decodeTransactionFromPayload({ transaction: txBase64 });

    forcedVersion = 2;
    expect(() => validateComputeBudgetLimits(transaction)).toThrow(
      /smart_wallet_unsupported_transaction_version: 2/,
    );
  });

  it("ExactSvmSchemeV1 rejects a transaction reporting an unknown version", async () => {
    const { ExactSvmSchemeV1 } = await import("../../src/exact/v1/facilitator/scheme");
    const feePayer = await generateKeyPairSigner();
    const transaction = await buildV0Transaction(feePayer.address);

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      signTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
    };
    const scheme = new ExactSvmSchemeV1(mockSigner as never);

    forcedVersion = 2;
    const result = await scheme.verify(
      {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        payload: { transaction },
      } as never,
      {
        scheme: "exact",
        network: "solana-devnet",
        asset: USDC_DEVNET_ADDRESS,
        maxAmountRequired: "100000",
        payTo: feePayer.address,
        resource: "https://example.com",
        description: "",
        mimeType: "application/json",
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address },
      } as never,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_transaction_version");
  });
});
