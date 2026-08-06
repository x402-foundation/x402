import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import type { Address } from "@solana/kit";
import {
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
  getTransactionDecoder,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  MEMO_PROGRAM_ADDRESS,
  SOLANA_DEVNET_CAIP2,
  USDC_DEVNET_ADDRESS,
} from "../../src/constants";
import { transactionMessageHash } from "../../src/utils";

const FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF";
const FIXED_BLOCKHASH_ALT = "7ZCxc2SDhzV2bYgEQqdxTpweYJkpwshVSDtXuY7uPtjf";

let blockhashes: string[] = [];
let blockhashIndex = 0;
let mockAtaMap: Record<string, Address> = {};

const mockRpc = {
  getLatestBlockhash: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({
      value: { blockhash: blockhashes[blockhashIndex++] },
    }),
  })),
};

vi.mock("../../src/utils", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils")>("../../src/utils");
  return {
    ...actual,
    createRpcClient: vi.fn(() => mockRpc),
  };
});

vi.mock("@solana-program/token-2022", async () => {
  const actual = await vi.importActual<typeof import("@solana-program/token-2022")>(
    "@solana-program/token-2022",
  );
  return {
    ...actual,
    fetchMint: vi.fn().mockResolvedValue({
      programAddress: TOKEN_PROGRAM_ADDRESS,
      data: { decimals: 6 },
    }),
    findAssociatedTokenPda: vi.fn().mockImplementation(async args => {
      const owner = String(args.owner);
      const ata = mockAtaMap[owner];
      if (!ata) {
        throw new Error(`Missing ATA mock for owner ${owner}`);
      }
      return [ata, 255] as const;
    }),
  };
});

async function createSigner() {
  return generateKeyPairSigner();
}

