/**
 * Shared payment-channel facilitator mechanics: co-signing, broadcasting a
 * client `open`, simulating settlement readiness (atomic open + settle +
 * distribute before open), and submitting settle+distribute.
 *
 * Kept separate from the scheme orchestration so the onchain mechanics stay
 * readable. All RPC access is threaded in by the caller.
 */

import { createHash } from "node:crypto";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
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

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
} from "../constants";
import { fetchMaybeChannel, type Channel } from "./generated/accounts/channel";
import { AccountDiscriminator } from "./generated/types/accountDiscriminator";
import { ChannelStatus } from "./generated/types/channelStatus";
import {
  buildDistributeInstruction,
  buildSettleAndSealInstructions,
  type ServerInstruction,
} from "./onchain";
import type { ChannelSplit } from "./open";
import type { FacilitatorSvmSigner } from "../signer";
import { BLOCKHASH_COMMITMENT, STATE_COMMITMENT } from "../upto/shared";
import { createRpcClient } from "../utils";

/** Solana per-transaction compute-unit maximum. */
const MAX_TRANSACTION_COMPUTE_UNITS = 1_400_000;
/** Compute-unit limit for facilitator-built sims; sims raise the limit to the
 *  per-transaction max because the composite (open + settle + distribute) can
 *  exceed the client open's 400k ceiling. */
const SIM_COMPUTE_UNIT_LIMIT = MAX_TRANSACTION_COMPUTE_UNITS;
const CHANNEL_READ_MAX_ATTEMPTS = 5;
const CHANNEL_READ_INITIAL_BACKOFF_MS = 200;

/**
 * Default `SetComputeUnitLimit` for facilitator-submitted settlement
 * transactions: claim (`settle_and_seal` + optional Ed25519 precompile +
 * `distribute`), the zero-charge cancel, and rent-cleanup close/distribute.
 * A measured claim with a warm recipient ATA consumes ~21.6k CU; a distribute
 * that must recreate a closed recipient ATA adds ~25k. 100k keeps >2x
 * headroom over that worst case. Assumes standard SPL Token (or Token-2022
 * without execution extensions) behavior — mints with transfer hooks or other
 * compute-heavy extensions need an explicit
 * {@link SubmitSettleOptions.computeUnitLimit} override.
 */
export const DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT = 100_000;

/** Base `SetComputeUnitLimit` for a reclaim batch transaction. */
export const RECLAIM_COMPUTE_UNIT_BASE = 25_000;
/**
 * Additional compute units budgeted per `reclaim` instruction in a batch. A
 * measured reclaim consumes ~320 CU per channel and is mint-independent (the
 * escrow ATA is already closed by that point — `reclaim` only closes the
 * channel PDA and returns lamports), so 5k per channel is >15x margin.
 */
export const RECLAIM_COMPUTE_UNIT_PER_CHANNEL = 5_000;

/**
 * `SetComputeUnitLimit` for a reclaim batch of `channelCount` channels,
 * clamped to the per-transaction maximum.
 *
 * @param channelCount - Number of `reclaim` instructions in the batch
 * @returns The compute-unit limit for the batch transaction
 */
export function reclaimComputeUnitLimit(channelCount: number): number {
  return Math.min(
    RECLAIM_COMPUTE_UNIT_BASE + RECLAIM_COMPUTE_UNIT_PER_CHANNEL * channelCount,
    MAX_TRANSACTION_COMPUTE_UNITS,
  );
}

