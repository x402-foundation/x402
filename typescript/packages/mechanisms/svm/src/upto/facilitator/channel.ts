/**
 * Channel-flow glue for the `upto` facilitator: co-signing, broadcasting the
 * client `open`, simulating settlement readiness (atomic open + settle +
 * distribute before open), and submitting settle+distribute.
 *
 * Kept separate from the scheme orchestration so the onchain mechanics stay
 * readable. All RPC access is threaded in by the caller.
 */

import { createHash } from "node:crypto";
import {
  getSetComputeUnitLimitInstruction,
  parseSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  address,
  type Address,
  addSignersToInstruction,
  appendTransactionMessageInstructions,
  type Blockhash,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase58Encoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  type MessagePartialSigner,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";

import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "../../constants";
import { fetchChannel, type Channel } from "../../payment-channels/generated/accounts/channel";
import {
  buildDistributeInstruction,
  buildSettleAndSealInstructions,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import type { ChannelSplit } from "../../payment-channels/open";
import type { FacilitatorSvmSigner } from "../../signer";
import { createRpcClient } from "../../utils";

/** Payment-channels `AccountDiscriminator::Channel` (byte 0 is reserved for uninitialized accounts). */
const CHANNEL_ACCOUNT_DISCRIMINATOR = 1;
const CHANNEL_STATUS_OPEN = 0;
/** Solana per-transaction compute-unit max; used only for facilitator-built sims. */
const SIM_COMPUTE_UNIT_LIMIT = 1_400_000;

/** Signer capable of signing Solana transactions and raw Ed25519 messages. */
export type UptoSvmSigner = TransactionSigner & MessagePartialSigner;

/** RPC client shape used by the channel helpers. */
export type ChannelRpc = ReturnType<typeof createRpcClient>;

/**
 * Whether the channel account already exists onchain (open already broadcast).
 *
 * @param rpc - The RPC client
 * @param channelId - Channel PDA (base58)
 * @returns Whether the account exists
 */
export async function channelExists(rpc: ChannelRpc, channelId: string): Promise<boolean> {
  const info = await rpc.getAccountInfo(address(channelId), { encoding: "base64" }).send();
  return info.value !== null;
}

/** Challenge-bound terms that must match the confirmed channel account. */
export interface ExpectedOpenChannel {
  authorizedSigner: string;
  deposit: bigint;
  gracePeriod: number;
  mint: string;
  payee: string;
  payer: string;
  rentPayer: string;
  splits: readonly ChannelSplit[];
}

/** Onchain channel facts retained from verification through settlement. */
export interface VerifiedOpenChannel {
  authorizedSigner: string;
  channelId: string;
  deposit: bigint;
  mint: string;
  openSlot: bigint;
  payee: string;
  payer: string;
  rentPayer: string;
  splits: readonly ChannelSplit[];
}

/**
 * Fetch and bind the confirmed channel account before resource execution.
 *
 * @param rpc - RPC client used to read the channel
 * @param channelId - Channel PDA
 * @param expected - Challenge-bound channel terms
 * @returns Verified channel facts for settlement
 */
export async function fetchAndVerifyOpenChannel(
  rpc: ChannelRpc,
  channelId: string,
  expected: ExpectedOpenChannel,
): Promise<VerifiedOpenChannel> {
  const account = await fetchChannel(rpc, address(channelId));
  return verifyOpenChannelAccount(channelId, account.data, expected);
}

/**
 * Bind a decoded channel account to the terms verified in the submitted open.
 *
 * @param channelId - Channel PDA
 * @param channel - Decoded onchain channel
 * @param expected - Challenge-bound channel terms
 * @returns Verified channel facts for settlement
 */
export function verifyOpenChannelAccount(
  channelId: string,
  channel: Channel,
  expected: ExpectedOpenChannel,
): VerifiedOpenChannel {
  if (channel.discriminator !== CHANNEL_ACCOUNT_DISCRIMINATOR) {
    throw new Error(`channel ${channelId} has an invalid account discriminator`);
  }
  if (channel.status !== CHANNEL_STATUS_OPEN) {
    throw new Error(`channel ${channelId} is not open`);
  }

  assertChannelAddress("mint", channel.mint, expected.mint);
  assertChannelAddress("payee", channel.payee, expected.payee);
  assertChannelAddress("authorized signer", channel.authorizedSigner, expected.authorizedSigner);
  assertChannelAddress("rent payer", channel.rentPayer, expected.rentPayer);
  assertChannelAddress("payer", channel.payer, expected.payer);

  if (channel.gracePeriod !== expected.gracePeriod) {
    throw new Error(
      `channel grace period ${channel.gracePeriod} != expected ${expected.gracePeriod}`,
    );
  }
  if (channel.deposit !== expected.deposit) {
    throw new Error(`channel deposit ${channel.deposit} != expected ${expected.deposit}`);
  }

  const expectedDistributionHash = getChannelDistributionHash(expected.splits);
  if (
    channel.distributionHash.length !== expectedDistributionHash.length ||
    channel.distributionHash.some((value, index) => value !== expectedDistributionHash[index])
  ) {
    throw new Error("channel distribution does not match the expected recipient split");
  }

  return {
    authorizedSigner: expected.authorizedSigner,
    channelId,
    deposit: channel.deposit,
    mint: channel.mint,
    openSlot: channel.openSlot,
    payee: channel.payee,
    payer: channel.payer,
    rentPayer: channel.rentPayer,
    splits: expected.splits,
  };
}

/**
 * Co-sign the fee-payer slot of a partially-signed open transaction,
 * broadcast it, and wait for confirmation. No-op skip is the caller's job
 * (see {@link channelExists}).
 *
 * Uses the wire-level FacilitatorSvmSigner methods (same path as exact).
 *
 * @param facilitator - Facilitator signer with wire sign/send/confirm
 * @param feePayer - Fee-payer address to co-sign with
 * @param network - CAIP-2 network identifier
 * @param openTransactionBase64 - The client-signed open transaction
 * @returns The broadcast signature
 */
export async function broadcastOpen(
  facilitator: Pick<
    FacilitatorSvmSigner,
    "signTransaction" | "sendTransaction" | "confirmTransaction"
  >,
  feePayer: Address,
  network: string,
  openTransactionBase64: string,
): Promise<string> {
  const wire = await facilitator.signTransaction(openTransactionBase64, feePayer, network);
  const signature = await facilitator.sendTransaction(wire, network);
  await facilitator.confirmTransaction(signature, network);
  return signature;
}

/** Channel fields needed to build settle+distribute for readiness simulation. */
export interface SettlementSimChannel {
  channelId: string;
  mint: string;
  /** CAIP-2 network; selects the payment-channels treasury owner. */
  network: string;
  payee: string;
  payer: string;
  rentPayer: string;
  splits: readonly ChannelSplit[];
  tokenProgram: string;
}

/**
 * Simulate `open` + `settle_and_seal(has_voucher=0)` + `distribute` against live
 * state before broadcasting open, so settlement-account failures reject without
 * escrowing the deposit. Never broadcast — only the original open-only tx is.
 *
 * Rebuilds a facilitator-owned message: client non-compute-budget instructions
 * kept verbatim, compute-unit limit raised to the per-tx max (client opens cap
 * at 400_000; the composite can exceed that), payer attached as a noop signer,
 * `sigVerify: false`.
 *
 * @param feePayer - The fee-payer / channel payee signer
 * @param rpc - The RPC client
 * @param args - Open transaction and challenge-bound channel terms
 * @param args.openTransactionBase64 - Client-signed open transaction
 * @param args.channel - Challenge-bound channel terms for settle/distribute
 */
export async function simulateOpenSettleDistribute(
  feePayer: UptoSvmSigner,
  rpc: ChannelRpc,
  args: {
    openTransactionBase64: string;
    channel: SettlementSimChannel;
  },
): Promise<void> {
  const { channel, openTransactionBase64 } = args;
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(openTransactionBase64));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const decompiled = decompileTransactionMessage(compiled);
  const openInstructions = (decompiled.instructions ?? []) as Instruction[];

  let computeUnitPrice: Instruction | undefined;
  const nonComputeBudget: Instruction[] = [];
  for (const ix of openInstructions) {
    if (ix.programAddress.toString() !== COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      nonComputeBudget.push(ix);
      continue;
    }
    // Preserve SetComputeUnitPrice (discriminator 3); drop the client's limit.
    if (ix.data && ix.data.length > 0 && ix.data[0] === 3) {
      parseSetComputeUnitPriceInstruction(ix as never); // reject malformed price ix
      computeUnitPrice = ix;
    }
  }

  // Kit rejects two distinct signer objects for one address; when payer ==
  // feePayer the real signer covers both roles.
  const payerSigner =
    channel.payer === feePayer.address ? feePayer : createNoopSigner(address(channel.payer));
  const openWithPayer = nonComputeBudget.map(ix =>
    addSignersToInstruction([payerSigner, feePayer], ix),
  );

  const settle = buildSettleAndSealInstructions({
    channelId: channel.channelId,
    payeeSigner: feePayer,
  });
  const distribute = await buildDistributeInstruction({
    channelId: channel.channelId,
    mint: channel.mint,
    network: channel.network,
    payee: channel.payee,
    payer: channel.payer,
    rentPayer: channel.rentPayer,
    splits: channel.splits,
    tokenProgram: channel.tokenProgram,
  });

  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: SIM_COMPUTE_UNIT_LIMIT }),
    ...(computeUnitPrice ? [computeUnitPrice] : []),
    ...openWithPayer,
    ...settle,
    distribute,
  ];

  await simulateInstructions(feePayer, rpc, instructions);
}

