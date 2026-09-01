import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  appendTransactionMessageInstruction,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type V1TransactionConfig,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  encodeSignedTransaction,
  placeholderFeePayerSignature,
  type MessageSigner,
} from "./helpers/signedTransaction";
import { validateComputeBudgetLimits } from "../../src/exact/facilitator/smartWalletVerification";
import { verifyOpenTransaction } from "../../src/payment-channels/open";
import {
  checkV1TransactionConfig,
  decodeTransactionFromPayload,
  getTokenPayerFromTransaction,
} from "../../src/utils";
import { MEMO_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { PaymentPayloadV1, PaymentRequirementsV1 } from "@x402/core/types/v1";

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;

const FAKE_BLOCKHASH = {
  blockhash: "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF" as Blockhash,
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

function transferCheckedInstruction(args: {
  source: Address;
  mint: Address;
  destination: Address;
  authority: Address;
  amount: bigint;
}): Instruction {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked discriminator
  new DataView(data.buffer).setBigUint64(1, args.amount, true);
  data[9] = 6; // decimals
  return {
    programAddress: TOKEN_PROGRAM_ADDRESS,
    accounts: [
      { address: args.source, role: 1 },
      { address: args.mint, role: 0 },
      { address: args.destination, role: 1 },
      { address: args.authority, role: 3 },
    ],
    data,
  } as Instruction;
}

async function buildV1Transaction(args: {
  feePayer: Address;
  instructions: Instruction[];
  config?: V1TransactionConfig;
  signers?: readonly MessageSigner[];
}): Promise<string> {
  let msg = pipe(
    createTransactionMessage({ version: 1 }),
    m => setTransactionMessageFeePayer(args.feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
  );
  if (args.config) {
    msg = setTransactionMessageConfig(args.config, msg);
  }
  let withInstructions = msg;
  for (const ix of args.instructions) {
    withInstructions = appendTransactionMessageInstruction(ix, withInstructions);
  }
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
    compileTransactionMessage(withInstructions),
  );
  return encodeSignedTransaction(
    messageBytes,
    args.signers ?? [],
    placeholderFeePayerSignature(args.feePayer),
  );
}

describe("checkV1TransactionConfig", () => {
  it("requires a compute unit limit", () => {
    expect(checkV1TransactionConfig(undefined, { maxPriorityFeeMicroLamports: 5_000_000 })).toBe(
      "compute_unit_limit_missing",
    );
    expect(
      checkV1TransactionConfig(
        { priorityFeeLamports: 1n },
        { maxPriorityFeeMicroLamports: 5_000_000 },
      ),
    ).toBe("compute_unit_limit_missing");
    expect(
      checkV1TransactionConfig({ computeUnitLimit: 0 }, { maxPriorityFeeMicroLamports: 5_000_000 }),
    ).toBe("compute_unit_limit_missing");
  });

  it("enforces the compute unit cap when configured", () => {
    expect(
      checkV1TransactionConfig(
        { computeUnitLimit: 20_001 },
        { maxComputeUnits: 20_000, maxPriorityFeeMicroLamports: 5_000_000 },
      ),
    ).toBe("compute_unit_limit_too_high");
    expect(
      checkV1TransactionConfig(
        { computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 65_536 },
        { maxComputeUnits: 20_000, maxPriorityFeeMicroLamports: 5_000_000 },
      ),
    ).toBeNull();
  });

  it("requires a loaded accounts data size limit", () => {
    expect(
      checkV1TransactionConfig({ computeUnitLimit: 20_000 }, { maxPriorityFeeMicroLamports: 0 }),
    ).toBe("loaded_accounts_data_size_limit_missing");
    expect(
      checkV1TransactionConfig(
        { computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 0 },
        { maxPriorityFeeMicroLamports: 0 },
      ),
    ).toBe("loaded_accounts_data_size_limit_missing");
  });

  it("normalizes the total-lamport priority fee against the per-CU cap", () => {
    // 5,000,000 micro-lamports/CU over 20,000 CUs = 100,000 lamports allowed.
    const limits = { maxPriorityFeeMicroLamports: 5_000_000 };
    expect(
      checkV1TransactionConfig(
        {
          computeUnitLimit: 20_000,
          loadedAccountsDataSizeLimit: 65_536,
          priorityFeeLamports: 100_000n,
        },
        limits,
      ),
    ).toBeNull();
    expect(
      checkV1TransactionConfig(
        {
          computeUnitLimit: 20_000,
          loadedAccountsDataSizeLimit: 65_536,
          priorityFeeLamports: 100_001n,
        },
        limits,
      ),
    ).toBe("priority_fee_too_high");
  });

  it("accepts a config with no priority fee", () => {
    expect(
      checkV1TransactionConfig(
        { computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 65_536 },
        { maxPriorityFeeMicroLamports: 0 },
      ),
    ).toBeNull();
  });
});

describe("getTokenPayerFromTransaction on version 1 transactions", () => {
  it("extracts the transfer authority", async () => {
    const [feePayer, source, destination, authority] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const txBase64 = await buildV1Transaction({
      feePayer: feePayer.address,
      config: { computeUnitLimit: 20_000 },
      instructions: [
        transferCheckedInstruction({
          source: source.address,
          mint: USDC_DEVNET_ADDRESS as Address,
          destination: destination.address,
          authority: authority.address,
          amount: 100_000n,
        }),
      ],
      signers: [authority],
    });
    const transaction = decodeTransactionFromPayload({ transaction: txBase64 });
    expect(getTokenPayerFromTransaction(transaction)).toBe(authority.address);
  });
});

describe("ExactSvmScheme static path with version 1 transactions", () => {
  beforeEach(() => {
    mockAtaMap = {};
    vi.clearAllMocks();
  });

  async function setup(options?: Record<string, unknown>) {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");
    const [feePayer, source, payTo, authority] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const destinationAta = (await generateKeyPairSigner()).address;
    mockAtaMap[payTo.address] = destinationAta;

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      signTransaction: vi.fn().mockImplementation(async (tx: string) => tx),
      simulateTransaction: vi.fn().mockResolvedValue(undefined),
      sendTransaction: vi.fn().mockResolvedValue("sig"),
      confirmTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const scheme = new ExactSvmScheme(mockSigner as never, undefined, options as never);

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    } as PaymentRequirements;

    const buildPayload = async (
      config: V1TransactionConfig | undefined,
      trailing: Instruction[] = [],
    ): Promise<PaymentPayload> => {
      const transaction = await buildV1Transaction({
        feePayer: feePayer.address,
        config,
        instructions: [
          transferCheckedInstruction({
            source: source.address,
            mint: USDC_DEVNET_ADDRESS as Address,
            destination: destinationAta,
            authority: authority.address,
            amount: 100_000n,
          }),
          ...trailing,
        ],
        signers: [authority],
      });
      return {
        x402Version: 2,
        accepted: requirements,
        payload: { transaction },
      } as unknown as PaymentPayload;
    };

    return { scheme, requirements, buildPayload, authority };
  }

  it("accepts a valid version 1 transfer and reads limits from message.config", async () => {
    const { scheme, requirements, buildPayload, authority } = await setup();
    const result = await scheme.verify(
      await buildPayload({
        computeUnitLimit: 20_000,
        loadedAccountsDataSizeLimit: 65_536,
        priorityFeeLamports: 100_000n,
      }),
      requirements,
    );
    expect(result.invalidReason).toBeUndefined();
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(authority.address);
  });

  it("accepts a version 1 transfer with a trailing memo", async () => {
    const { scheme, requirements, buildPayload } = await setup();
    const memoIx = {
      programAddress: MEMO_PROGRAM_ADDRESS as Address,
      data: new TextEncoder().encode("unique-nonce"),
    } as Instruction;
    const result = await scheme.verify(
      await buildPayload({ computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 65_536 }, [
        memoIx,
      ]),
      requirements,
    );
    expect(result.isValid).toBe(true);
  });

  it("rejects a version 1 transaction with no compute unit limit", async () => {
    const { scheme, requirements, buildPayload } = await setup();
    const result = await scheme.verify(await buildPayload(undefined), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_config_compute_limit_missing",
    );
  });

  it("rejects a version 1 transaction with no loaded accounts data size limit", async () => {
    const { scheme, requirements, buildPayload } = await setup();
    const result = await scheme.verify(
      await buildPayload({ computeUnitLimit: 20_000 }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_config_loaded_accounts_data_size_limit_missing",
    );
  });

  it("rejects a version 1 compute unit limit above the operator cap", async () => {
    const { scheme, requirements, buildPayload } = await setup({ maxComputeUnits: 20_000 });
    const result = await scheme.verify(
      await buildPayload({ computeUnitLimit: 400_000 }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_config_compute_limit_too_high",
    );
  });

  it("rejects a version 1 priority fee above the normalized cap", async () => {
    // Default cap is 5,000,000 micro-lamports/CU; over 20,000 CUs that allows
    // at most 100,000 lamports of total priority fee.
    const { scheme, requirements, buildPayload } = await setup();
    const result = await scheme.verify(
      await buildPayload({
        computeUnitLimit: 20_000,
        loadedAccountsDataSizeLimit: 65_536,
        priorityFeeLamports: 100_001n,
      }),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(
      "invalid_exact_svm_payload_transaction_config_priority_fee_too_high",
    );
  });

  it("rejects a ComputeBudget instruction inside a version 1 transaction", async () => {
    const { scheme, requirements, buildPayload } = await setup();
    const computeBudgetIx = {
      programAddress: COMPUTE_BUDGET_PROGRAM,
      data: new Uint8Array([2, 160, 134, 1, 0]),
    } as Instruction;
    const result = await scheme.verify(
      await buildPayload({ computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 65_536 }, [
        computeBudgetIx,
      ]),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_svm_payload_unknown_optional_instruction");
  });
});

describe("validateComputeBudgetLimits with version 1 transactions", () => {
  async function buildV1(config: V1TransactionConfig | undefined, instructions: Instruction[]) {
    const feePayer = await generateKeyPairSigner();
    const txBase64 = await buildV1Transaction({
      feePayer: feePayer.address,
      config,
      instructions,
    });
    return decodeTransactionFromPayload({ transaction: txBase64 });
  }

  const noopIx = {
    programAddress: MEMO_PROGRAM_ADDRESS as Address,
    data: new Uint8Array([1]),
  } as Instruction;

  it("accepts a config within the caps", async () => {
    const tx = await buildV1(
      {
        computeUnitLimit: 400_000,
        loadedAccountsDataSizeLimit: 65_536,
        priorityFeeLamports: 20_000n,
      },
      [noopIx],
    );
    expect(() => validateComputeBudgetLimits(tx)).not.toThrow();
  });

  it("rejects a missing compute unit limit", async () => {
    const tx = await buildV1(undefined, [noopIx]);
    expect(() => validateComputeBudgetLimits(tx)).toThrow(
      /smart_wallet_compute_unit_limit_missing/,
    );
  });

  it("rejects a missing loaded accounts data size limit", async () => {
    const tx = await buildV1({ computeUnitLimit: 400_000 }, [noopIx]);
    expect(() => validateComputeBudgetLimits(tx)).toThrow(
      /smart_wallet_loaded_accounts_data_size_limit_missing/,
    );
  });

  it("rejects a compute unit limit above the cap", async () => {
    const tx = await buildV1({ computeUnitLimit: 500_000 }, [noopIx]);
    expect(() => validateComputeBudgetLimits(tx)).toThrow(/smart_wallet_compute_units_too_high/);
  });

  it("rejects a priority fee above the normalized cap", async () => {
    // Default caps: 50,000 micro-lamports/CU over 400,000 CUs = 20,000 lamports.
    const tx = await buildV1(
      {
        computeUnitLimit: 400_000,
        loadedAccountsDataSizeLimit: 65_536,
        priorityFeeLamports: 20_001n,
      },
      [noopIx],
    );
    expect(() => validateComputeBudgetLimits(tx)).toThrow(/smart_wallet_priority_fee_too_high/);
  });

  it("rejects ComputeBudget instructions in a version 1 transaction", async () => {
    const computeBudgetIx = {
      programAddress: COMPUTE_BUDGET_PROGRAM,
      data: new Uint8Array([2, 160, 134, 1, 0]),
    } as Instruction;
    const tx = await buildV1({ computeUnitLimit: 400_000 }, [computeBudgetIx]);
    expect(() => validateComputeBudgetLimits(tx)).toThrow(
      /smart_wallet_unsupported_compute_budget_instruction/,
    );
  });
});

describe("version 1 gates in schemes without config support", () => {
  it("verifyOpenTransaction rejects a version 1 open transaction", async () => {
    const [feePayer, payer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    const txBase64 = await buildV1Transaction({
      feePayer: feePayer.address,
      config: { computeUnitLimit: 200_000 },
      instructions: [
        {
          programAddress: MEMO_PROGRAM_ADDRESS as Address,
          data: new Uint8Array([1]),
        } as Instruction,
      ],
    });
    await expect(
      verifyOpenTransaction(txBase64, {
        authorizedSigner: feePayer.address,
        feePayer: feePayer.address,
        from: payer.address,
        mint: USDC_DEVNET_ADDRESS,
        tokenProgram: TOKEN_PROGRAM_ADDRESS.toString(),
        maxCap: 1n,
        payee: feePayer.address,
        withdrawDelay: 0,
        openSlot: 0n,
      }),
    ).rejects.toThrow(/unsupported transaction version 1/);
  });

  it("ExactSvmSchemeV1 rejects a version 1 transaction", async () => {
    const { ExactSvmSchemeV1 } = await import("../../src/exact/v1/facilitator/scheme");
    const [feePayer, authority, source, destination] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const transaction = await buildV1Transaction({
      feePayer: feePayer.address,
      config: { computeUnitLimit: 20_000 },
      instructions: [
        transferCheckedInstruction({
          source: source.address,
          mint: USDC_DEVNET_ADDRESS as Address,
          destination: destination.address,
          authority: authority.address,
          amount: 100_000n,
        }),
      ],
      signers: [authority],
    });

    const mockSigner = {
      getAddresses: vi.fn().mockReturnValue([feePayer.address]),
      signTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      confirmTransaction: vi.fn(),
    };
    const scheme = new ExactSvmSchemeV1(mockSigner as never);

    const requirements: PaymentRequirementsV1 = {
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
    } as PaymentRequirementsV1;

    const result = await scheme.verify(
      {
        x402Version: 1,
        scheme: "exact",
        network: "solana-devnet",
        payload: { transaction },
      } as unknown as PaymentPayloadV1,
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_transaction_version");
  });
});
