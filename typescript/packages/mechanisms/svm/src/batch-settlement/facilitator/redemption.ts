/**
 * Facilitator-built redemption transactions (claim, settle, seal, refund):
 * the message version they are built in, the batch capacity that version
 * gives, and the compute budget sized for a batch.
 */
import type { Signature } from "@solana/kit";
import {
  ChannelSimulationError,
  facilitatorV1TransactionFits,
  resolveFacilitatorTransactionVersion,
  submitChannelTransactionWithSigner,
  type FacilitatorTransactionVersion,
  type PaymentChannelSvmSigner,
} from "../../payment-channels/facilitator";
import type { ServerInstruction } from "../../payment-channels/onchain";
import { BatchError } from "../errors";
import {
  MAX_CHANNELS_PER_SETTLE_TX,
  V1_MAX_CLAIM_CHANNELS,
  V1_MAX_SETTLE_CHANNELS,
} from "./constants";

/** Compute units budgeted for a redemption's shared work. */
export const REDEMPTION_COMPUTE_UNIT_BASE = 25_000;

/** Compute units budgeted per redemption instruction. */
export const REDEMPTION_COMPUTE_UNIT_PER_INSTRUCTION = 25_000;

/** Per-transaction compute unit ceiling. */
const MAX_TRANSACTION_COMPUTE_UNITS = 1_400_000;

/** Batch capacity the facilitator advertises as `maxClaimChannels` / `maxSettleChannels`. */
export interface RedemptionCapacity {
  maxClaimChannels: number;
  maxSettleChannels: number;
}

/** The redemption message version and the batch capacity it gives. */
export type RedemptionPolicy = RedemptionCapacity & { version: FacilitatorTransactionVersion };

/**
 * Resolve the configured facilitator transaction version and its capacity.
 * Anything but 0 or 1 throws.
 *
 * @param version - `config.facilitatorTransactionVersion`
 * @returns The version (`DEFAULT_FACILITATOR_TRANSACTION_VERSION` when unset)
 * with its claim and settle capacity
 */
export function redemptionPolicy(
  version: FacilitatorTransactionVersion | undefined,
): RedemptionPolicy {
  const resolved = resolveFacilitatorTransactionVersion(version);
  return { version: resolved, ...redemptionCapacity(resolved) };
}

/**
 * The claim and settle capacity of a redemption message version: four for
 * legacy and version 0, the version-1 capacities otherwise.
 *
 * @param version - Message version redemptions are built in
 * @returns Channels per claim and per settle transaction
 */
export function redemptionCapacity(version: FacilitatorTransactionVersion): RedemptionCapacity {
  return version === 1
    ? { maxClaimChannels: V1_MAX_CLAIM_CHANNELS, maxSettleChannels: V1_MAX_SETTLE_CHANNELS }
    : {
        maxClaimChannels: MAX_CHANNELS_PER_SETTLE_TX,
        maxSettleChannels: MAX_CHANNELS_PER_SETTLE_TX,
      };
}

/**
 * Submit options for a redemption: version 1 with a compute budget sized for
 * the batch (scheme_batch_settlement_svm.md "SHOULD set them to values sized
 * for the batch"), or the existing version-0 defaults.
 *
 * @param version - Message version redemptions are built in
 * @param instructionCount - Instructions in the redemption
 * @returns Options for the channel submit helpers
 */
export function redemptionSubmitOptions(
  version: FacilitatorTransactionVersion,
  instructionCount: number,
): { facilitatorTransactionVersion: FacilitatorTransactionVersion; computeUnitLimit?: number } {
  if (version !== 1) return { facilitatorTransactionVersion: 0 };
  return {
    facilitatorTransactionVersion: 1,
    computeUnitLimit: Math.min(
      REDEMPTION_COMPUTE_UNIT_BASE + REDEMPTION_COMPUTE_UNIT_PER_INSTRUCTION * instructionCount,
      MAX_TRANSACTION_COMPUTE_UNITS,
    ),
  };
}

/**
 * Build, simulate, broadcast and confirm one redemption transaction. A
 * version-1 batch within the advertised capacity that still does not fit (an
 * unusual channel shape) fails before anything is sent; it is never truncated.
 *
 * @param feePayer - Fee-payer signer for the transaction
 * @param signer - Facilitator signer used to simulate, send and confirm
 * @param network - CAIP-2 network to submit against
 * @param instructions - The batch's channel instructions
 * @param version - Message version to build
 * @param onPrepared - Called with the signature and wire before broadcast
 * @returns The confirmed signature
 */
export async function submitRedemptionTransaction(
  feePayer: PaymentChannelSvmSigner,
  signer: Parameters<typeof submitChannelTransactionWithSigner>[1],
  network: string,
  instructions: readonly ServerInstruction[],
  version: FacilitatorTransactionVersion,
  onPrepared: (signature: string, wire: string) => Promise<void>,
): Promise<Signature> {
  const options = { ...redemptionSubmitOptions(version, instructions.length), onPrepared };
  if (
    options.facilitatorTransactionVersion === 1 &&
    !facilitatorV1TransactionFits(feePayer, instructions, options)
  ) {
    throw new Error(`${BatchError.PAYLOAD_TYPE}: batch does not fit one transaction`);
  }
  try {
    return await submitChannelTransactionWithSigner(
      feePayer,
      signer,
      network,
      instructions,
      options,
    );
  } catch (error) {
    if (error instanceof ChannelSimulationError) {
      throw new Error(`${BatchError.SETTLEMENT_SIMULATION}: ${String(error.cause)}`);
    }
    throw error;
  }
}
