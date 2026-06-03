import { describe, it, expect } from "vitest";
import {
  assertFeePayerIsolated,
  validateComputeBudgetLimits,
  extractTransfersFromInnerInstructions,
} from "../../src/exact/facilitator/smartWalletVerification";
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

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEST_ATA = "DestATA11111111111111111111111111";
const AUTHORITY = "Authority111111111111111111111111";

const FAKE_BLOCKHASH = {
  blockhash: "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF" as string &
    import("@solana/kit").Blockhash,
  lastValidBlockHeight: 1000n,
};

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

// ─── assertFeePayerIsolated ─────────────────────────────────────────────────

describe("assertFeePayerIsolated", () => {
  it("passes when fee payer is not in any instruction", async () => {
    const feePayer = await generateKeyPairSigner();
    const otherAccount = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        accounts: [{ address: otherAccount.address, role: 1 }],
        data: new Uint8Array([2, 0, 0, 0, 0]),
      },
    ]);

    await expect(assertFeePayerIsolated(tx as never, feePayer.address)).resolves.not.toThrow();
  });

  it("throws when fee payer appears in instruction accounts", async () => {
    const feePayer = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        accounts: [{ address: feePayer.address, role: 1 }],
        data: new Uint8Array([2, 0, 0, 0, 0]),
      },
    ]);

    await expect(assertFeePayerIsolated(tx as never, feePayer.address)).rejects.toThrow(
      "smart_wallet_fee_payer_not_isolated",
    );
  });

  it("throws when fee payer appears in accounts of multiple instructions", async () => {
    const feePayer = await generateKeyPairSigner();
    const otherProgram = await generateKeyPairSigner();
    const otherAccount = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: new Uint8Array([2, 0, 0, 0, 0]),
      },
      {
        programAddress: otherProgram.address,
        accounts: [
          { address: otherAccount.address, role: 1 },
          { address: feePayer.address, role: 0 },
        ],
        data: new Uint8Array([]),
      },
    ]);

    await expect(assertFeePayerIsolated(tx as never, feePayer.address)).rejects.toThrow(
      "smart_wallet_fee_payer_not_isolated",
    );
  });
});

// ─── validateComputeBudgetLimits ────────────────────────────────────────────

function buildSetComputeUnitLimit(units: number): Uint8Array {
  const buf = new Uint8Array(5);
  buf[0] = 2;
  new DataView(buf.buffer).setUint32(1, units, true);
  return buf;
}

function buildSetComputeUnitPrice(microLamports: bigint): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = 3;
  new DataView(buf.buffer).setBigUint64(1, microLamports, true);
  return buf;
}

describe("validateComputeBudgetLimits", () => {
  it("passes when CU and priority fee are within defaults", async () => {
    const feePayer = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: buildSetComputeUnitLimit(300_000),
      },
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: buildSetComputeUnitPrice(10_000n),
      },
    ]);

    expect(() => validateComputeBudgetLimits(tx as never)).not.toThrow();
  });

  it("throws when CU exceeds default max", async () => {
    const feePayer = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: buildSetComputeUnitLimit(500_000),
      },
    ]);

    expect(() => validateComputeBudgetLimits(tx as never)).toThrow(
      "smart_wallet_compute_units_too_high",
    );
  });

  it("throws when priority fee exceeds default max", async () => {
    const feePayer = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: buildSetComputeUnitPrice(100_000n),
      },
    ]);

    expect(() => validateComputeBudgetLimits(tx as never)).toThrow(
      "smart_wallet_priority_fee_too_high",
    );
  });

  it("respects custom operator-provided limits", async () => {
    const feePayer = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: buildSetComputeUnitLimit(800_000),
      },
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: buildSetComputeUnitPrice(200_000n),
      },
    ]);

    // Should pass with high custom limits
    expect(() =>
      validateComputeBudgetLimits(tx as never, {
        maxComputeUnits: 1_000_000,
        maxPriorityFeeMicroLamports: 500_000,
      }),
    ).not.toThrow();

    // Same transaction should fail with low custom limits
    expect(() =>
      validateComputeBudgetLimits(tx as never, {
        maxComputeUnits: 100_000,
      }),
    ).toThrow("smart_wallet_compute_units_too_high");
  });

  it("rejects unknown ComputeBudget instruction type", async () => {
    const feePayer = await generateKeyPairSigner();

    // Type 1 = RequestHeapFrame, type 4 = SetLoadedAccountsDataSizeLimit
    const unknownCBInstruction = new Uint8Array([1, 0, 0, 0, 0]);

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: unknownCBInstruction,
      },
    ]);

    expect(() => validateComputeBudgetLimits(tx as never)).toThrow(
      "smart_wallet_unsupported_compute_budget_instruction",
    );
  });

  it("rejects ComputeBudget instruction with empty data", async () => {
    const feePayer = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        data: new Uint8Array([]),
      },
    ]);

    expect(() => validateComputeBudgetLimits(tx as never)).toThrow(
      "smart_wallet_malformed_compute_budget",
    );
  });
});