/** Signer capable of signing Solana transactions and raw Ed25519 messages. */
export type PaymentChannelSvmSigner = TransactionSigner & MessagePartialSigner;

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
  const info = await rpc
    .getAccountInfo(address(channelId), { commitment: STATE_COMMITMENT, encoding: "base64" })
    .send();
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
  for (let attempt = 1; attempt <= CHANNEL_READ_MAX_ATTEMPTS; attempt++) {
    const account = await fetchMaybeChannel(rpc, address(channelId), {
      commitment: STATE_COMMITMENT,
    });
    if (account.exists) {
      // Existing but invalid state is terminal: only account absence can be
      // caused by replica visibility lag.
      return verifyOpenChannelAccount(channelId, account.data, expected);
    }
    if (attempt === CHANNEL_READ_MAX_ATTEMPTS) {
      break;
    }

    const delayMs = CHANNEL_READ_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error(`channel ${channelId} does not exist`);
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
  if (channel.discriminator !== AccountDiscriminator.Channel) {
    throw new Error(`channel ${channelId} has an invalid account discriminator`);
  }
  if (channel.status !== ChannelStatus.Open) {
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
  onBroadcast?: (signature: string) => Promise<void>,
): Promise<string> {
  const wire = await facilitator.signTransaction(openTransactionBase64, feePayer, network);
  const signature = await facilitator.sendTransaction(wire, network);
  // Report the signature before confirming, so a caller that persists it can
  // reconcile even if this process dies mid-wait.
  await onBroadcast?.(signature);
  try {
    await facilitator.confirmTransaction(signature, network);
  } catch (error) {
    // The transaction is on the network; only its outcome is unknown. Carry
    // the signature out so the caller can record it and reconcile later
    // instead of broadcasting the same escrow a second time.
    throw new ChannelBroadcastConfirmationError(signature, error);
  }
  return signature;
}

/**
 * Thrown when a client transaction was broadcast but its confirmation could
 * not be observed.
 *
 * Not a failure: the transaction may still land. The caller must persist
 * {@link signature} and reconcile against it rather than rebroadcast, because
 * a second broadcast of a setup transaction would escrow twice.
 */
export class ChannelBroadcastConfirmationError extends Error {
  /**
   * @param signature - Signature of the transaction already on the network
   * @param cause - The confirmation error that interrupted the wait
   */
  constructor(
    readonly signature: string,
    readonly cause: unknown,
  ) {
    super(`broadcast ${signature} could not be confirmed: ${String(cause)}`);
    this.name = "ChannelBroadcastConfirmationError";
  }
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
  feePayer: PaymentChannelSvmSigner,
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
  feePayer: PaymentChannelSvmSigner,
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

/** Options for {@link submitSettle}. */
export interface SubmitSettleOptions {
  /**
   * `SetComputeUnitLimit` for the settlement transaction. Defaults to
   * {@link DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT} (100k), sized for standard SPL
   * Token settlement; raise it for compute-heavy Token-2022 extension mints
   * or unusually large distributions.
   */
  computeUnitLimit?: number | undefined;
  /**
   * Called with the signature once the transaction is on the network and
   * before its confirmation is awaited, so a caller can persist it and
   * reconcile later rather than broadcast the same work twice.
   */
  onBroadcast?: ((signature: string) => Promise<void>) | undefined;
  /**
   * Blockhash to pin the transaction to. Fetched through the caller's
   * transport when omitted; supply it to overlap the fetch with other reads.
   */
  latestBlockhash?: { blockhash: string; lastValidBlockHeight: bigint } | undefined;
  /**
   * `SetComputeUnitPrice` in microlamports per compute unit attached to the
   * settlement transaction; `0` omits the instruction. Defaults to
   * `DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (1).
   */
  computeUnitPriceMicroLamports?: number | undefined;
}

/**
 * Compile the settle+distribute instructions into a transaction signed by the
 * fee payer, broadcast it, and confirm. Other signers, such as the channel
 * payee on `settle_and_seal`, are carried by the instruction list.
 *
 * The transaction is prefixed with a statically sized `SetComputeUnitLimit`
 * and an optional `SetComputeUnitPrice`. Static sizing keeps the time-critical
 * claim free of extra RPC round-trips and failure modes; the limit is
 * operator-overridable for deployments outside the documented assumptions.
 *
 * @param feePayer - The fee-payer signer
 * @param rpc - The RPC client
 * @param instructions - settle_and_seal (+ optional Ed25519 precompile) then distribute
 * @param options - Compute-budget options
 * @returns The broadcast signature
 */
export async function submitSettle(
  feePayer: PaymentChannelSvmSigner,
  rpc: ChannelRpc,
  instructions: readonly ServerInstruction[],
  options: SubmitSettleOptions = {},
): Promise<Signature> {
  const { value: fetched } = await rpc
    .getLatestBlockhash({ commitment: BLOCKHASH_COMMITMENT })
    .send();
  const wire = await buildChannelTransaction(
    feePayer,
    { blockhash: fetched.blockhash, lastValidBlockHeight: fetched.lastValidBlockHeight },
    instructions,
    options,
  );
  const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, signature);
  return signature;
}

/** The subset of a facilitator signer a channel submission needs. */
export type ChannelSubmitSigner = {
  getLatestBlockhash?(
    network: string,
  ): Promise<{ blockhash: string; lastValidBlockHeight: bigint }>;
  simulateTransaction(transaction: string, network: string): Promise<unknown>;
  sendTransaction(transaction: string, network: string): Promise<string>;
  confirmTransaction(signature: string, network: string): Promise<unknown>;
};

/**
 * Thrown when explicit simulation rejects a channel transaction, so the caller
 * can report it as a settlement-simulation failure rather than a generic send
 * error. The transaction was never broadcast.
 */
export class ChannelSimulationError extends Error {
  constructor(readonly cause: unknown) {
    super(`channel transaction simulation failed: ${String(cause)}`);
    this.name = "ChannelSimulationError";
  }
}

/**
 * Sign, simulate, broadcast and confirm a channel transaction through the
 * facilitator signer.
 *
 * Simulation is explicit rather than left to the node's preflight, for two
 * reasons: a preflight rejection arrives as an opaque send error, and a batch
 * packs several channels into one transaction, so a caller that cannot tell
 * simulation from transport has no way to report which batch failed or why.
 * The signer then sends with preflight skipped, so the node does not simulate
 * the same bytes a second time.
 *
 * @param feePayer - Signs as the transaction fee payer
 * @param signer - Facilitator signer used for blockhash, simulate, send, confirm
 * @param network - CAIP-2 network to submit against
 * @param instructions - Channel instructions to submit
 * @param options - Compute budget and blockhash overrides
 * @returns The confirmed transaction signature
 */
export async function submitChannelTransactionWithSigner(
  feePayer: PaymentChannelSvmSigner,
  signer: ChannelSubmitSigner,
  network: string,
  instructions: readonly ServerInstruction[],
  options: SubmitSettleOptions = {},
): Promise<Signature> {
  if (typeof signer.getLatestBlockhash !== "function") {
    throw new Error(
      "submitChannelTransactionWithSigner requires getLatestBlockhash on the signer. " +
        "Use toFacilitatorSvmSigner() which provides all required methods.",
    );
  }
  const latestBlockhash = options.latestBlockhash ?? (await signer.getLatestBlockhash(network));
  const wire = await buildChannelTransaction(feePayer, latestBlockhash, instructions, options);
  try {
    await signer.simulateTransaction(wire, network);
  } catch (error) {
    throw new ChannelSimulationError(error);
  }
  const signature = (await signer.sendTransaction(wire, network)) as Signature;
  await options.onBroadcast?.(signature);
  try {
    await signer.confirmTransaction(signature, network);
  } catch (error) {
    if (error instanceof SettlementConfirmationTimeoutError) throw error;
    throw new SettlementConfirmationTimeoutError(signature);
  }
  return signature;
}

/** Build and sign the wire transaction both submission paths broadcast. */
async function buildChannelTransaction(
  feePayer: PaymentChannelSvmSigner,
  latestBlockhash: { blockhash: string; lastValidBlockHeight: bigint },
  instructions: readonly ServerInstruction[],
  options: SubmitSettleOptions,
): Promise<ReturnType<typeof getBase64EncodedWireTransaction>> {
  const computeUnitLimit = options.computeUnitLimit ?? DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT;
  const computeUnitPrice =
    options.computeUnitPriceMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  const computeBudgetIxs: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: computeUnitLimit }),
    ...(computeUnitPrice > 0
      ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })]
      : []),
  ];
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
    m => appendTransactionMessageInstructions([...computeBudgetIxs, ...instructions], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

/**
 * Thrown by {@link confirmSignature} when the polling budget elapses before
 * the transaction reaches `confirmed`. Distinct from an onchain rejection:
 * the transaction's fate is unknown, not failed — it may still land. Callers
 * must not treat this the same as a definite failure (e.g. must not assume
 * it is safe to retry the same settlement).
 */
export class SettlementConfirmationTimeoutError extends Error {
  /**
   * Create the error for a signature whose confirmation timed out.
   *
   * @param signature - The transaction signature whose confirmation timed out
   */
  constructor(readonly signature: Signature) {
    super(`timed out waiting for tx ${signature} confirmation`);
    this.name = "SettlementConfirmationTimeoutError";
  }
}

/**
 * Poll `getSignatureStatuses` until the signature reaches at least 'confirmed'.
 *
 * @param rpc - The RPC client
 * @param signature - The transaction signature
 * @param timeoutMs - Total time budget (default 30s)
 * @throws {SettlementConfirmationTimeoutError} If the timeout elapses with the outcome still unknown
 * @throws If the transaction failed onchain
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
      throw new SettlementConfirmationTimeoutError(signature);
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
  feePayer: PaymentChannelSvmSigner,
  rpc: ChannelRpc,
  instructions: readonly Instruction[],
): Promise<void> {
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: BLOCKHASH_COMMITMENT })
    .send();
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
      commitment: STATE_COMMITMENT,
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
