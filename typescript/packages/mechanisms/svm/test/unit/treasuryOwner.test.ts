/**
 * The payment-channels treasury owner defaults to the deployed program's
 * owner for the network and can be overridden for a custom or local build.
 */
import { findAssociatedTokenPda } from "@solana-program/token";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  assertTreasuryOwner,
  treasuryOwnerOf,
} from "../../src/batch-settlement/facilitator/bindingSource";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import {
  buildDistributeInstruction,
  getPaymentChannelsTreasuryOwner,
} from "../../src/payment-channels/onchain";
import { toFacilitatorSvmSigner } from "../../src/signer";
import { UptoSvmScheme } from "../../src/upto/facilitator/scheme";

const MAINNET_TREASURY = "Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP";

async function distributeAccounts(treasuryOwner?: string): Promise<string[]> {
  const feePayer = (await generateKeyPairSigner()).address;
  const instruction = await buildDistributeInstruction({
    channelId: (await generateKeyPairSigner()).address,
    mint: USDC_DEVNET_ADDRESS,
    network: SOLANA_DEVNET_CAIP2,
    payee: feePayer,
    payer: (await generateKeyPairSigner()).address,
    rentPayer: feePayer,
    splits: [{ bps: 10_000, recipient: (await generateKeyPairSigner()).address }],
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    treasuryOwner,
  });
  return (instruction.accounts ?? []).map(account => account.address.toString());
}

async function treasuryAta(owner: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({
    mint: USDC_DEVNET_ADDRESS as never,
    owner: owner as never,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}

describe("payment-channels treasury owner", () => {
  it("pays the network's treasury by default and the override when set", async () => {
    const devnet = getPaymentChannelsTreasuryOwner(SOLANA_DEVNET_CAIP2);
    expect(await distributeAccounts()).toContain(await treasuryAta(devnet));
    const overridden = await distributeAccounts(MAINNET_TREASURY);
    expect(overridden).toContain(await treasuryAta(MAINNET_TREASURY));
    expect(overridden).not.toContain(await treasuryAta(devnet));
  });

  it("resolves the batch facilitator's treasury from its config", () => {
    expect(treasuryOwnerOf({}, SOLANA_DEVNET_CAIP2)).toBe(
      getPaymentChannelsTreasuryOwner(SOLANA_DEVNET_CAIP2),
    );
    expect(
      treasuryOwnerOf({ paymentChannelsTreasuryOwner: MAINNET_TREASURY }, SOLANA_DEVNET_CAIP2),
    ).toBe(MAINNET_TREASURY);
    expect(() => assertTreasuryOwner({ paymentChannelsTreasuryOwner: "not-an-address" })).toThrow(
      /paymentChannelsTreasuryOwner/,
    );
  });

  it("refuses an invalid upto treasury override", async () => {
    const signer = toFacilitatorSvmSigner(await generateKeyPairSigner());
    expect(() => new UptoSvmScheme(signer, { paymentChannelsTreasuryOwner: "nope" })).toThrow(
      /paymentChannelsTreasuryOwner/,
    );
    expect(
      () => new UptoSvmScheme(signer, { paymentChannelsTreasuryOwner: MAINNET_TREASURY }),
    ).not.toThrow();
  });
});