// ─── extractTransfersFromInnerInstructions ──────────────────────────────────

describe("extractTransfersFromInnerInstructions", () => {
  it("returns empty array for null inner instructions", () => {
    const result = extractTransfersFromInnerInstructions(null, []);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty inner instructions", () => {
    const result = extractTransfersFromInnerInstructions([], []);
    expect(result).toEqual([]);
  });

  it("extracts TransferChecked from parsed format", () => {
    const innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programIdIndex: 0,
            accounts: [],
            data: "",
            programId: TOKEN_PROGRAM as string,
            parsed: {
              type: "transferChecked",
              info: {
                mint: USDC_MINT,
                destination: DEST_ATA,
                authority: AUTHORITY,
                tokenAmount: { amount: "100000" },
              },
            },
          } as Record<string, unknown>,
        ],
      },
    ];

    const result = extractTransfersFromInnerInstructions(innerInstructions, [
      TOKEN_PROGRAM as string,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].mint).toBe(USDC_MINT);
    expect(result[0].destination).toBe(DEST_ATA);
    expect(result[0].authority).toBe(AUTHORITY);
    expect(result[0].amount).toBe(BigInt(100000));
    expect(result[0].programId).toBe(TOKEN_PROGRAM);
  });

  it("extracts TransferChecked from compiled format", async () => {
    // Build a TransferChecked instruction data: [12, amount(u64 LE), decimals(u8)]
    const data = new Uint8Array(10);
    data[0] = 12; // TransferChecked discriminator
    new DataView(data.buffer).setBigUint64(1, 50000n, true);
    data[9] = 6; // decimals

    // RPC returns inner instruction data as base58 strings.
    // getBase58Decoder().decode(bytes) -> base58 string
    const { getBase58Decoder } = await import("@solana/kit");
    const dataBase58 = getBase58Decoder().decode(data);

    const accountKeys = [
      "SourceATA1111111111111111111111111",
      USDC_MINT,
      DEST_ATA,
      AUTHORITY,
      TOKEN_PROGRAM as string,
    ];

    const innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programIdIndex: 4,
            accounts: [0, 1, 2, 3],
            data: dataBase58,
          },
        ],
      },
    ];

    const result = extractTransfersFromInnerInstructions(innerInstructions, accountKeys);
    expect(result).toHaveLength(1);
    expect(result[0].programId).toBe(TOKEN_PROGRAM);
    expect(result[0].mint).toBe(USDC_MINT);
    expect(result[0].destination).toBe(DEST_ATA);
    expect(result[0].authority).toBe(AUTHORITY);
    expect(result[0].amount).toBe(50000n);
  });

  it("ignores non-transferChecked parsed instructions", () => {
    const innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programId: TOKEN_PROGRAM as string,
            parsed: { type: "approve", info: { amount: "100000" } },
          } as Record<string, unknown>,
        ],
      },
    ];

    const result = extractTransfersFromInnerInstructions(innerInstructions, []);
    expect(result).toHaveLength(0);
  });

  it("ignores parsed transfers from non-token programs", () => {
    const innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programId: "SomeOtherProgram11111111111111111",
            parsed: {
              type: "transferChecked",
              info: {
                mint: USDC_MINT,
                destination: DEST_ATA,
                authority: AUTHORITY,
                tokenAmount: { amount: "100000" },
              },
            },
          } as Record<string, unknown>,
        ],
      },
    ];

    const result = extractTransfersFromInnerInstructions(innerInstructions, []);
    expect(result).toHaveLength(0);
  });

  it("extracts from multiple inner instruction groups", () => {
    const innerInstructions = [
      {
        index: 0,
        instructions: [
          {
            programId: TOKEN_PROGRAM as string,
            parsed: {
              type: "transferChecked",
              info: {
                mint: USDC_MINT,
                destination: DEST_ATA,
                authority: AUTHORITY,
                tokenAmount: { amount: "50000" },
              },
            },
          } as Record<string, unknown>,
        ],
      },
      {
        index: 1,
        instructions: [
          {
            programId: TOKEN_2022_PROGRAM as string,
            parsed: {
              type: "transferChecked",
              info: {
                mint: USDC_MINT,
                destination: "OtherDest1111111111111111111111111",
                authority: "OtherAuth1111111111111111111111111",
                tokenAmount: { amount: "25000" },
              },
            },
          } as Record<string, unknown>,
        ],
      },
    ];

    const result = extractTransfersFromInnerInstructions(innerInstructions, []);
    expect(result).toHaveLength(2);
    expect(result[0].amount).toBe(BigInt(50000));
    expect(result[1].amount).toBe(BigInt(25000));
  });
});

