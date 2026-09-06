/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/types/distributionEntry.ts
 */

import {
  type Address,
  combineCodec,
  type FixedSizeCodec,
  type FixedSizeDecoder,
  type FixedSizeEncoder,
  getAddressDecoder,
  getAddressEncoder,
  getStructDecoder,
  getStructEncoder,
} from "@solana/kit";

import { getU16Decoder, getU16Encoder } from "../safe-codecs";

export type DistributionEntry = { bps: number; recipient: Address };

export type DistributionEntryArgs = DistributionEntry;

/**
 *
 */
export function getDistributionEntryEncoder(): FixedSizeEncoder<DistributionEntryArgs> {
  return getStructEncoder([
    ["recipient", getAddressEncoder()],
    ["bps", getU16Encoder()],
  ]);
}

/**
 *
 */
export function getDistributionEntryDecoder(): FixedSizeDecoder<DistributionEntry> {
  return getStructDecoder([
    ["recipient", getAddressDecoder()],
    ["bps", getU16Decoder()],
  ]);
}

/**
 *
 */
export function getDistributionEntryCodec(): FixedSizeCodec<
  DistributionEntryArgs,
  DistributionEntry
> {
  return combineCodec(getDistributionEntryEncoder(), getDistributionEntryDecoder());
}