/**
 * Simulate the zero-charge settlement path (`settle_and_seal` with
 * `has_voucher = 0` + `distribute`) for an already-open channel so bad
 * ATA/account derivations fail before resource execution.
 *
 * @param feePayer - The fee-payer / channel payee signer
 * @param rpc - The RPC client
 * @param channel - Verified open-channel facts
 */
export async function simulateZeroChargeSettle(
  feePayer: UptoSvmSigner,
  rpc: ChannelRpc,
  channel: SettlementSimChannel,
): Promise<void> {
  const settle = buildSettleAndSealInstructions({
    channelId: channel.channelId,
    payeeSigner: feePayer,
  });
  const distribute = await buildDistributeInstruction({
    channelId: channel.channelId,
    mint: channel.mint,
    network: channel.network,
    payee: channel.payee,
    payer: channel.payer,
    rentPayer: channel.rentPayer,
    splits: channel.splits,
    tokenProgram: channel.tokenProgram,
  });
  await simulateInstructions(feePayer, rpc, [...settle, distribute]);
}

/**
 * Compile the settle+distribute instructions into a transaction signed by the
 * fee payer, broadcast it, and confirm. Other signers, such as the channel
 * payee on `settle_and_seal`, are carried by the instruction list.
 *
 * @param feePayer - The fee-payer signer
 * @param rpc - The RPC client
 * @param instructions - settle_and_seal (+ optional Ed25519 precompile) then distribute
 * @returns The broadcast signature
 */