describe("Memo Uniqueness", () => {
  beforeEach(() => {
    blockhashes = [];
    blockhashIndex = 0;
    mockAtaMap = {};
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("includes a memo instruction for uniqueness", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { decodeTransactionFromPayload } = await import("../../src/utils");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
      },
    };

    const payload = await client.createPaymentPayload(2, requirements);
    const txBase64 = (payload.payload as { transaction: string }).transaction;

    expect(txBase64.length).toBeGreaterThan(100);

    const tx = decodeTransactionFromPayload({ transaction: txBase64 });
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const decompiled = decompileTransactionMessage(compiled);
    const instructionPrograms = (decompiled.instructions ?? []).map(ix =>
      ix.programAddress.toString(),
    );

    expect(instructionPrograms).toContain(MEMO_PROGRAM_ADDRESS);
  });

  it("produces different transactions with fixed blockhash", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
      },
    };

    const payload1 = await client.createPaymentPayload(2, requirements);
    const payload2 = await client.createPaymentPayload(2, requirements);

    const tx1Base64 = (payload1.payload as { transaction: string }).transaction;
    const tx2Base64 = (payload2.payload as { transaction: string }).transaction;

    expect(tx1Base64).not.toBe(tx2Base64);
  });

  it("produces different transactions when blockhash changes", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH_ALT];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
      },
    };

    const payload1 = await client.createPaymentPayload(2, requirements);
    const payload2 = await client.createPaymentPayload(2, requirements);

    const tx1Base64 = (payload1.payload as { transaction: string }).transaction;
    const tx2Base64 = (payload2.payload as { transaction: string }).transaction;

    expect(tx1Base64).not.toBe(tx2Base64);
  });

  it("shows concurrent calls with shared blockhash return distinct payloads", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH, FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
      },
    };

    const [payload1, payload2, payload3] = await Promise.all([
      client.createPaymentPayload(2, requirements),
      client.createPaymentPayload(2, requirements),
      client.createPaymentPayload(2, requirements),
    ]);

    const tx1 = (payload1.payload as { transaction: string }).transaction;
    const tx2 = (payload2.payload as { transaction: string }).transaction;
    const tx3 = (payload3.payload as { transaction: string }).transaction;

    expect(tx1).not.toBe(tx2);
    expect(tx2).not.toBe(tx3);
    expect(tx1).not.toBe(tx3);
  });

  it("memo data is valid UTF-8 (SPL Memo requirement)", async () => {
    blockhashes = [FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { decodeTransactionFromPayload } = await import("../../src/utils");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
      },
    };

    const payload = await client.createPaymentPayload(2, requirements);
    const txBase64 = (payload.payload as { transaction: string }).transaction;

    const tx = decodeTransactionFromPayload({ transaction: txBase64 });
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const decompiled = decompileTransactionMessage(compiled);
    const instructions = decompiled.instructions ?? [];

    // Find memo instruction
    const memoIx = instructions.find(ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS);
    expect(memoIx).toBeDefined();

    // Verify memo data is valid UTF-8 (hex-encoded = 32 chars for 16 bytes)
    const memoData = memoIx!.data;
    expect(memoData).toBeDefined();
    expect(memoData!.length).toBe(32);

    // Verify it decodes as valid UTF-8 (hex chars are ASCII, always valid UTF-8)
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(() => decoder.decode(memoData)).not.toThrow();

    // Verify it's valid hex (only 0-9, a-f characters)
    const memoString = decoder.decode(memoData);
    expect(memoString).toMatch(/^[0-9a-f]+$/);
  });

  it("uses extra.memo as memo data when provided", async () => {
    blockhashes = [FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { decodeTransactionFromPayload } = await import("../../src/utils");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const sellerMemo = "pi_3abc123def456";
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
        memo: sellerMemo,
      },
    };

    const payload = await client.createPaymentPayload(2, requirements);
    const txBase64 = (payload.payload as { transaction: string }).transaction;

    const tx = decodeTransactionFromPayload({ transaction: txBase64 });
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const decompiled = decompileTransactionMessage(compiled);
    const instructions = decompiled.instructions ?? [];

    const memoIx = instructions.find(ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS);
    expect(memoIx).toBeDefined();

    const memoData = new TextDecoder().decode(new Uint8Array(memoIx!.data!));
    expect(memoData).toBe(sellerMemo);
  });

  it("produces identical memo data with extra.memo across calls", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { decodeTransactionFromPayload } = await import("../../src/utils");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const sellerMemo = "order_12345";
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
        memo: sellerMemo,
      },
    };

    const payload1 = await client.createPaymentPayload(2, requirements);
    const payload2 = await client.createPaymentPayload(2, requirements);

    const decode = (p: typeof payload1) => {
      const txBase64 = (p.payload as { transaction: string }).transaction;
      const tx = decodeTransactionFromPayload({ transaction: txBase64 });
      const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      const decompiled = decompileTransactionMessage(compiled);
      const memoIx = (decompiled.instructions ?? []).find(
        ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS,
      );
      return new TextDecoder().decode(new Uint8Array(memoIx!.data!));
    };

    expect(decode(payload1)).toBe(sellerMemo);
    expect(decode(payload2)).toBe(sellerMemo);
  });

  it("falls back to random nonce when extra.memo is absent", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { decodeTransactionFromPayload } = await import("../../src/utils");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
        // no memo
      },
    };

    const payload1 = await client.createPaymentPayload(2, requirements);
    const payload2 = await client.createPaymentPayload(2, requirements);

    const decode = (p: typeof payload1) => {
      const txBase64 = (p.payload as { transaction: string }).transaction;
      const tx = decodeTransactionFromPayload({ transaction: txBase64 });
      const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      const decompiled = decompileTransactionMessage(compiled);
      const memoIx = (decompiled.instructions ?? []).find(
        ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS,
      );
      return new TextDecoder().decode(new Uint8Array(memoIx!.data!));
    };

    const memo1 = decode(payload1);
    const memo2 = decode(payload2);

    // Random nonces should differ
    expect(memo1).not.toBe(memo2);
    // Random nonces are 32 hex chars
    expect(memo1).toMatch(/^[0-9a-f]{32}$/);
    expect(memo2).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects extra.memo exceeding 256 bytes", async () => {
    blockhashes = [FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: {
        feePayer: feePayer.address,
        memo: "x".repeat(257),
      },
    };

    await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
      /extra\.memo exceeds maximum/,
    );
  });

  // Empty accounts is critical - signers break facilitator verification
  it("memo instruction has no accounts", async () => {
    blockhashes = [FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { decodeTransactionFromPayload } = await import("../../src/utils");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const payload = await client.createPaymentPayload(2, requirements);
    const tx = decodeTransactionFromPayload({
      transaction: (payload.payload as { transaction: string }).transaction,
    });
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const decompiled = decompileTransactionMessage(compiled);

    const memoIx = (decompiled.instructions ?? []).find(
      ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS,
    );
    expect(memoIx).toBeDefined();
    expect(memoIx!.accounts ?? []).toHaveLength(0);
  });
});

