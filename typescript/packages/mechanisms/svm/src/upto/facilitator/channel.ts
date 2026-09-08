/**
 * Channel-flow glue for the `upto` facilitator: co-signing, broadcasting the
 * client `open`, simulating settlement readiness (atomic open + settle +
 * distribute before open), and submitting settle+distribute.
 *
 * Kept separate from the scheme orchestration so the onchain mechanics stay
 * readable. All RPC access is threaded in by the caller.
 */

import { sha256 } from "@noble/hashes/sha256";
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
} from "../../constants";
import { fetchMaybeChannel, type Channel } from "../../payment-channels/generated/accounts/channel";
import {
  buildDistributeInstruction,
  buildSettleAndSealInstructions,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import type { ChannelSplit } from "../../payment-channels/open";
import type { FacilitatorSvmSigner } from "../../signer";
import { TransactionOnchainFailureError } from "../../utils";
import { STATE_COMMITMENT } from "../shared";
import type { UptoFacilitatorSigner } from "./signer";

/** Payment-channels `AccountDiscriminator::Channel` (byte 0 is reserved for uninitialized accounts). */
const CHANNEL_ACCOUNT_DISCRIMINATOR = 1;
const CHANNEL_STATUS_OPEN = 0;
/** Solana per-transaction compute-unit maximum. */
const MAX_TRANSACTION_COMPUTE_UNITS = 1_400_000;
/** Compute-unit limit for facilitator-built sims; sims raise the limit to the
 *  per-transaction max because the composite (open + settle + distribute) can
 *  exceed the client open's 400k ceiling. */
const SIM_COMPUTE_UNIT_LIMIT = MAX_TRANSACTION_COMPUTE_UNITS;

/**
 * Channel reads can briefly lag a confirmed open when an RPC provider
 * serves transaction status and account state from different replicas.
 *
 * The backoff is linear, not exponential: replica lag is a small multiple of
 * Solana's ~400ms slot time, so doubling spends the budget on single waits
 * far longer than the lag being absorbed. The defaults sleep
 * 200/400/600/800/1000ms across 6 reads, totalling 3.0s.
 */
export const DEFAULT_CHANNEL_READ_MAX_ATTEMPTS = 6;
export const DEFAULT_CHANNEL_READ_BACKOFF_STEP_MS = 200;

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
export type UptoSvmSigner = TransactionSigner & MessagePartialSigner;

/** Placeholder blockhash for deposit composite sims (`replaceRecentBlockhash: true`). */
const SIM_PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

/**
 * Kit-compatible RPC adapter for generated account fetch helpers.
 *
 * @param signer - Upto facilitator signer
 * @param network - CAIP-2 network identifier
 * @returns Minimal RPC surface for {@link fetchMaybeChannel}
 */
export function accountFetchRpc(
  signer: UptoFacilitatorSigner,
  network: string,
): Parameters<typeof fetchMaybeChannel>[0] {
  return {
    getAccountInfo: (
      accountAddress: Address,
      config?: { commitment?: string; encoding?: string },
    ) => ({
      send: async () => ({
        context: { slot: 0n },
        value: await signer.getAccountInfo(accountAddress.toString(), network, {
          commitment: config?.commitment,
          encoding: config?.encoding,
        }),
      }),
    }),
  } as Parameters<typeof fetchMaybeChannel>[0];
}

/**
 * Whether the channel account already exists onchain (open already broadcast).
 *
 * @param signer - Facilitator signer with read RPC
 * @param network - CAIP-2 network identifier
 * @param channelId - Channel PDA (base58)
 * @returns Whether the account exists
 */
export async function channelExists(
  signer: UptoFacilitatorSigner,
  network: string,
  channelId: string,
): Promise<boolean> {
  const info = await signer.getAccountInfo(channelId, network, {
    commitment: STATE_COMMITMENT,
    encoding: "base64",
  });
  return info !== null;
}

/**
 * Bounds how long {@link fetchAndVerifyOpenChannel} waits for a confirmed open
 * to become visible. Unset / non-positive fields resolve to the package defaults.
 */
export interface ChannelReadPolicy {
  backoffStepMs?: number;
  maxAttempts?: number;
}

/**
 * Fill unset channel-read fields with the package defaults, so callers can
 * pass a zero value.
 *
 * @param policy - Optional attempt/backoff overrides
 * @returns Policy with positive defaults applied
 */
export function resolveChannelReadPolicy(
  policy: ChannelReadPolicy = {},
): Required<ChannelReadPolicy> {
  const maxAttempts = policy.maxAttempts ?? 0;
  const backoffStepMs = policy.backoffStepMs ?? 0;
  return {
    maxAttempts: maxAttempts > 0 ? maxAttempts : DEFAULT_CHANNEL_READ_MAX_ATTEMPTS,
    backoffStepMs: backoffStepMs > 0 ? backoffStepMs : DEFAULT_CHANNEL_READ_BACKOFF_STEP_MS,
  };
}

/**
 * How long to wait before the read following the given 1-based attempt.
 *
 * @param policy - Resolved channel-read policy
 * @param attempt - 1-based attempt that just observed a missing account
 * @returns Linear delay in milliseconds (`backoffStepMs * attempt`)
 */
export function delayAfterAttempt(policy: Required<ChannelReadPolicy>, attempt: number): number {
  return policy.backoffStepMs * attempt;
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
 * @param signer - Facilitator signer with read RPC
 * @param network - CAIP-2 network identifier
 * @param channelId - Channel PDA
 * @param expected - Challenge-bound channel terms
 * @param policy - Optional re-read attempt/backoff overrides
 * @returns Verified channel facts for settlement
 */
export async function fetchAndVerifyOpenChannel(
  signer: UptoFacilitatorSigner,
  network: string,
  channelId: string,
  expected: ExpectedOpenChannel,
  policy: ChannelReadPolicy = {},
): Promise<VerifiedOpenChannel> {
  const resolved = resolveChannelReadPolicy(policy);
  const rpc = accountFetchRpc(signer, network);
  for (let attempt = 1; attempt <= resolved.maxAttempts; attempt++) {
    const account = await fetchMaybeChannel(rpc, address(channelId), {
      commitment: STATE_COMMITMENT,
    });
    if (account.exists) {
      // Existing but invalid state is terminal: only account absence can be
      // caused by replica visibility lag.
      return verifyOpenChannelAccount(channelId, account.data, expected);
    }
    if (attempt === resolved.maxAttempts) {
      break;
    }

    const delayMs = delayAfterAttempt(resolved, attempt);
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
 * Thrown by {@link broadcastOpen} when the open transaction broadcast
 * successfully but `confirmTransaction`'s wait timed out (outcome still
 * unknown — a definite onchain failure propagates as
 * {@link TransactionOnchainFailureError} instead). Distinct from a sign/send
 * failure (nothing reached the chain, safe to retry): this carries the
 * broadcast `signature` so the caller can reconcile against it instead of
 * re-broadcasting (a second open would hit the channel-already-open check
 * even though the original open is, or will be, fine).
 */
export class ChannelOpenConfirmationError extends Error {
  /**
   * Create the error for an open broadcast whose confirmation failed.
   *
   * @param signature - The broadcast signature whose confirmation failed
   * @param cause - The underlying confirmation error
   */
  constructor(
    readonly signature: string,
    cause: unknown,
  ) {
    super(
      `failed to confirm channel open ${signature}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ChannelOpenConfirmationError";
  }
}

/**
 * Co-sign the fee-payer slot of a partially-signed open transaction,
 * broadcast it, and wait for confirmation. No-op skip is the caller's job
 * (see {@link channelExists}).
 *
 * Uses the wire-level FacilitatorSvmSigner methods (same path as exact).
 *
 * On a confirmation failure the broadcast signature is still surfaced (via
 * {@link ChannelOpenConfirmationError}), unlike a sign/send failure — so the
 * caller can distinguish "never landed, safe to retry with a fresh
 * broadcast" from "broadcast successfully but unconfirmed, must reconcile
 * against this signature instead of re-broadcasting."
 *
 * @param facilitator - Facilitator signer with wire sign/send/confirm
 * @param feePayer - Fee-payer address to co-sign with
 * @param network - CAIP-2 network identifier
 * @param openTransactionBase64 - The client-signed open transaction
 * @returns The broadcast signature
 * @throws {ChannelOpenConfirmationError} If the transaction broadcast but confirmation timed out
 * @throws {TransactionOnchainFailureError} If the transaction broadcast but failed onchain
 *   (terminal — the caller can safely retry with a fresh open)
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
  try {
    await facilitator.confirmTransaction(signature, network);
  } catch (error) {
    // A definite onchain rejection is terminal, unlike a confirmation
    // timeout: propagate it as-is (rather than wrapping in
    // ChannelOpenConfirmationError) so the caller's non-pending branch
    // handles it — a fresh open is safe to retry.
    if (error instanceof TransactionOnchainFailureError) {
      throw error;
    }
    throw new ChannelOpenConfirmationError(signature, error);
  }
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
 * @param signer - Facilitator signer (simulate RPC)
 * @param network - CAIP-2 network identifier
 * @param args - Open transaction and challenge-bound channel terms
 * @param args.openTransactionBase64 - Client-signed open transaction
 * @param args.channel - Challenge-bound channel terms for settle/distribute
 */
export async function simulateOpenSettleDistribute(
  feePayer: UptoSvmSigner,
  signer: Pick<FacilitatorSvmSigner, "simulateTransaction">,
  network: string,
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

  await simulateInstructions(feePayer, signer, network, instructions);
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
   * `SetComputeUnitPrice` in microlamports per compute unit attached to the
   * settlement transaction; `0` omits the instruction. Defaults to
   * `DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS` (1).
   */
  computeUnitPriceMicroLamports?: number | undefined;
  /**
   * Prefetched blockhash (e.g. from a parallel read in claim settle). When
   * omitted, {@link submitSettle} fetches one via the signer.
   */
  latestBlockhash?: { blockhash: string; lastValidBlockHeight: bigint } | undefined;
}

/**
 * Thrown by {@link submitSettle} when explicit simulation fails. The transaction
 * is never broadcast.
 */
export class SettlementSimulationError extends Error {
  /**
   * Create the error for a settlement simulation failure.
   *
   * @param cause - Underlying simulation error
   */
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SettlementSimulationError";
  }
}

/**
 * Compile the settle+distribute instructions into a transaction signed by the
 * fee payer, simulate it, broadcast via the facilitator signer, and confirm.
 * Other signers, such as the channel payee on `settle_and_seal`, are carried
 * by the instruction list.
 *
 * The transaction is prefixed with a statically sized `SetComputeUnitLimit`
 * and an optional `SetComputeUnitPrice`. Static sizing keeps the time-critical
 * claim free of extra RPC round-trips and failure modes; the limit is
 * operator-overridable for deployments outside the documented assumptions.
 *
 * @param feePayer - The fee-payer signer
 * @param signer - Facilitator signer (blockhash, simulate, send, confirm)
 * @param network - CAIP-2 network identifier
 * @param instructions - settle_and_seal (+ optional Ed25519 precompile) then distribute
 * @param options - Compute-budget options
 * @returns The broadcast signature
 */
export async function submitSettle(
  feePayer: UptoSvmSigner,
  signer: Pick<
    UptoFacilitatorSigner,
    "getLatestBlockhash" | "simulateTransaction" | "sendTransaction" | "confirmTransaction"
  >,
  network: string,
  instructions: readonly ServerInstruction[],
  options: SubmitSettleOptions = {},
): Promise<Signature> {
  const computeUnitLimit = options.computeUnitLimit ?? DEFAULT_SETTLE_COMPUTE_UNIT_LIMIT;
  const computeUnitPrice =
    options.computeUnitPriceMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  const computeBudgetIxs: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: computeUnitLimit }),
    ...(computeUnitPrice > 0
      ? [getSetComputeUnitPriceInstruction({ microLamports: computeUnitPrice })]
      : []),
  ];

  const latestBlockhash = options.latestBlockhash ?? (await signer.getLatestBlockhash(network));
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
  const wire = getBase64EncodedWireTransaction(signed);
  try {
    await signer.simulateTransaction(wire, network);
  } catch (error) {
    throw new SettlementSimulationError(error);
  }
  const signature = await signer.sendTransaction(wire, network);
  try {
    await signer.confirmTransaction(signature, network);
  } catch (error) {
    if (error instanceof TransactionOnchainFailureError) {
      throw error;
    }
    throw new SettlementConfirmationTimeoutError(signature as Signature);
  }
  return signature as Signature;
}

/**
 * Thrown by {@link submitSettle} when confirmation polling times out. Distinct
 * from an onchain rejection: the transaction's fate is unknown, not failed.
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
  const hasher = sha256.create();
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
 * @param signer - Facilitator signer (simulate RPC)
 * @param network - CAIP-2 network identifier
 * @param instructions - Instructions to simulate
 */
async function simulateInstructions(
  feePayer: UptoSvmSigner,
  signer: Pick<FacilitatorSvmSigner, "simulateTransaction">,
  network: string,
  instructions: readonly Instruction[],
): Promise<void> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: SIM_PLACEHOLDER_BLOCKHASH,
          lastValidBlockHeight: 0n,
        },
        m,
      ),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  try {
    await signer.simulateTransaction(wire, network, { replaceRecentBlockhash: true });
  } catch (error) {
    throw new Error(
      `zero-charge settlement simulation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
