import {
  ERR_FEE_BELOW_MINIMUM,
  ERR_INPUT_VALUE_UNAVAILABLE,
  ERR_VALUE_NOT_CONSERVED,
} from "../../constants";
import type { CardanoProtocolParameters, CardanoUtxoSnapshot } from "../../signer";
import type { DecodedCardanoTransaction } from "../../types";

/** Outcome of one built-in phase-1 check. */
export type Phase1Check = { ok: true } | { ok: false; reason: string; detail: string };

/**
 * Checks that the transaction conserves value: every lovelace and every native
 * asset its inputs carry must reappear in its outputs plus the fee. The ledger
 * rejects an unbalanced transaction at submission (`ValueNotConservedUTxO`), so
 * catching it in `verify()` keeps an unsettleable payment away from the handler.
 *
 * Only plain payments qualify: a transaction that mints, withdraws rewards,
 * carries certificates or governance deposits moves value the inputs do not
 * show, and the caller MUST NOT run this check on one.
 *
 * @param decoded - The decoded transaction.
 * @param inputs - Authenticated snapshots of every input, in input order.
 * @returns Success, or the rejection reason.
 */
export function checkValueConservation(
  decoded: DecodedCardanoTransaction,
  inputs: readonly CardanoUtxoSnapshot[],
): Phase1Check {
  let inputCoin = 0n;
  const inputAssets = new Map<string, bigint>();
  for (const [index, snapshot] of inputs.entries()) {
    if (snapshot.coin === undefined) {
      return {
        ok: false,
        reason: ERR_INPUT_VALUE_UNAVAILABLE,
        detail: `the chain layer reported no value for input ${decoded.inputs[index] ?? index}`,
      };
    }
    inputCoin += snapshot.coin;
    for (const [unit, quantity] of Object.entries(snapshot.assets ?? {})) {
      addAsset(inputAssets, unit, quantity);
    }
  }

  let outputCoin = decoded.fee;
  const outputAssets = new Map<string, bigint>();
  for (const output of decoded.outputs) {
    outputCoin += output.coin;
    for (const [unit, quantity] of Object.entries(output.assets)) {
      addAsset(outputAssets, unit, quantity);
    }
  }

  if (inputCoin !== outputCoin) {
    return {
      ok: false,
      reason: ERR_VALUE_NOT_CONSERVED,
      detail: `inputs carry ${inputCoin} lovelace but outputs and fee total ${outputCoin}`,
    };
  }
  for (const unit of new Set([...inputAssets.keys(), ...outputAssets.keys()])) {
    const consumed = inputAssets.get(unit) ?? 0n;
    const produced = outputAssets.get(unit) ?? 0n;
    if (consumed !== produced) {
      return {
        ok: false,
        reason: ERR_VALUE_NOT_CONSERVED,
        detail: `inputs carry ${consumed} of ${unit} but outputs carry ${produced}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Checks the transaction fee against the protocol floor
 * `minFeeConstant + minFeeCoefficient * size`. The floor ignores Plutus
 * execution and reference-script surcharges, so it is a necessary rather than
 * sufficient condition; a fee below it is rejected by every node.
 *
 * @param decoded - The decoded transaction.
 * @param parameters - Live protocol parameters.
 * @returns Success, or the rejection reason.
 */
export function checkMinimumFee(
  decoded: DecodedCardanoTransaction,
  parameters: CardanoProtocolParameters,
): Phase1Check {
  const minimum =
    parameters.minFeeConstant + parameters.minFeeCoefficient * BigInt(decoded.sizeBytes);
  if (decoded.fee < minimum) {
    return {
      ok: false,
      reason: ERR_FEE_BELOW_MINIMUM,
      detail: `fee ${decoded.fee} is below the protocol minimum ${minimum} for ${decoded.sizeBytes} bytes`,
    };
  }
  return { ok: true };
}

/**
 * Accumulates one asset quantity into a unit-keyed map, ignoring zero entries
 * so an explicit zero and an absent unit compare equal.
 *
 * @param target - The accumulator.
 * @param unit - Canonical `policyId.assetNameHex` unit.
 * @param quantity - Quantity to add.
 */
function addAsset(target: Map<string, bigint>, unit: string, quantity: bigint): void {
  if (quantity === 0n) return;
  const key = unit.toLowerCase();
  target.set(key, (target.get(key) ?? 0n) + quantity);
}
