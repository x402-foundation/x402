/** Settlement-readiness checks a batch facilitator runs before co-signing a deposit. */

import { address, type Address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import type { PaymentRequirements } from "@x402/core/types";

import { decodeTokenAccount, unusableSettlementAccount } from "../../payment-channels/tokenAccount";
import type { PaymentChannelFacilitatorSigner } from "../../payment-channels/signer";
import { BatchError } from "../errors";

/**
 * Ensure the deposit can land and the channel can later distribute before the
 * sponsor co-signs it. Each payout destination (payer return, receiver,
 * treasury) must be a usable token account for this mint: an unusable one
 * fails `distribute` only after the escrow is locked and the request served.
 * The payer's must also hold the deposit ("It MUST confirm the payer has
 * sufficient tokens").
 *
 * @param signer - Facilitator signer whose RPC reads the accounts
 * @param requirements - Route requirements (mint, network, payTo)
 * @param args - The channel's payer, token program, treasury owner and deposit
 * @param args.payer - Channel payer
 * @param args.tokenProgram - Token program of the mint
 * @param args.treasuryOwner - Owner of the payment-channels treasury
 * @param args.deposit - Amount the deposit transaction moves from the payer
 */
export async function assertSettlementAccounts(
  signer: Pick<PaymentChannelFacilitatorSigner, "getAccountInfo">,
  requirements: PaymentRequirements,
  args: { payer: string; tokenProgram: string; treasuryOwner: Address; deposit: bigint },
): Promise<void> {
  const mint = address(requirements.asset);
  const tokenProgramAddress = address(args.tokenProgram);
  const required = [
    { label: "payer", owner: address(args.payer) },
    { label: "recipient", owner: address(requirements.payTo) },
    { label: "payment-channel treasury", owner: args.treasuryOwner },
  ] as const;
  for (const { label, owner } of required) {
    const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: tokenProgramAddress });
    const account = await signer.getAccountInfo(ata, requirements.network, {
      commitment: "confirmed",
      encoding: "base64",
    });
    if (!account) {
      throw new Error(`${BatchError.SETTLEMENT_SIMULATION}: missing ${label} ATA: ${ata}`);
    }
    const encoded = Array.isArray(account.data) ? account.data[0] : account.data;
    const data =
      typeof encoded === "string"
        ? new Uint8Array(Buffer.from(encoded, "base64"))
        : new Uint8Array();
    const problem = unusableSettlementAccount(
      { data, programOwner: account.owner.toString() },
      owner,
      requirements.asset,
      args.tokenProgram,
    );
    if (problem) {
      throw new Error(`${BatchError.SETTLEMENT_SIMULATION}: ${label} ATA ${ata} ${problem}`);
    }
    const balance = decodeTokenAccount(data)!.amount;
    if (label === "payer" && balance < args.deposit) {
      throw new Error(
        `${BatchError.SETTLEMENT_SIMULATION}: payer ATA ${ata} holds ${balance}, less than the ${args.deposit} deposit`,
      );
    }
  }
}