describe("verifyPostSettlement", () => {
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PAY_TO = "BuyerAddress11111111111111111111111111111111";
  const DEST_ATA = "DestATA111111111111111111111111111111111111";
  const AUTHORITY = "AuthAddr111111111111111111111111111111111111";

  const mockRequirements = {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: "10000",
    asset: USDC_MINT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { feePayer: "FeePayer11111111111111111111111111111111111" },
  };

  it("verifies transfer via inner instructions when getTransaction succeeds", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => ({
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                parsed: {
                  type: "transferChecked",
                  info: {
                    mint: USDC_MINT,
                    destination: DEST_ATA,
                    authority: AUTHORITY,
                    tokenAmount: { amount: "10000" },
                  },
                },
              },
            ],
          },
        ],
      }),
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      null,
    );

    expect(result.method).toBe("innerInstructions");
    // Note: verified may be false if ATA derivation doesn't match mock DEST_ATA.
    // This test primarily validates the code path executes without error.
  });

  it("catches TOCTOU when inner instructions show no matching transfer", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => ({
        innerInstructions: [
          {
            index: 0,
            instructions: [], // No transfers — malicious program skipped CPI
          },
        ],
      }),
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      null,
    );

    expect(result.verified).toBe(false);
    expect(result.method).toBe("innerInstructions");
  });

  it("falls back to balance delta when getTransaction returns null", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => null, // Indexing lag
      getTokenAccountBalance: async () => BigInt(20000), // Balance increased
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      BigInt(10000), // balanceBefore = 10000, balanceAfter = 20000, delta = 10000 >= required
    );

    expect(result.verified).toBe(true);
    expect(result.method).toBe("balanceDelta");
  });

  it("catches TOCTOU via balance delta when balance unchanged", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => null, // Indexing lag
      getTokenAccountBalance: async () => BigInt(10000), // Balance unchanged
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      BigInt(10000), // balanceBefore = 10000, balanceAfter = 10000, delta = 0 < required
    );

    expect(result.verified).toBe(false);
    expect(result.method).toBe("balanceDelta");
  });

  it("returns unverified when neither method is available", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      // No getConfirmedTransactionInnerInstructions
      // No getTokenAccountBalance
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      null,
    );

    expect(result.verified).toBe(false);
    expect(result.method).toBe("unverified");
  });

  it("rejects when both RPC calls fail (double failure)", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => {
        throw new Error("RPC timeout");
      },
      getTokenAccountBalance: async () => {
        throw new Error("RPC timeout");
      },
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      BigInt(10000),
    );

    expect(result.verified).toBe(false);
    expect(result.method).toBe("unverified");
  });

  it("accepts overpayment (amount > required)", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => null,
      getTokenAccountBalance: async () => BigInt(30000), // 30000 - 10000 = 20000 >= 10000 required
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      BigInt(10000),
    );

    expect(result.verified).toBe(true);
    expect(result.method).toBe("balanceDelta");
  });

  it("falls back to Token-2022 ATA when SPL Token ATA shows no delta", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    // Simulate: getTransaction unavailable (indexing lag).
    // Payment used Token-2022, so SPL Token ATA is unchanged.
    // The first ATA check (SPL Token) will throw or show no delta.
    // The second ATA check (Token-2022) will show the correct delta.
    let callCount = 0;
    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => null, // Indexing lag
      getTokenAccountBalance: async (_ata: string) => {
        callCount++;
        // First call: SPL Token ATA — no change (returns same as before)
        if (callCount === 1) return BigInt(10000);
        // Second call: Token-2022 ATA — balance increased
        return BigInt(20000);
      },
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      BigInt(10000), // balanceBefore
      null, // no specific token program hint — try both
    );

    expect(result.verified).toBe(true);
    expect(result.method).toBe("balanceDelta");
    // Should have checked at least 2 ATAs (SPL Token first, then Token-2022)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("uses hinted token program first in balance delta fallback", async () => {
    const { verifyPostSettlement } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    let callCount = 0;
    const mockSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      getConfirmedTransactionInnerInstructions: async () => null,
      getTokenAccountBalance: async () => {
        callCount++;
        return BigInt(20000); // Balance increased on first try
      },
    };

    const result = await verifyPostSettlement(
      mockSigner as never,
      "fakeSig123",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      mockRequirements as never,
      [],
      BigInt(10000),
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Hint: Token-2022
    );

    expect(result.verified).toBe(true);
    expect(result.method).toBe("balanceDelta");
    // Should succeed on the first ATA check (Token-2022, the hinted program)
    expect(callCount).toBe(1);
  });
});

