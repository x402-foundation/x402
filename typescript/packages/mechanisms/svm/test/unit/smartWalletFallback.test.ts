import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type IInstruction,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MEMO_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { encodeSignedTransaction, placeholderFeePayerSignature } from "./helpers/signedTransaction";
import * as Errors from "../../src/exact/facilitator/errors";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;
const SWIG_PROGRAM = "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB" as Address;
const TOKEN_PROGRAM = TOKEN_PROGRAM_ADDRESS.toString();

const FAKE_BLOCKHASH = {
  blockhash: "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF" as string &
    import("@solana/kit").Blockhash,
  lastValidBlockHeight: 1000n,
};

let mockAtaMap: Record<string, Address> = {};

vi.mock("@solana-program/token-2022", async () => {
  const actual = await vi.importActual<typeof import("@solana-program/token-2022")>(
    "@solana-program/token-2022",
  );
  return {
    ...actual,
    findAssociatedTokenPda: vi.fn().mockImplementation(async (args: { owner: unknown }) => {
      const owner = String(args.owner);
      const ata = mockAtaMap[owner];
      if (!ata) {
        throw new Error(`Missing ATA mock for owner ${owner}`);
      }
      return [ata, 255] as const;
    }),
  };
});

async function buildTransaction(feePayer: Address, instructions: IInstruction[]) {
  const { compileTransactionMessage } = await import("@solana/kit");
  let msg = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
  );
  for (const ix of instructions) {
    msg = appendTransactionMessageInstruction(ix, msg);
  }
  const compiled = compileTransactionMessage(msg);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
  return { messageBytes, signatures: {} };
}

async function buildSmartWalletPayload(feePayer: Address, unknownProgram: Address, payer: Address) {
  const tx = await buildTransaction(feePayer, [
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([2, 160, 134, 1, 0]) },
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([3, 16, 39, 0, 0, 0, 0, 0, 0]) },
    {
      programAddress: unknownProgram,
      accounts: [{ address: payer, role: 1 }],
      data: new Uint8Array([0]),
    },
  ]);

  return encodeSignedTransaction(tx.messageBytes, [], placeholderFeePayerSignature(feePayer));
}

async function buildSmartWalletPayloadWithMemos(
  feePayer: Address,
  unknownProgram: Address,
  payer: Address,
  memos: string[],
) {
  const encoder = new TextEncoder();
  const baseInstructions: IInstruction[] = [
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([2, 160, 134, 1, 0]) },
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([3, 16, 39, 0, 0, 0, 0, 0, 0]) },
    {
      programAddress: unknownProgram,
      accounts: [{ address: payer, role: 1 }],
      data: new Uint8Array([0]),
    },
  ];
  for (const memo of memos) {
    baseInstructions.push({
      programAddress: MEMO_PROGRAM_ADDRESS as Address,
      data: encoder.encode(memo),
    });
  }

  const tx = await buildTransaction(feePayer, baseInstructions);

  return encodeSignedTransaction(tx.messageBytes, [], placeholderFeePayerSignature(feePayer));
}

/**
 * Build a structurally valid Path-1 transaction (ComputeLimit, ComputePrice,
 * real TransferChecked) so static verification proceeds past layout checks and
 * reaches the semantic amount/mint/recipient checks. Used to prove that a
 * semantic failure (e.g. wrong amount) does NOT fall through to Path 2.
 */
async function buildStaticTransferPayload(args: {
  feePayer: Address;
  source: Address;
  mint: Address;
  destination: Address;
  authority: { address: Address; signMessages: (messages: never[]) => Promise<unknown[]> };
  amount: bigint;
  discriminator?: number;
  leading?: IInstruction[];
  trailing?: IInstruction[];
}) {
  const data = new Uint8Array(10);
  data[0] = args.discriminator ?? 12;
  new DataView(data.buffer).setBigUint64(1, args.amount, true);
  data[9] = 6; // decimals

  const tx = await buildTransaction(args.feePayer, [
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([2, 160, 134, 1, 0]) },
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([3, 16, 39, 0, 0, 0, 0, 0, 0]) },
    ...(args.leading ?? []),
    {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: [
        { address: args.source, role: 1 },
        { address: args.mint, role: 0 },
        { address: args.destination, role: 1 },
        // Authority is a signer (role 3), so the compiled message requires its
        // signature slot in addition to the fee payer's.
        { address: args.authority.address, role: 3 },
      ],
      data,
    },
    ...(args.trailing ?? []),
  ]);

  return encodeSignedTransaction(
    tx.messageBytes,
    [args.authority],
    placeholderFeePayerSignature(args.feePayer),
  );
}

