/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/types/settleAndSealArgs.ts
 */

import {
  combineCodec,
  type FixedSizeCodec,
  type FixedSizeDecoder,
  type FixedSizeEncoder,
  getStructDecoder,
  getStructEncoder,
} from "@solana/kit";

import { getU8Decoder, getU8Encoder } from "../safe-codecs";

export type SettleAndSealArgs = {
  hasVoucher: number;
};

export type SettleAndSealArgsArgs = {
  hasVoucher: number;
};

/**
 *
 */
export function getSettleAndSealArgsEncoder(): FixedSizeEncoder<SettleAndSealArgsArgs> {
  return getStructEncoder([["hasVoucher", getU8Encoder()]]);
}

/**
 *
 */
export function getSettleAndSealArgsDecoder(): FixedSizeDecoder<SettleAndSealArgs> {
  return getStructDecoder([["hasVoucher", getU8Decoder()]]);
}

/**
 *
 */
export function getSettleAndSealArgsCodec(): FixedSizeCodec<
  SettleAndSealArgsArgs,
  SettleAndSealArgs
> {
  return combineCodec(getSettleAndSealArgsEncoder(), getSettleAndSealArgsDecoder());
}