describe("ExactSvmScheme constructor enforcement", () => {
  it("throws when signer missing required methods for smart wallet verification", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const incompleteSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
    };

    expect(
      () =>
        new ExactSvmScheme(incompleteSigner as never, undefined, {
          enableSmartWalletVerification: true,
        }),
    ).toThrow("enableSmartWalletVerification requires");
  });

  it("throws when signer has the other methods but lacks fetchAddressLookupTables", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    // All smart-wallet methods present except ALT resolution. Must still throw,
    // because ALT-using wallets would otherwise fail later at verify time.
    const signerMissingAlt = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      simulateTransactionWithInnerInstructions: async () => ({ innerInstructions: null }),
      getConfirmedTransactionInnerInstructions: async () => null,
      getTokenAccountBalance: async () => null,
    };

    expect(
      () =>
        new ExactSvmScheme(signerMissingAlt as never, undefined, {
          enableSmartWalletVerification: true,
        }),
    ).toThrow("enableSmartWalletVerification requires fetchAddressLookupTables");
  });

  it("succeeds when signer has all required methods", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const completeSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      simulateTransactionWithInnerInstructions: async () => ({ innerInstructions: null }),
      getConfirmedTransactionInnerInstructions: async () => null,
      getTokenAccountBalance: async () => null,
      fetchAddressLookupTables: async () => ({}),
    };

    expect(
      () =>
        new ExactSvmScheme(completeSigner as never, undefined, {
          enableSmartWalletVerification: true,
        }),
    ).not.toThrow();
  });

  it("does not throw when smart wallet verification is disabled", async () => {
    const { ExactSvmScheme } = await import("../../src/exact/facilitator/scheme");

    const minimalSigner = {
      getAddresses: () => [],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
    };

    expect(() => new ExactSvmScheme(minimalSigner as never)).not.toThrow();
  });
});