function buildMockInnerTransfer(
  programId: string,
  mint: string,
  destination: string,
  authority: string,
  amount: string,
) {
  return {
    programId,
    parsed: {
      type: "transferChecked",
      info: { mint, destination, authority, tokenAmount: { amount } },
    },
  } as Record<string, unknown>;
}

describe("ExactSvmScheme smart wallet fallback path", () => {
  beforeEach(() => {
    mockAtaMap = {};
    vi.clearAllMocks();
  });

  it("verify falls back to simulation when static path rejects unknown program", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildSmartWalletPayload(
      feePayer.address,
      unknownProgram.address,
      payer.address,
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address },
      } as never,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(payer.address);
    expect(mockSigner.simulateTransactionWithInnerInstructions).toHaveBeenCalled();
  });

  it("verify allows Swig through the default smart wallet allowlist", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildSmartWalletPayload(feePayer.address, SWIG_PROGRAM, payer.address);

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address },
      } as never,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(payer.address);
    expect(result).not.toHaveProperty("matchedTransfer");
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(mockSigner.simulateTransactionWithInnerInstructions).toHaveBeenCalled();
  });

  it("verify rejects smart wallet transaction with multiple matching transfers", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildSmartWalletPayload(
      feePayer.address,
      unknownProgram.address,
      payer.address,
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address },
      } as never,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrSmartWalletMultipleMatchingTransfers);
  });

  it("verify rejects smart wallet transaction when fee payer is transfer authority", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    // Fee payer NOT in instruction accounts (passes isolation check),
    // but simulation returns fee payer as the transfer authority (caught at step 4)
    const txBase64 = await buildSmartWalletPayload(
      feePayer.address,
      unknownProgram.address,
      payer.address,
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                feePayer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          maxTimeoutSeconds: 3600,
          extra: { feePayer: feePayer.address },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address },
      } as never,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
    );
  });

  it("verify rejects smart wallet transaction when program is not in allowlist", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const txBase64 = await buildSmartWalletPayload(
      feePayer.address,
      unknownProgram.address,
      payer.address,
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [],
      }),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
    };

    // Allowlist does NOT include unknownProgram
    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: ["SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          extra: { feePayer: feePayer.address },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address },
      } as never,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain(Errors.ErrSmartWalletProgramNotAllowed);
  });

  it("verify accepts smart wallet transaction when required memo is present and matches", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildSmartWalletPayloadWithMemos(
      feePayer.address,
      unknownProgram.address,
      payer.address,
      ["order-12345"],
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          extra: { feePayer: feePayer.address, memo: "order-12345" },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address, memo: "order-12345" },
      } as never,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(payer.address);
  });

  it("verify rejects smart wallet transaction when required memo is missing", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildSmartWalletPayloadWithMemos(
      feePayer.address,
      unknownProgram.address,
      payer.address,
      [],
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          extra: { feePayer: feePayer.address, memo: "order-12345" },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address, memo: "order-12345" },
      } as never,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_memo_count");
  });

  it("verify rejects smart wallet transaction when required memo content does not match", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildSmartWalletPayloadWithMemos(
      feePayer.address,
      unknownProgram.address,
      payer.address,
      ["wrong-order"],
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          extra: { feePayer: feePayer.address, memo: "order-12345" },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address, memo: "order-12345" },
      } as never,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_memo_mismatch");
  });

  it("verify rejects smart wallet transaction when multiple memo instructions are present", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildSmartWalletPayloadWithMemos(
      feePayer.address,
      unknownProgram.address,
      payer.address,
      ["order-12345", "order-12345"],
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const result = await scheme.verify(
      {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: SOLANA_DEVNET_CAIP2,
          asset: USDC_DEVNET_ADDRESS,
          amount: "100000",
          payTo: payTo.address,
          extra: { feePayer: feePayer.address, memo: "order-12345" },
        },
        payload: { transaction: txBase64 },
      } as never,
      {
        scheme: "exact",
        network: SOLANA_DEVNET_CAIP2,
        asset: USDC_DEVNET_ADDRESS,
        amount: "100000",
        payTo: payTo.address,
        maxTimeoutSeconds: 3600,
        extra: { feePayer: feePayer.address, memo: "order-12345" },
      } as never,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_memo_count");
  });

  it("verify rejects ApproveChecked (discriminator 13) as a TransferChecked lookalike", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const source = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildStaticTransferPayload({
      feePayer: feePayer.address,
      source: source.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      destination: expectedAta,
      authority: payer,
      amount: 100000n,
      discriminator: 13, // ApproveChecked
    });

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi
        .fn()
        .mockResolvedValue({ innerInstructions: [] }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never);

    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_no_transfer_instruction");
  });

  it("verify does NOT fall through to Path 2 on a semantic (amount mismatch) failure", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const source = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    // Structurally valid tx, but the on-chain transfer amount (1) does not match
    // the required amount (100000). Path 1 must reject with amount_mismatch.
    const txBase64 = await buildStaticTransferPayload({
      feePayer: feePayer.address,
      source: source.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      destination: expectedAta,
      authority: payer,
      amount: 1n,
    });

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi
        .fn()
        .mockResolvedValue({ innerInstructions: [] }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
    });

    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    // Must surface the real Path-1 reason, NOT a misleading smart_wallet_* code.
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_amount_mismatch");
    // Path 2 must never have run for a semantic failure.
    expect(mockSigner.simulateTransactionWithInnerInstructions).not.toHaveBeenCalled();
  });

  it("verify DOES fall through to Path 2 on a layout (instruction count) failure", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    // 3-instruction tx whose third instruction is an unknown program: Path 1
    // rejects with a layout reason (no_transfer_instruction), which IS recoverable.
    const txBase64 = await buildSmartWalletPayload(
      feePayer.address,
      unknownProgram.address,
      payer.address,
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                expectedAta,
                payer.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
      smartWalletAllowedPrograms: [unknownProgram.address],
    });

    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    // Layout failure is recoverable: Path 2 runs and validates via simulation.
    expect(result.isValid).toBe(true);
    expect(mockSigner.simulateTransactionWithInnerInstructions).toHaveBeenCalled();
  });

  it("accepts a Phantom transaction that brackets the transfer with Lighthouse guards on Path 1", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const source = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    // Current Phantom shape (see #2097): three Lighthouse guards inserted
    // before the TransferChecked and a fourth appended after it.
    const guard = (size: number): IInstruction => ({
      programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address,
      data: new Uint8Array(size).fill(1),
    });
    const txBase64 = await buildStaticTransferPayload({
      feePayer: feePayer.address,
      source: source.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      destination: expectedAta,
      authority: payer,
      amount: 100000n,
      leading: [guard(17), guard(52), guard(16)],
      trailing: [guard(27)],
    });

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi
        .fn()
        .mockResolvedValue({ innerInstructions: [] }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
    });

    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 60,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(payer.address);
    // Path 1 accepted the shape; no simulation fallback was needed.
    expect(mockSigner.simulateTransactionWithInnerInstructions).not.toHaveBeenCalled();
  });

  it("rejects more Lighthouse guards than Path 1 tolerates", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const source = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const guard: IInstruction = {
      programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address,
      data: new Uint8Array([0]),
    };
    const txBase64 = await buildStaticTransferPayload({
      feePayer: feePayer.address,
      source: source.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      destination: expectedAta,
      authority: payer,
      amount: 100000n,
      leading: [guard, guard, guard],
      trailing: [guard, guard],
    });

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi
        .fn()
        .mockResolvedValue({ innerInstructions: [] }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {});

    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 60,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    expect(result.isValid).toBe(false);
  });

  it("accepts a 7-instruction Phantom transaction (3 Lighthouse) on Path 1 without Path 2", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const source = await generateKeyPairSigner();

    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    // Phantom shape: the correct positional transfer plus three wallet-injected
    // Lighthouse assertions in the optional tail = 7 instructions total (see #2097).
    const lighthouse: IInstruction = {
      programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address,
      data: new Uint8Array([0]),
    };
    const txBase64 = await buildStaticTransferPayload({
      feePayer: feePayer.address,
      source: source.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      destination: expectedAta,
      authority: payer,
      amount: 100000n,
      trailing: [lighthouse, lighthouse, lighthouse],
    });

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi
        .fn()
        .mockResolvedValue({ innerInstructions: [] }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
    });

    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    // Path 1 accepts the raised instruction count; Path 2 simulation is never reached.
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(payer.address);
    expect(mockSigner.simulateTransactionWithInnerInstructions).not.toHaveBeenCalled();
  });
});