export async function submitSettle(
  feePayer: UptoSvmSigner,
  rpc: ChannelRpc,
  instructions: readonly ServerInstruction[],
): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latestBlockhash.blockhash as Blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        m,
      ),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, signature);
  return signature;
}

/**
 * Poll `getSignatureStatuses` until the signature reaches at least 'confirmed'.
 *
 * @param rpc - The RPC client
 * @param signature - The transaction signature
 * @param timeoutMs - Total time budget (default 30s)
 * @throws If the transaction failed onchain or the timeout elapses
 */
export async function confirmSignature(
  rpc: ChannelRpc,
  signature: Signature,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status) {
      if (status.err) {
        const errorStr = JSON.stringify(status.err, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        );
        throw new Error(`tx ${signature} failed onchain: ${errorStr}`);
      }
      const level = status.confirmationStatus;
      if (level === undefined || level === null || level === "confirmed" || level === "finalized") {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for tx ${signature} confirmation`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}

/**
 * Assert one decoded channel address matches its challenge-bound value.
 *
 * @param label - Field name used in the error
 * @param actual - Decoded onchain address
 * @param expected - Challenge-bound address
 */
function assertChannelAddress(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`channel ${label} ${actual} != expected ${expected}`);
  }
}

/**
 * Compute the distribution commitment stored by the payment-channels program.
 *
 * @param splits - Ordered recipient splits
 * @returns SHA-256 of the program's canonical distribution preimage
 */
export function getChannelDistributionHash(splits: readonly ChannelSplit[]): Uint8Array {
  const hasher = createHash("sha256");
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, splits.length, true);
  hasher.update(count);

  for (const split of splits) {
    hasher.update(Uint8Array.from(getBase58Encoder().encode(split.recipient)));
    const bps = new Uint8Array(2);
    new DataView(bps.buffer).setUint16(0, split.bps, true);
    hasher.update(bps);
  }

  return hasher.digest();
}

/**
 * Partially sign and simulate a facilitator-built instruction list without
 * broadcasting. Always uses `sigVerify: false` (sims are never landed; the
 * open composite may carry a noop payer) and `replaceRecentBlockhash: true`.
 *
 * @param feePayer - The fee-payer signer
 * @param rpc - The RPC client
 * @param instructions - Instructions to simulate
 */
async function simulateInstructions(
  feePayer: UptoSvmSigner,
  rpc: ChannelRpc,
  instructions: readonly Instruction[],
): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latestBlockhash.blockhash as Blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        m,
      ),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const result = await rpc
    .simulateTransaction(wire, {
      commitment: "confirmed",
      encoding: "base64",
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (result.value.err) {
    const errorStr = JSON.stringify(result.value.err, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    throw new Error(`zero-charge settlement simulation failed: ${errorStr}`);
  }
}
