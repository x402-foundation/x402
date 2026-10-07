import { generateKeyPairSigner, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS } from "../../src/constants";

/**
 * Fail-fast on a missing destination ATA (#2395).
 *
 * TransferChecked against a non-existent recipient ATA only fails at settle
 * time with an opaque `InstructionError: [.., InvalidAccountData]`. The client
 * now checks the destination ATA (in parallel with the blockhash fetch) and
 * throws an explicit, actionable error instead. No instruction is added and
 * nobody sponsors rent — facilitator-funded creation was rejected as a
 * griefing vector (#1020, #2798); the sanctioned path is recipient
 * self-provisioning.
 */

const FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF";

let mockAtaMap: Record<string, Address> = {};
let destinationAtaExists = true;
let destinationAtaOwner: string = TOKEN_PROGRAM_ADDRESS.toString();

const mockRpc = {
  getLatestBlockhash: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ value: { blockhash: FIXED_BLOCKHASH } }),
  })),
  getAccountInfo: vi.fn(() => ({
    send: vi.fn().mockImplementation(async () => ({
      value: destinationAtaExists ? { data: ["", "base64"], owner: destinationAtaOwner } : null,
    })),
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

async function setup() {
  const clientSigner = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const payTo = await generateKeyPairSigner();
  const destAta = await generateKeyPairSigner();
  mockAtaMap = {
    [clientSigner.address]: clientSigner.address as Address,
    [payTo.address]: destAta.address as Address,
  };
  return { clientSigner, feePayer, payTo, destAta };
}

describe("client fail-fast on missing destination ATA (#2395)", () => {
  beforeEach(() => {
    mockAtaMap = {};
    destinationAtaExists = true;
    destinationAtaOwner = TOKEN_PROGRAM_ADDRESS.toString();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("v2: throws an explicit error naming ATA, payTo, mint and the fix", async () => {
    destinationAtaExists = false;
    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { clientSigner, feePayer, payTo, destAta } = await setup();
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };
    const client = new ExactSvmScheme(clientSigner);
    await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
      new RegExp(
        `${destAta.address}.*${payTo.address}.*${USDC_DEVNET_ADDRESS}.*provision their own ATA`,
        "s",
      ),
    );
  });

  it("v2: builds the payload unchanged when the destination ATA exists", async () => {
    destinationAtaExists = true;
    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { clientSigner, feePayer, payTo } = await setup();
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };
    const client = new ExactSvmScheme(clientSigner);
    const payload = await client.createPaymentPayload(2, requirements);
    expect((payload.payload as { transaction: string }).transaction.length).toBeGreaterThan(100);
  });

  it("v2: throws when the ATA address is squatted by a non-token-program account", async () => {
    destinationAtaExists = true;
    destinationAtaOwner = "11111111111111111111111111111111"; // System-owned squatter
    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { clientSigner, feePayer, payTo } = await setup();
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      amount: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    };
    const client = new ExactSvmScheme(clientSigner);
    await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
      /owned by 11111111111111111111111111111111 rather/,
    );
  });

  it("v1: throws the same explicit error", async () => {
    destinationAtaExists = false;
    const { ExactSvmSchemeV1 } = await import("../../src/exact/v1/client/scheme");
    const { clientSigner, feePayer, payTo, destAta } = await setup();
    const requirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      maxAmountRequired: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    } as unknown as PaymentRequirements;
    const client = new ExactSvmSchemeV1(clientSigner);
    await expect(client.createPaymentPayload(1, requirements)).rejects.toThrow(
      new RegExp(`${destAta.address}.*provision their own ATA`, "s"),
    );
  });

  it("v1: builds the payload unchanged when the destination ATA exists", async () => {
    destinationAtaExists = true;
    const { ExactSvmSchemeV1 } = await import("../../src/exact/v1/client/scheme");
    const { clientSigner, feePayer, payTo } = await setup();
    const requirements = {
      scheme: "exact",
      network: SOLANA_DEVNET_CAIP2,
      asset: USDC_DEVNET_ADDRESS,
      maxAmountRequired: "100000",
      payTo: payTo.address,
      maxTimeoutSeconds: 3600,
      extra: { feePayer: feePayer.address },
    } as unknown as PaymentRequirements;
    const client = new ExactSvmSchemeV1(clientSigner);
    const payload = await client.createPaymentPayload(1, requirements);
    expect((payload.payload as { transaction: string }).transaction.length).toBeGreaterThan(100);
  });
});
