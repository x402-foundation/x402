import { Data, InlineDatum } from "@evolution-sdk/evolution";

import { LOVELACE_ASSET } from "../../constants";
import type { CardanoExtraMasumi } from "../../types";
import { masumiCollateralLovelace } from "./constants";
import { buildMasumiLockDatum, inlineDatum } from "./datum";

/**
 * Buyer-side inputs to the lock. Everything else in the datum comes from the
 * seller-signed `terms` — including `buyer_nonce` and `input_hash`, which the
 * seller signs, so the client must not invent them.
 */
export interface MasumiBuyerInput {
  /**
   * datum `buyer_return_address`. Buyer-chosen and never declared by the
   * server, so the facilitator does not match it against `extra`. Defaults to
   * absent (`None`). It MUST differ from the effective seller payout target.
   */
  buyerReturnAddress?: string;
}

/**
 * A built Masumi escrow lock: the inline datum plus the value the escrow output
 * must carry.
 */
export interface MasumiLock {
  /** The inline datum to attach to the `payTo` output. */
  datum: InlineDatum.InlineDatum;
  /** datum `collateral_return_lovelace`. */
  collateralLovelace: bigint;
  /** Lovelace on the escrow output: `requestedLovelace + collateralLovelace`. */
  lockedLovelace: bigint;
}

/**
 * The collateral is a datum field, so growing it grows the datum, which raises
 * the post-`SubmitResult` min-UTXO it has to clear. Re-deriving it a few times
 * reaches the fixed point; four rounds is far more than the one or two byte-length
 * changes a realistic integer encoding produces.
 */
const COLLATERAL_FIXED_POINT_ROUNDS = 4;

/**
 * Builds the Masumi `vested_pay` lock: the 19-field inline datum and the
 * lovelace the escrow output must carry.
 *
 * The seller never supplies or signs `collateral_return_lovelace` — the client
 * computes it from the requested asset and live protocol parameters so that
 * `lockedLovelace = requestedLovelace + collateral` still clears the min-UTXO
 * of the datum **after** `SubmitResult`. Otherwise the seller could never spend
 * the escrow.
 *
 * @param extra - The masumi `extra` block from the payment requirements.
 * @param buyerAddress - The payer wallet bech32 address (datum `buyer`).
 * @param asset - The requested asset unit.
 * @param amount - The requested amount in the asset's smallest unit.
 * @param coinsPerUtxoByte - Live `coinsPerUtxoByte` protocol parameter.
 * @param buyerInput - Buyer-side datum inputs.
 * @returns The inline datum and the escrow output's value.
 */
export function buildMasumiLock(
  extra: CardanoExtraMasumi,
  buyerAddress: string,
  asset: string,
  amount: bigint,
  coinsPerUtxoByte: bigint,
  buyerInput: MasumiBuyerInput = {},
): MasumiLock {
  const { terms } = extra;
  const isLovelace = asset.toLowerCase() === LOVELACE_ASSET;
  const requestedLovelace = isLovelace ? amount : 0n;
  const nativeTokenCount = isLovelace ? 0 : 1;

  /**
   * Builds the datum for a candidate collateral.
   *
   * @param collateral - The candidate `collateral_return_lovelace`.
   * @returns The Plutus datum.
   */
  const build = (collateral: bigint): Data.Data =>
    buildMasumiLockDatum({
      buyerAddress,
      sellerAddress: terms.sellerAddress,
      buyerReturnAddress: buyerInput.buyerReturnAddress,
      sellerReturnAddress: terms.sellerReturnAddress,
      referenceKey: extra.referenceKey,
      referenceSignature: extra.referenceSignature,
      sellerNonce: terms.sellerNonce,
      buyerNonce: terms.buyerNonce,
      agentIdentifier: typeof terms.agentIdentifier === "string" ? terms.agentIdentifier : "",
      collateralReturnLovelace: collateral,
      inputHash: terms.inputHash,
      payByTime: BigInt(terms.payByTime),
      submitResultTime: BigInt(terms.submitResultTime),
      unlockTime: BigInt(terms.unlockTime),
      externalDisputeUnlockTime: BigInt(terms.externalDisputeUnlockTime),
    });

  let collateral = 0n;
  let datum = build(collateral);
  let converged = false;
  for (let round = 0; round < COLLATERAL_FIXED_POINT_ROUNDS; round++) {
    const needed = masumiCollateralLovelace(
      requestedLovelace,
      Data.toCBORHex(datum).length / 2,
      nativeTokenCount,
      coinsPerUtxoByte,
    );
    // The current datum already clears its own min-UTXO at this collateral.
    if (needed <= collateral) {
      converged = true;
      break;
    }
    collateral = needed;
    datum = build(collateral);
  }
  if (!converged) {
    throw new Error("Masumi collateral did not converge; refusing to build an unspendable lock");
  }

  return {
    datum: inlineDatum(datum),
    collateralLovelace: collateral,
    lockedLovelace: requestedLovelace + collateral,
  };
}
