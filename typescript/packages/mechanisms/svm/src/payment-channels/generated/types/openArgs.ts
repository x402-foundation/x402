/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/types/openArgs.ts
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

import { getU32Decoder, getU32Encoder, getU64Decoder, getU64Encoder } from "../safe-codecs";
import {
  type DistributionEntry,
  type DistributionEntryArgs,
  getDistributionEntryDecoder,
  getDistributionEntryEncoder,
} from "./distributionEntry";

export type OpenArgs = {
  deposit: bigint;
  gracePeriod: number;
  openSlot: bigint;
  recipients: Array<DistributionEntry>;
  salt: bigint;
};

export type OpenArgsArgs = {
  deposit: bigint;
  gracePeriod: number;
  openSlot: bigint;
  recipients: Array<DistributionEntryArgs>;
  salt: bigint;
};

/**
 *
 */
export function getOpenArgsEncoder(): Encoder<OpenArgsArgs> {
  return getStructEncoder([
    ["salt", getU64Encoder()],
    ["deposit", getU64Encoder()],
    ["gracePeriod", getU32Encoder()],
    ["openSlot", getU64Encoder()],
    ["recipients", getArrayEncoder(getDistributionEntryEncoder())],
  ]);
}

/**
 *
 */
export function getOpenArgsDecoder(): Decoder<OpenArgs> {
  return getStructDecoder([
    ["salt", getU64Decoder()],
    ["deposit", getU64Decoder()],
    ["gracePeriod", getU32Decoder()],
    ["openSlot", getU64Decoder()],
    ["recipients", getArrayDecoder(getDistributionEntryDecoder())],
  ]);
}

/**
 *
 */
export function getOpenArgsCodec(): Codec<OpenArgsArgs, OpenArgs> {
  return combineCodec(getOpenArgsEncoder(), getOpenArgsDecoder());
}
