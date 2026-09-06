/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/types/distributeArgs.ts
 */

import {
  type Codec,
  combineCodec,
  type Decoder,
  type Encoder,
  getArrayDecoder,
  getArrayEncoder,
  getStructDecoder,
  getStructEncoder,
} from "@solana/kit";

import {
  type DistributionEntry,
  type DistributionEntryArgs,
  getDistributionEntryDecoder,
  getDistributionEntryEncoder,
} from "./distributionEntry";

export type DistributeArgs = { recipients: Array<DistributionEntry> };

export type DistributeArgsArgs = { recipients: Array<DistributionEntryArgs> };

/**
 *
 */
export function getDistributeArgsEncoder(): Encoder<DistributeArgsArgs> {
  return getStructEncoder([["recipients", getArrayEncoder(getDistributionEntryEncoder())]]);
}

/**
 *
 */
export function getDistributeArgsDecoder(): Decoder<DistributeArgs> {
  return getStructDecoder([["recipients", getArrayDecoder(getDistributionEntryDecoder())]]);
}

/**
 *
 */
export function getDistributeArgsCodec(): Codec<DistributeArgsArgs, DistributeArgs> {
  return combineCodec(getDistributeArgsEncoder(), getDistributeArgsDecoder());
}
