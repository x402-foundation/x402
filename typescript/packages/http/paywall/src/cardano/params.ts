import type { Cip30ProtocolParameters } from "@x402/cardano";
import type { InjectedProtocolParameters } from "./protocolParams";

/**
 * Converts a Koios cost model array into the index-keyed record the Evolution
 * builder uses.
 *
 * @param model - Cost model values in order.
 * @returns `{ "0": v0, "1": v1, ... }`.
 */
function indexed(model: number[]): Record<string, number> {
  return Object.fromEntries(model.map((value, index) => [index.toString(), value]));
}

/**
 * Turns the server-injected (JSON-safe) parameters back into the shape the
 * CIP-30 signer takes. The signer bounds them again before any wallet call.
 *
 * @param p - Injected parameters.
 * @returns Signer protocol parameters.
 */
export function toCip30ProtocolParameters(p: InjectedProtocolParameters): Cip30ProtocolParameters {
  return {
    minFeeA: p.minFeeA,
    minFeeB: p.minFeeB,
    maxTxSize: p.maxTxSize,
    maxValSize: p.maxValSize,
    keyDeposit: BigInt(p.keyDeposit),
    poolDeposit: BigInt(p.poolDeposit),
    drepDeposit: BigInt(p.drepDeposit),
    govActionDeposit: BigInt(p.govActionDeposit),
    priceMem: p.priceMem,
    priceStep: p.priceStep,
    maxTxExMem: BigInt(p.maxTxExMem),
    maxTxExSteps: BigInt(p.maxTxExSteps),
    coinsPerUtxoByte: BigInt(p.coinsPerUtxoByte),
    collateralPercentage: p.collateralPercentage,
    maxCollateralInputs: p.maxCollateralInputs,
    minFeeRefScriptCostPerByte: p.minFeeRefScriptCostPerByte,
    costModels: {
      PlutusV1: indexed(p.costModels.PlutusV1),
      PlutusV2: indexed(p.costModels.PlutusV2),
      PlutusV3: indexed(p.costModels.PlutusV3),
    },
  };
}