describe("ExactSvmScheme pending-settlement reconciliation for smart wallet settlements", () => {
  beforeEach(() => {
    mockAtaMap = {};
    vi.clearAllMocks();
  });

  it("cache-hit reconciliation runs verifyPostSettlement and rejects an unconfirmed transfer (TOCTOU defense)", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");
    const { InMemoryPendingSettlementStore } = await import("@x402/core/facilitator");
    const { decodeTransactionFromPayload, transactionMessageHash } = await import(
      "../../src/utils"
    );

    const feePayer = await generateKeyPairSigner();
    const unknownProgram = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();

    // A non-static-transfer-shaped transaction (unknown program at index 2), so
    // the reconciliation path's cheap `hasStaticTransferLayout` re-derivation
    // correctly infers this was originally a Path-2 (smart wallet) settlement.
    const txBase64 = await buildSmartWalletPayload(
      feePayer.address,
      unknownProgram.address,
      payer.address,
    );

    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };
    const txKey = transactionMessageHash(decodeTransactionFromPayload({ transaction: txBase64 }));
    const store = new InMemoryPendingSettlementStore();
    await store.set(txKey, "CachedSmartWalletSig1111111111111111111111");

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      getSigner: vi.fn().mockReturnValue(feePayer),
      signTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
      // No matching TransferChecked found post-confirmation, and no balance
      // snapshot is available during reconciliation: verifyPostSettlement
      // must report unverified rather than the reconciliation path skipping
      // the check entirely.
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi.fn(),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      pendingSettlementStore: store,
      enableSmartWalletVerification: true,
    });

    const result = await scheme.settle(
      {
        x402Version: 2,
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    expect(result.success).toBe(false);
    expect(result.errorReason).toBe("post_settlement_transfer_not_confirmed");
    expect(mockSigner.confirmTransaction).toHaveBeenCalledWith(
      "CachedSmartWalletSig1111111111111111111111",
      SOLANA_DEVNET_CAIP2,
    );
    // Reconciliation must not re-verify/re-sign/re-send.
    expect(mockSigner.signTransaction).not.toHaveBeenCalled();
    expect(mockSigner.sendTransaction).not.toHaveBeenCalled();
  });

  it("verify never calls signTransaction and simulates the unsigned payload", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const source = await generateKeyPairSigner();
    const payer = await generateKeyPairSigner();
    const expectedAta = payTo.address;
    mockAtaMap[payTo.address] = expectedAta;

    const txBase64 = await buildStaticTransferPayload({
      feePayer: feePayer.address,
      source: source.address,
      mint: USDC_DEVNET_ADDRESS as Address,
      destination: expectedAta,
      authority: payer,
      amount: 100000n,
    });

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      signTransaction: vi.fn().mockResolvedValue(txBase64),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({}),
      simulateTransactionWithInnerInstructions: vi
        .fn()
        .mockResolvedValue({ innerInstructions: [] }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never);
    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    expect(result.isValid).toBe(true);
    expect(mockSigner.signTransaction).not.toHaveBeenCalled();
    expect(mockSigner.simulateTransaction).toHaveBeenCalledWith(txBase64, SOLANA_DEVNET_CAIP2);
  });

  it("ALT transactions reach Path 2 instead of throwing", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const feePayer = await generateKeyPairSigner();
    const altAddr = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    mockAtaMap[payTo.address] = payTo.address;

    const compiled = {
      version: 0 as const,
      header: {
        numSignerAccounts: 1,
        numReadonlySignerAccounts: 0,
        numReadonlyNonSignerAccounts: 1,
      },
      staticAccounts: [feePayer.address, SWIG_PROGRAM],
      lifetimeToken: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      instructions: [
        {
          programAddressIndex: 1,
          accountIndices: [2],
          data: new Uint8Array([0]),
        },
      ],
      addressTableLookups: [
        {
          lookupTableAddress: altAddr.address,
          writableIndexes: [0],
          readonlyIndexes: [],
        },
      ],
    };

    const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);
    const txBase64 = await encodeSignedTransaction(
      messageBytes,
      [],
      placeholderFeePayerSignature(feePayer.address),
    );

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      signTransaction: vi.fn(),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
      getConfirmedTransactionInnerInstructions: vi.fn().mockResolvedValue(null),
      getTokenAccountBalance: vi.fn().mockResolvedValue(null),
      fetchAddressLookupTables: vi.fn().mockResolvedValue({
        [altAddr.address]: [payTo.address],
      }),
      simulateTransactionWithInnerInstructions: vi.fn().mockResolvedValue({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              buildMockInnerTransfer(
                TOKEN_PROGRAM,
                USDC_DEVNET_ADDRESS,
                payTo.address as string,
                payTo.address as string,
                "100000",
              ),
            ],
          },
        ],
      }),
    };

    const scheme = new ExactSvmScheme(mockSigner as never, undefined, {
      enableSmartWalletVerification: true,
    });
    const accepted = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const result = await scheme.verify(
      {
        x402Version: 2,
        resource: { url: "http://test.com", description: "test", mimeType: "application/json" },
        accepted,
        payload: { transaction: txBase64 },
      } as never,
      accepted as never,
    );

    expect(result.isValid).toBe(true);
    expect(mockSigner.simulateTransactionWithInnerInstructions).toHaveBeenCalled();
    expect(mockSigner.fetchAddressLookupTables).toHaveBeenCalled();
  });
});
