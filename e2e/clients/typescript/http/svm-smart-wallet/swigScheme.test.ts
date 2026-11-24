import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountRole,
  generateKeyPairSigner,
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import { fetchMint, findAssociatedTokenPda } from "@solana-program/token-2022";
import { fetchSwig, getSignInstructions, getSwigWalletAddress } from "@swig-wallet/kit";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactSwigSvmScheme } from "./swigScheme";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
const SWIG_PROGRAM = "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB" as Address;
const BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k";
const rpc = vi.hoisted(() => ({
  getTokenAccountBalance: vi.fn(() => ({
    send: async () => ({ value: { amount: "5000000" } }),
  })),
  getAccountInfo: vi.fn(() => ({ send: async () => ({ value: null }) })),
  getLatestBlockhash: vi.fn(() => ({
    send: async () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1n },
    }),
  })),
}));

vi.mock("@solana/kit", async original => ({
  ...(await original<typeof import("@solana/kit")>()),
  createSolanaRpc: () => rpc,
}));
vi.mock("@solana-program/token-2022", async original => ({
  ...(await original<typeof import("@solana-program/token-2022")>()),
  fetchMint: vi.fn(),
}));
vi.mock("@swig-wallet/kit", () => ({
  fetchSwig: vi.fn(),
  getSignInstructions: vi.fn(),
  getSwigWalletAddress: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Swig payment legs", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "wraps every declared leg and sponsors marked ATA creation (split=%s, primaryCreation=%s)",
    async (split, primaryCreation) => {
      const [authority, feePayer, swigAccount, wallet, merchant, recipient] = await Promise.all(
        Array.from({ length: 6 }, () => generateKeyPairSigner()),
      );
      vi.mocked(fetchSwig).mockResolvedValue({
        findRolesByEd25519SignerPk: () => [{ id: 0 }],
      } as never);
      vi.mocked(getSwigWalletAddress).mockResolvedValue(wallet.address);
      vi.mocked(fetchMint).mockResolvedValue({
        programAddress: TOKEN_PROGRAM,
        data: { decimals: 6 },
      } as never);
      vi.mocked(getSignInstructions).mockResolvedValue([
        {
          programAddress: SWIG_PROGRAM,
          accounts: [{ address: authority.address, role: AccountRole.READONLY_SIGNER }],
          data: new Uint8Array([0]),
        },
      ] as never);
      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        asset: MINT,
        amount: "1050000",
        payTo: merchant.address,
        maxTimeoutSeconds: 60,
        extra: {
          feePayer: feePayer.address,
          ...(primaryCreation ? { ataCreationRequired: true } : {}),
          ...(split
            ? {
                splits: [
                  {
                    payTo: recipient.address,
                    amount: "50000",
                    ataCreationRequired: true,
                  },
                ],
              }
            : {}),
        },
      };
      const payload = await new ExactSwigSvmScheme(
        authority,
        swigAccount.address,
      ).createPaymentPayload(2, requirements);
      const wrapped = vi.mocked(getSignInstructions).mock.calls[0][2];
      expect(wrapped).toHaveLength(split ? 2 : 1);
      const expected = split
        ? ([
            [merchant.address, 1_000_000n],
            [recipient.address, 50_000n],
          ] as const)
        : ([[merchant.address, 1_050_000n]] as const);
      for (const [i, [owner, amount]] of expected.entries()) {
        const [destination] = await findAssociatedTokenPda({
          mint: MINT,
          owner,
          tokenProgram: TOKEN_PROGRAM,
        });
        expect(wrapped[i].accounts?.[2].address).toBe(destination);
        const data = wrapped[i].data!;
        expect(
          new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true),
        ).toBe(amount);
      }
      const transaction = getTransactionDecoder().decode(
        getBase64Encoder().encode(payload.payload.transaction as string),
      );
      const instructions = decompileTransactionMessage(
        getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
      ).instructions;
      const creations = instructions.filter(ix => ix.programAddress.toString() === ATA_PROGRAM);
      expect(creations).toHaveLength((split ? 1 : 0) + (primaryCreation ? 1 : 0));
      const createdOwners = [
        ...(primaryCreation ? [merchant.address] : []),
        ...(split ? [recipient.address] : []),
      ];
      for (const [index, owner] of createdOwners.entries()) {
        expect(creations[index].data?.[0]).toBe(1);
        expect(creations[index].accounts?.[0].address).toBe(feePayer.address);
        expect(creations[index].accounts?.[2].address).toBe(owner);
      }
    },
  );
});
