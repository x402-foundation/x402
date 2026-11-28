import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import type { ClientSvmSigner } from "../../src/signer";
import type { PaymentRequirements } from "@x402/core/types";
import { AuthCaptureSvmScheme } from "../../src/auth-capture";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS, MAX_MEMO_BYTES, MEMO_PROGRAM_ADDRESS } from "../../src/constants";
import { getCachedMintMetadata } from "../../src/mint-cache";
import { resolveBlockhash } from "../../src/utils";

vi.mock("../../src/mint-cache", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/mint-cache")>();
  return {
    ...actual,
    getCachedMintMetadata: vi.fn(),
  };
});

vi.mock("../../src/utils", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/utils")>();
  return {
    ...actual,
    resolveBlockhash: vi.fn(),
  };
});

const PROVIDED_BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k";

function createBlockhashRpc() {
  const send = vi.fn().mockResolvedValue({
    value: {
      blockhash: PROVIDED_BLOCKHASH,
      lastValidBlockHeight: 67890n,
    },
  });
  const rpc = {
    getLatestBlockhash: () => ({ send }),
  };
  return { rpc, send };
}

function baseRequirements(): PaymentRequirements {
  return {
    scheme: "auth-capture",
    network: SOLANA_DEVNET_CAIP2,
    amount: "1000000",
    asset: USDC_DEVNET_ADDRESS,
    payTo: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ",
    maxTimeoutSeconds: 60,
    extra: {
      feePayer: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ",
      delegate: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ",
    },
  } as PaymentRequirements;
}

describe("AuthCaptureSvmScheme client", () => {
  let mockSigner: ClientSvmSigner;

  beforeEach(() => {
    mockSigner = {
      address: "9xAXssX9j7vuK99c7cFwqbixzL3bFrzPy9PUhCtDPAYJ" as never,
    } as never;
    vi.resetAllMocks();
  });

  it("should create instance with correct scheme", () => {
    const client = new AuthCaptureSvmScheme(mockSigner);
    expect(client.scheme).toBe("auth-capture");
  });

  it("should throw when delegate is missing from extra", async () => {
    const client = new AuthCaptureSvmScheme(mockSigner);
    const req = baseRequirements();
    delete req.extra.delegate;
    await expect(client.createPaymentPayload(2, req)).rejects.toThrow("delegate is required");
  });

  it("should throw when feePayer is missing from extra", async () => {
    const client = new AuthCaptureSvmScheme(mockSigner);
    const req = baseRequirements();
    delete req.extra.feePayer;
    await expect(client.createPaymentPayload(2, req)).rejects.toThrow("feePayer is required");
  });

  it("should reject memo exceeding MAX_MEMO_BYTES", async () => {
    const client = new AuthCaptureSvmScheme(mockSigner);
    const req = baseRequirements();
    req.extra.memo = "x".repeat(MAX_MEMO_BYTES + 1);
    vi.mocked(getCachedMintMetadata).mockResolvedValue({
      programAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as never,
      decimals: 6,
    } as never);
    vi.mocked(resolveBlockhash).mockResolvedValue({
      blockhash: PROVIDED_BLOCKHASH as never,
      lastValidBlockHeight: 67890n,
    } as never);
    await expect(client.createPaymentPayload(2, req)).rejects.toThrow("exceeds maximum");
  });
});
