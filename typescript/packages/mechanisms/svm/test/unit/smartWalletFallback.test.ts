import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
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
  USDC_DEVNET_ADDRESS,
} from "../../src/constants";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;
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

  const txWithSig = {
    messageBytes: tx.messageBytes,
    signatures: { [feePayer]: new Uint8Array(64) } as Record<string, Uint8Array>,
  };

  return getBase64EncodedWireTransaction(txWithSig as never);
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

  const txWithSig = {
    messageBytes: tx.messageBytes,
    signatures: { [feePayer]: new Uint8Array(64) } as Record<string, Uint8Array>,
  };

  return getBase64EncodedWireTransaction(txWithSig as never);
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
  authority: Address;
  amount: bigint;
  trailing?: IInstruction[];
}) {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked discriminator
  new DataView(data.buffer).setBigUint64(1, args.amount, true);
  data[9] = 6; // decimals

  const tx = await buildTransaction(args.feePayer, [
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([2, 160, 134, 1, 0]) },
    { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([3, 16, 39, 0, 0, 0, 0, 0, 0]) },
    {
      programAddress: TOKEN_PROGRAM_ADDRESS,
      accounts: [
        { address: args.source, role: 1 },
        { address: args.mint, role: 0 },
        { address: args.destination, role: 1 },
        // Authority is a signer (role 3), so the compiled message requires its
        // signature slot in addition to the fee payer's.
        { address: args.authority, role: 3 },
      ],
      data,
    },
    ...(args.trailing ?? []),
  ]);

  const txWithSig = {
    messageBytes: tx.messageBytes,
    signatures: {
      [args.feePayer]: new Uint8Array(64),
      [args.authority]: new Uint8Array(64),
    } as Record<string, Uint8Array>,
  };

  return getBase64EncodedWireTransaction(txWithSig as never);
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
    expect(result.invalidReason).toBe("smart_wallet_multiple_matching_transfers");
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
    expect(result.invalidReason).toContain("smart_wallet_program_not_allowed");
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
      authority: payer.address,
      amount: 1n,
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
      authority: payer.address,
      amount: 100000n,
      trailing: [lighthouse, lighthouse, lighthouse],
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
