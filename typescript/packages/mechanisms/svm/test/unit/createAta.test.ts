import {
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  type Address,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_ADDRESS } from "../../src/constants";
import {
  SYSTEM_PROGRAM_ADDRESS,
  validateCreateAtaIdempotentInstruction,
} from "../../src/exact/createAta";
import type { FacilitatorSvmSigner } from "../../src/signer";

const FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF";

let mockAtaMap: Record<string, Address> = {};
let destinationAtaExists = true;

const mockRpc = {
  getLatestBlockhash: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ value: { blockhash: FIXED_BLOCKHASH } }),
  })),
  getAccountInfo: vi.fn(() => ({
    send: vi.fn().mockImplementation(async () => ({
      value: destinationAtaExists ? { data: ["", "base64"] } : null,
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

/** Build a structurally valid create-ATA instruction view for the validator. */
function makeCreateIx(overrides?: {
  data?: number[];
  accounts?: string[];
}): Parameters<typeof validateCreateAtaIdempotentInstruction>[0] {
  const accounts = overrides?.accounts ?? [
    "FeePayer1111111111111111111111111111",
    "DerivedAta11111111111111111111111111",
    "PayTo1111111111111111111111111111111",
    USDC_DEVNET_ADDRESS,
    SYSTEM_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS.toString(),
  ];
  return {
    programAddress: { toString: () => ASSOCIATED_TOKEN_PROGRAM_ADDRESS.toString() },
    accounts: accounts.map(address => ({ address: { toString: () => address } })),
    data: new Uint8Array(overrides?.data ?? [1]),
  };
}

const EXPECTED = {
  payTo: "PayTo1111111111111111111111111111111",
  asset: USDC_DEVNET_ADDRESS,
  feePayer: "FeePayer1111111111111111111111111111",
};

describe("validateCreateAtaIdempotentInstruction", () => {
  it("accepts a fully pinned idempotent create and returns ata/tokenProgram", () => {
    const result = validateCreateAtaIdempotentInstruction(makeCreateIx(), EXPECTED);
    expect(result).toEqual({
      ata: "DerivedAta11111111111111111111111111",
      tokenProgram: TOKEN_PROGRAM_ADDRESS.toString(),
    });
  });

  it("rejects the legacy non-idempotent Create (empty data)", () => {
    const result = validateCreateAtaIdempotentInstruction(makeCreateIx({ data: [] }), EXPECTED);
    expect(result).toEqual({
      invalidReason: "invalid_exact_svm_payload_create_ata_not_idempotent",
    });
  });

  it("rejects a Create with explicit 0x00 discriminator", () => {
    const result = validateCreateAtaIdempotentInstruction(makeCreateIx({ data: [0] }), EXPECTED);
    expect(result).toEqual({
      invalidReason: "invalid_exact_svm_payload_create_ata_not_idempotent",
    });
  });

  it("rejects a seven-account layout (legacy create with rent sysvar)", () => {
    const base = makeCreateIx();
    const accounts = [...(base.accounts ?? [])];
    accounts.push({ address: { toString: () => "SysvarRent111111111111111111111111111111111" } });
    const result = validateCreateAtaIdempotentInstruction({ ...base, accounts }, EXPECTED);
    expect(result).toEqual({
      invalidReason: "invalid_exact_svm_payload_create_ata_account_count",
    });
  });

  it("rejects a funder other than the fee payer", () => {
    const ix = makeCreateIx({
      accounts: [
        "Sender111111111111111111111111111111", // sender pays rent instead of fee payer
        "DerivedAta11111111111111111111111111",
        "PayTo1111111111111111111111111111111",
        USDC_DEVNET_ADDRESS,
        SYSTEM_PROGRAM_ADDRESS,
        TOKEN_PROGRAM_ADDRESS.toString(),
      ],
    });
    expect(validateCreateAtaIdempotentInstruction(ix, EXPECTED)).toEqual({
      invalidReason: "invalid_exact_svm_payload_create_ata_funder_mismatch",
    });
  });

  it("rejects an owner other than payTo", () => {
    const ix = makeCreateIx({
      accounts: [
        "FeePayer1111111111111111111111111111",
        "DerivedAta11111111111111111111111111",
        "Attacker11111111111111111111111111111",
        USDC_DEVNET_ADDRESS,
        SYSTEM_PROGRAM_ADDRESS,
        TOKEN_PROGRAM_ADDRESS.toString(),
      ],
    });
    expect(validateCreateAtaIdempotentInstruction(ix, EXPECTED)).toEqual({
      invalidReason: "invalid_exact_svm_payload_create_ata_owner_mismatch",
    });
  });

  it("rejects a mint other than the payment asset", () => {
    const ix = makeCreateIx({
      accounts: [
        "FeePayer1111111111111111111111111111",
        "DerivedAta11111111111111111111111111",
        "PayTo1111111111111111111111111111111",
        "OtherMint111111111111111111111111111",
        SYSTEM_PROGRAM_ADDRESS,
        TOKEN_PROGRAM_ADDRESS.toString(),
      ],
    });
    expect(validateCreateAtaIdempotentInstruction(ix, EXPECTED)).toEqual({
      invalidReason: "invalid_exact_svm_payload_create_ata_mint_mismatch",
    });
  });

  it("rejects an unknown token program", () => {
    const ix = makeCreateIx({
      accounts: [
        "FeePayer1111111111111111111111111111",
        "DerivedAta11111111111111111111111111",
        "PayTo1111111111111111111111111111111",
        USDC_DEVNET_ADDRESS,
        SYSTEM_PROGRAM_ADDRESS,
        "FakeTokenProgram11111111111111111111",
      ],
    });
    expect(validateCreateAtaIdempotentInstruction(ix, EXPECTED)).toEqual({
      invalidReason: "invalid_exact_svm_payload_create_ata_token_program_mismatch",
    });
  });

  it("accepts Token-2022 as the pinned token program", () => {
    const ix = makeCreateIx({
      accounts: [
        "FeePayer1111111111111111111111111111",
        "DerivedAta11111111111111111111111111",
        "PayTo1111111111111111111111111111111",
        USDC_DEVNET_ADDRESS,
        SYSTEM_PROGRAM_ADDRESS,
        TOKEN_2022_PROGRAM_ADDRESS.toString(),
      ],
    });
    expect(validateCreateAtaIdempotentInstruction(ix, EXPECTED)).toEqual({
      ata: "DerivedAta11111111111111111111111111",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS.toString(),
    });
  });
});

describe("client create-ATA inclusion (#2395)", () => {
  beforeEach(() => {
    mockAtaMap = {};
    destinationAtaExists = true;
    vi.resetModules();
    vi.clearAllMocks();
  });

  /**
   * Build a client payment payload against the mocked RPC and return the
   * decompiled instruction list.
   */
  async function buildAndDecompile() {
    const { ExactSvmScheme } = await import("../../src/exact/client/scheme");
    const { decodeTransactionFromPayload } = await import("../../src/utils");

    const clientSigner = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    const payTo = await generateKeyPairSigner();
    const destAta = await generateKeyPairSigner();

    mockAtaMap = {
      [clientSigner.address]: clientSigner.address as Address,
      [payTo.address]: destAta.address as Address,
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

    const client = new ExactSvmScheme(clientSigner);
    const payload = await client.createPaymentPayload(2, requirements);
    const tx = decodeTransactionFromPayload(payload.payload as { transaction: string });
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const decompiled = decompileTransactionMessage(compiled);
    return {
      instructions: decompiled.instructions ?? [],
      clientSigner,
      feePayer,
      payTo,
      destAta,
      requirements,
      payload,
    };
  }

  it("keeps the classic 4-instruction layout when the destination ATA exists", async () => {
    destinationAtaExists = true;
    const { instructions } = await buildAndDecompile();
    expect(instructions.map(ix => ix.programAddress.toString())).not.toContain(
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS.toString(),
    );
    expect(instructions.length).toBe(4);
  });

  it("inserts a pinned idempotent create at index 2 when the ATA is missing", async () => {
    destinationAtaExists = false;
    const { instructions, feePayer, payTo, destAta } = await buildAndDecompile();

    expect(instructions.length).toBe(5);
    const createIx = instructions[2] as {
      programAddress: { toString(): string };
      accounts?: ReadonlyArray<{ address: { toString(): string } }>;
      data?: Readonly<Uint8Array>;
    };
    expect(createIx.programAddress.toString()).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS.toString());
    expect(Array.from(createIx.data ?? [])).toEqual([1]);

    const accounts = (createIx.accounts ?? []).map(a => a.address.toString());
    expect(accounts).toEqual([
      feePayer.address, // funder == fee payer (facilitator-funded rent)
      destAta.address, // ata == transfer destination
      payTo.address, // owner == payTo
      USDC_DEVNET_ADDRESS, // mint == payment asset
      SYSTEM_PROGRAM_ADDRESS,
      TOKEN_PROGRAM_ADDRESS.toString(), // token program == transfer's program
    ]);

    // TransferChecked shifted to index 3
    expect(instructions[3].programAddress.toString()).toBe(TOKEN_PROGRAM_ADDRESS.toString());
  });

  it("is accepted by the facilitator static path, and rejected when the funder pin fails", async () => {
    destinationAtaExists = false;
    const { payload, requirements, clientSigner, feePayer } = await buildAndDecompile();

    const { ExactSvmScheme: FacilitatorScheme } = await import(
      "../../src/exact/facilitator/scheme"
    );

    const makeSigner = (addresses: string[]): FacilitatorSvmSigner =>
      ({
        getAddresses: vi.fn().mockReturnValue(addresses),
        signTransaction: vi.fn().mockResolvedValue("signedTransaction=="),
        simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      }) as unknown as FacilitatorSvmSigner;

    const fullPayload = {
      x402Version: 2,
      resource: { url: "http://example.com", description: "", mimeType: "application/json" },
      accepted: requirements,
      payload: payload.payload,
    } as never;

    // Accept: requirements feePayer matches the create-ATA funder
    const facilitator = new FacilitatorScheme(makeSigner([feePayer.address]));
    const ok = await facilitator.verify(fullPayload, requirements);
    expect(ok.invalidReason).toBeUndefined();
    expect(ok.isValid).toBe(true);
    expect(ok.payer).toBe(clientSigner.address);

    // Reject: same transaction verified against a different fee payer —
    // the funder pin must fail before any rent could be redirected.
    const otherFeePayer = await generateKeyPairSigner();
    const otherRequirements = {
      ...requirements,
      extra: { feePayer: otherFeePayer.address },
    } as PaymentRequirements;
    const otherFacilitator = new FacilitatorScheme(makeSigner([otherFeePayer.address]));
    const rejected = await otherFacilitator.verify(
      { ...(fullPayload as object), accepted: otherRequirements } as never,
      otherRequirements,
    );
    expect(rejected.isValid).toBe(false);
    expect(rejected.invalidReason).toBe("invalid_exact_svm_payload_create_ata_funder_mismatch");
  });
});