describe("mint metadata cache", () => {
  beforeEach(() => {
    blockhashes = [];
    blockhashIndex = 0;
    mockAtaMap = {};
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("caches mint metadata for repeated V2 payment payloads", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH_ALT];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { fetchMint } = await import("@solana-program/token-2022");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    await client.createPaymentPayload(2, requirements);
    await client.createPaymentPayload(2, requirements);

    expect(fetchMint).toHaveBeenCalledTimes(1);
    expect(mockRpc.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });

  it("caches mint metadata for repeated V1 payment payloads", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH_ALT];

    const { ExactSvmSchemeV1 } = await import("../../src/exact/v1/client/scheme");
    const { fetchMint } = await import("@solana-program/token-2022");

    const clientSigner = await createSigner();
    const feePayer = await createSigner();
    const payTo = await createSigner();

    const client = new ExactSvmSchemeV1(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements = {
      scheme: "exact",
      network: "solana-devnet",
      asset: USDC_DEVNET_ADDRESS,
      maxAmountRequired: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    await client.createPaymentPayload(1, requirements as never);
    await client.createPaymentPayload(1, requirements as never);

    expect(fetchMint).toHaveBeenCalledTimes(1);
    expect(mockRpc.getLatestBlockhash).toHaveBeenCalledTimes(2);
  });
});

// Verify that randomizing the fee-payer signature bytes (slot 0) — which the
// facilitator overwrites before broadcast — does not change the cache key.
describe("transactionMessageHash malleability resistance", () => {
  it("produces identical hash when fee-payer signature bytes are changed", async () => {
    blockhashes = [FIXED_BLOCKHASH];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");

    const clientSigner = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const payload = await client.createPaymentPayload(2, requirements);
    const txBase64 = (payload.payload as { transaction: string }).transaction;

    // Decode the transaction to get its binary representation.
    const base64Encoder = getBase64Encoder();
    const txDecoder = getTransactionDecoder();
    const txBytes = base64Encoder.encode(txBase64);
    const tx = txDecoder.decode(txBytes);

    const hashBefore = transactionMessageHash(tx);

    // Flip every bit in the fee-payer signature slot (first 64 bytes after the
    // compact-u16 signature-count prefix). This simulates an attacker submitting
    // the same payment with different garbage bytes at slot 0.
    const mutated = new Uint8Array(txBytes);
    // byte 0 is the compact-u16 num_signatures prefix (value < 128 → 1 byte)
    for (let i = 1; i <= 64; i++) {
      mutated[i] = mutated[i] ^ 0xff;
    }
    const mutatedTx = txDecoder.decode(mutated);

    const hashAfter = transactionMessageHash(mutatedTx);

    expect(hashBefore).toBe(hashAfter);
  });

  it("produces different hashes for transactions with different messages", async () => {
    blockhashes = [FIXED_BLOCKHASH, FIXED_BLOCKHASH_ALT];

    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");

    const clientSigner = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();

    const client = new ExactSvmScheme(clientSigner);
    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: payTo.address as Address,
    };

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };

    const payload1 = await client.createPaymentPayload(2, requirements);
    const payload2 = await client.createPaymentPayload(2, requirements);

    const decode = (b64: string) => {
      const bytes = getBase64Encoder().encode(b64);
      return getTransactionDecoder().decode(bytes);
    };

    const tx1 = decode((payload1.payload as { transaction: string }).transaction);
    const tx2 = decode((payload2.payload as { transaction: string }).transaction);

    // Different blockhashes → different messages → different hashes
    expect(transactionMessageHash(tx1)).not.toBe(transactionMessageHash(tx2));
  });
});