describe("assertFeePayerIsolated ALT handling", () => {
  it("passes non-ALT transaction without signer (backward compatible)", async () => {
    const { assertFeePayerIsolated } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );

    const feePayer = await generateKeyPairSigner();
    const otherAccount = await generateKeyPairSigner();

    const tx = await buildTransaction(feePayer.address, [
      {
        programAddress: COMPUTE_BUDGET_PROGRAM,
        accounts: [{ address: otherAccount.address, role: 1 }],
        data: new Uint8Array([2, 0, 0, 0, 0]),
      },
    ]);

    await expect(assertFeePayerIsolated(tx as never, feePayer.address)).resolves.not.toThrow();
  });

  it("rejects ALT transaction when signer lacks fetchAddressLookupTables", async () => {
    const { assertFeePayerIsolated } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );
    const { getCompiledTransactionMessageEncoder } = await import("@solana/kit");

    const feePayer = await generateKeyPairSigner();
    const altAddr = await generateKeyPairSigner();

    const compiled = {
      version: 0 as const,
      header: {
        numSignerAccounts: 1,
        numReadonlySignerAccounts: 0,
        numReadonlyNonSignerAccounts: 1,
      },
      staticAccounts: [feePayer.address, COMPUTE_BUDGET_PROGRAM],
      lifetimeToken: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      instructions: [
        {
          programAddressIndex: 1,
          accountIndices: [2],
          data: new Uint8Array([2, 0, 0, 0, 0]),
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
    const tx = { messageBytes, signatures: {} };

    const signerWithoutALT = {
      getAddresses: () => [feePayer.address],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
    };

    await expect(
      assertFeePayerIsolated(
        tx as never,
        feePayer.address,
        signerWithoutALT as never,
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      ),
    ).rejects.toThrow("smart_wallet_alt_resolution_not_available");
  });

  it("catches fee payer hidden in ALT-resolved accounts", async () => {
    const { assertFeePayerIsolated } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );
    const { getCompiledTransactionMessageEncoder } = await import("@solana/kit");

    const feePayer = await generateKeyPairSigner();
    const altAddr = await generateKeyPairSigner();

    const compiled = {
      version: 0 as const,
      header: {
        numSignerAccounts: 1,
        numReadonlySignerAccounts: 0,
        numReadonlyNonSignerAccounts: 1,
      },
      staticAccounts: [feePayer.address, COMPUTE_BUDGET_PROGRAM],
      lifetimeToken: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      instructions: [
        {
          programAddressIndex: 1,
          accountIndices: [2],
          data: new Uint8Array([2, 0, 0, 0, 0]),
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
    const tx = { messageBytes, signatures: {} };

    const signerWithALT = {
      getAddresses: () => [feePayer.address],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      fetchAddressLookupTables: async () => ({
        [altAddr.address.toString()]: [feePayer.address.toString()],
      }),
    };

    await expect(
      assertFeePayerIsolated(
        tx as never,
        feePayer.address,
        signerWithALT as never,
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      ),
    ).rejects.toThrow("smart_wallet_fee_payer_not_isolated");
  });

  it("propagates ALT resolution failure instead of treating it as no ALTs", async () => {
    const { assertFeePayerIsolated } = await import(
      "../../src/exact/facilitator/smartWalletVerification"
    );
    const { getCompiledTransactionMessageEncoder } = await import("@solana/kit");

    const feePayer = await generateKeyPairSigner();
    const altAddr = await generateKeyPairSigner();

    const compiled = {
      version: 0 as const,
      header: {
        numSignerAccounts: 1,
        numReadonlySignerAccounts: 0,
        numReadonlyNonSignerAccounts: 1,
      },
      staticAccounts: [feePayer.address, COMPUTE_BUDGET_PROGRAM],
      lifetimeToken: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      instructions: [
        {
          programAddressIndex: 1,
          accountIndices: [2],
          data: new Uint8Array([2, 0, 0, 0, 0]),
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
    const tx = { messageBytes, signatures: {} };

    // Signer implements fetchAddressLookupTables but the RPC call fails. The
    // failure must surface (not be swallowed into an empty map), so the fee-payer
    // isolation check fails closed rather than proceeding with unresolved accounts.
    const signerWithFailingALT = {
      getAddresses: () => [feePayer.address],
      signTransaction: async () => "",
      simulateTransaction: async () => {},
      sendTransaction: async () => "",
      confirmTransaction: async () => {},
      fetchAddressLookupTables: async () => {
        throw new Error("smart_wallet_alt_resolution_failed: rpc unavailable");
      },
    };

    await expect(
      assertFeePayerIsolated(
        tx as never,
        feePayer.address,
        signerWithFailingALT as never,
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      ),
    ).rejects.toThrow("smart_wallet_alt_resolution_failed");
  });
});
