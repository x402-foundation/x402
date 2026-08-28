/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/instructions/settleAndSeal.ts
 *
 * Parsing helpers omitted; only the synchronous `getSettleAndSealInstruction`
 * builder is needed. The `@solana/program-client-core` import is replaced with
 * the vendored `account-meta` helper.
 */

import {
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  combineCodec,
  type FixedSizeCodec,
  type FixedSizeDecoder,
  type FixedSizeEncoder,
  getStructDecoder,
  getStructEncoder,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyAccount,
  type ReadonlySignerAccount,
  type ReadonlyUint8Array,
  type TransactionSigner,
  transformEncoder,
  type WritableAccount,
} from "@solana/kit";

import { getAccountMetaFactory, type ResolvedInstructionAccount } from "../account-meta";
import { PAYMENT_CHANNELS_PROGRAM_ADDRESS } from "../programs/paymentChannels";
import { getU8Decoder, getU8Encoder } from "../safe-codecs";
import {
  getSettleAndSealArgsDecoder,
  getSettleAndSealArgsEncoder,
  type SettleAndSealArgs,
  type SettleAndSealArgsArgs,
} from "../types/settleAndSealArgs";

export const SETTLE_AND_SEAL_DISCRIMINATOR = 4;

/**
 *
 */
export function getSettleAndSealDiscriminatorBytes(): ReadonlyUint8Array {
  return getU8Encoder().encode(SETTLE_AND_SEAL_DISCRIMINATOR);
}

export type SettleAndSealInstruction<
  TProgram extends string = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
  TAccountPayee extends AccountMeta<string> | string = string,
  TAccountChannel extends AccountMeta<string> | string = string,
  TAccountInstructionsSysvar extends AccountMeta<string> | string = string,
  TRemainingAccounts extends readonly AccountMeta<string>[] = [],
> = Instruction<TProgram> &
  InstructionWithAccounts<
    [
      TAccountPayee extends string
        ? AccountSignerMeta<TAccountPayee> & ReadonlySignerAccount<TAccountPayee>
        : TAccountPayee,
      TAccountChannel extends string ? WritableAccount<TAccountChannel> : TAccountChannel,
      TAccountInstructionsSysvar extends string
        ? ReadonlyAccount<TAccountInstructionsSysvar>
        : TAccountInstructionsSysvar,
      ...TRemainingAccounts,
    ]
  > &
  InstructionWithData<ReadonlyUint8Array>;

export type SettleAndSealInstructionData = {
  discriminator: number;
  settleAndSealArgs: SettleAndSealArgs;
};

export type SettleAndSealInstructionDataArgs = {
  settleAndSealArgs: SettleAndSealArgsArgs;
};

/**
 *
 */
export function getSettleAndSealInstructionDataEncoder(): FixedSizeEncoder<SettleAndSealInstructionDataArgs> {
  return transformEncoder(
    getStructEncoder([
      ["discriminator", getU8Encoder()],
      ["settleAndSealArgs", getSettleAndSealArgsEncoder()],
    ]),
    value => ({ ...value, discriminator: SETTLE_AND_SEAL_DISCRIMINATOR }),
  );
}

/**
 *
 */
export function getSettleAndSealInstructionDataDecoder(): FixedSizeDecoder<SettleAndSealInstructionData> {
  return getStructDecoder([
    ["discriminator", getU8Decoder()],
    ["settleAndSealArgs", getSettleAndSealArgsDecoder()],
  ]);
}

/**
 *
 */
export function getSettleAndSealInstructionDataCodec(): FixedSizeCodec<
  SettleAndSealInstructionDataArgs,
  SettleAndSealInstructionData
> {
  return combineCodec(
    getSettleAndSealInstructionDataEncoder(),
    getSettleAndSealInstructionDataDecoder(),
  );
}

export type SettleAndSealInput<
  TAccountPayee extends string = string,
  TAccountChannel extends string = string,
  TAccountInstructionsSysvar extends string = string,
> = {
  channel: Address<TAccountChannel>;
  instructionsSysvar: Address<TAccountInstructionsSysvar>;
  payee: TransactionSigner<TAccountPayee>;
  settleAndSealArgs: SettleAndSealInstructionDataArgs["settleAndSealArgs"];
};

/**
 *
 * @param input
 * @param config
 * @param config.programAddress
 */
export function getSettleAndSealInstruction<
  TAccountPayee extends string,
  TAccountChannel extends string,
  TAccountInstructionsSysvar extends string,
  TProgramAddress extends Address = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
>(
  input: SettleAndSealInput<TAccountPayee, TAccountChannel, TAccountInstructionsSysvar>,
  config?: { programAddress?: TProgramAddress },
): SettleAndSealInstruction<
  TProgramAddress,
  TAccountPayee,
  TAccountChannel,
  TAccountInstructionsSysvar
> {
  const programAddress = config?.programAddress ?? PAYMENT_CHANNELS_PROGRAM_ADDRESS;

  const originalAccounts = {
    channel: { isWritable: true, value: input.channel ?? null },
    instructionsSysvar: { isWritable: false, value: input.instructionsSysvar ?? null },
    payee: { isWritable: false, value: input.payee ?? null },
  };
  const accounts = originalAccounts as Record<
    keyof typeof originalAccounts,
    ResolvedInstructionAccount
  >;

  const args = { ...input };

  const getAccountMeta = getAccountMetaFactory(programAddress, "programId");
  return Object.freeze({
    accounts: [
      getAccountMeta("payee", accounts.payee),
      getAccountMeta("channel", accounts.channel),
      getAccountMeta("instructionsSysvar", accounts.instructionsSysvar),
    ],
    data: getSettleAndSealInstructionDataEncoder().encode(args as SettleAndSealInstructionDataArgs),
    programAddress,
  } as SettleAndSealInstruction<
    TProgramAddress,
    TAccountPayee,
    TAccountChannel,
    TAccountInstructionsSysvar
  >);
}
