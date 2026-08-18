/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/types/voucherArgs.ts
 */

import {
  type Address,
  combineCodec,
  type FixedSizeCodec,
  type FixedSizeDecoder,
  type FixedSizeEncoder,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getStructDecoder,
  getStructEncoder,
  getU8Decoder,
  getU8Encoder,
} from "@solana/kit";

import { getI64Decoder, getI64Encoder, getU64Decoder, getU64Encoder } from "../safe-codecs";

export type VoucherArgs = {
  magic: Array<number>;
  channelId: Address;
  cumulativeAmount: bigint;
  expiresAt: bigint;
};

export type VoucherArgsArgs = VoucherArgs;

/**
 *
 */
export function getVoucherArgsEncoder(): FixedSizeEncoder<VoucherArgsArgs> {
  return getStructEncoder([
    ["magic", getArrayEncoder(getU8Encoder(), { size: 2 })],
    ["channelId", getAddressEncoder()],
    ["cumulativeAmount", getU64Encoder()],
    ["expiresAt", getI64Encoder()],
  ]);
}

/**
 *
 */
export function getVoucherArgsDecoder(): FixedSizeDecoder<VoucherArgs> {
  return getStructDecoder([
    ["magic", getArrayDecoder(getU8Decoder(), { size: 2 })],
    ["channelId", getAddressDecoder()],
    ["cumulativeAmount", getU64Decoder()],
    ["expiresAt", getI64Decoder()],
  ]);
}

/**
 *
 */
export function getVoucherArgsCodec(): FixedSizeCodec<VoucherArgsArgs, VoucherArgs> {
  return combineCodec(getVoucherArgsEncoder(), getVoucherArgsDecoder());
}
