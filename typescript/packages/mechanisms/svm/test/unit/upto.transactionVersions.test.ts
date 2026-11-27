/**
 * Transaction message versions for `upto` and the shared payment-channels
 * client transactions (open, top-up, request_close). Each is built as version
 * 0 and version 1 and checked by its verifier; version 1 carries its compute
 * budget in the message config, which the verifiers cap.
 */
import {
  appendTransactionMessageInstruction,
  compileTransaction,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { MEMO_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import {
  buildRequestCloseTransaction,
  verifyRequestCloseTransaction,
} from "../../src/payment-channels/close";
import {
  buildOpenPaymentChannelTransaction,
  buildTopUpPaymentChannelTransaction,
  verifyOpenTransaction,
  verifyTopUpTransaction,
} from "../../src/payment-channels/open";
import {
  DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  readTransactionV1Config,
  type BuildableTransactionVersion,
} from "../../src/transactionV1";
import { resolveTransactionVersion } from "../../src/utils";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";

const DUMMY_BLOCKHASH = USDC_DEVNET_ADDRESS;

function compiled(transactionBase64: string) {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
}

function wireVersion(transactionBase64: string): number | string {
  return compiled(transactionBase64).version;
}

/** Replace a version-1 wire transaction's version byte with 2. */
function retagAsVersion2(transactionBase64: string): string {
  const bytes = new Uint8Array(getBase64Codec().encode(transactionBase64));
  expect(bytes[0]).toBe(0x81);
  bytes[0] = 0x82;
  return getBase64Codec().decode(bytes);
}

/**
 * Append a Memo instruction of `bytes` bytes to a client transaction and
 * re-sign it as `payer`, keeping its message version: a payload over its
 * version's size limit that the builders refuse to produce.
 */
async function padded(transactionBase64: string, payer: KeyPairSigner, bytes: number) {
  const message = decompileTransactionMessage(compiled(transactionBase64));
  const withMemo = appendTransactionMessageInstruction(
    { programAddress: MEMO_PROGRAM_ADDRESS as Address, data: new Uint8Array(bytes).fill(97) },
    message,
  );
  const signed = await partiallySignTransaction(
    [payer.keyPair],
    compileTransaction(withMemo as never),
  );
  return getBase64EncodedWireTransaction(signed);
}

async function openTransaction(
  advertised: readonly number[] = [0],
  overrides: { computeUnitLimit?: number; computeUnitPriceMicroLamports?: number } = {},
) {
  const payer = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const receiverAuthorizer = await generateKeyPairSigner();
  const open = await buildOpenPaymentChannelTransaction({
    authorizedSigner: receiverAuthorizer.address,
    blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
    deposit: 1_000_000n,
    feePayer: feePayer.address,
    gracePeriod: 900,
    mint: USDC_DEVNET_ADDRESS,
    openSlot: 123_456_789n,
    payee: receiverAuthorizer.address,
    payer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    transactionVersion: resolveTransactionVersion({ transactionVersions: advertised }),
    ...overrides,
  });
  const expected = {
    authorizedSigner: receiverAuthorizer.address,
    feePayer: feePayer.address,
    from: payer.address,
    maxCap: 1_000_000n,
    mint: USDC_DEVNET_ADDRESS,
    openSlot: 123_456_789n,
    payee: receiverAuthorizer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
  };
  return { open, expected, payer, feePayer };
}

async function topUpTransaction(version: BuildableTransactionVersion) {
  const { open, expected, payer, feePayer } = await openTransaction();
  const topUp = await buildTopUpPaymentChannelTransaction({
    amount: 5n,
    blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
    channelId: open.channelId,
    feePayer: feePayer.address,
    mint: USDC_DEVNET_ADDRESS,
    payer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    transactionVersion: version,
  });
  const topUpExpected = {
    amount: 5n,
    channelId: open.channelId,
    feePayer: feePayer.address,
    from: payer.address,
    mint: USDC_DEVNET_ADDRESS,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  };
  return { topUp, topUpExpected, expected, payer };
}

async function closeTransaction(version: BuildableTransactionVersion) {
  const { open, payer, feePayer } = await openTransaction();
  const transaction = await buildRequestCloseTransaction({
    blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
    channelId: open.channelId,
    feePayer: feePayer.address,
    payer,
    transactionVersion: version,
  });
  const closeExpected = {
    channelId: open.channelId,
    feePayer: feePayer.address,
    payer: payer.address,
  };
  return { transaction, closeExpected, payer };
}

describe("payment-channels open builder", () => {
  it("builds a version 0 open transaction when only version 0 is advertised", async () => {
    const { open } = await openTransaction([0]);
    expect(wireVersion(open.transaction)).toBe(0);
  });

  it("builds a version 1 open with its budget in the message config", async () => {
    const { open } = await openTransaction([0, 1]);
    expect(wireVersion(open.transaction)).toBe(1);
    expect(readTransactionV1Config(compiled(open.transaction))).toMatchObject({
      computeUnitLimit: 200_000,
      loadedAccountsDataSizeLimit: DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
      // 1 microlamport/CU over 200k CU rounds up to 1 lamport.
      priorityFeeLamports: 1n,
    });
  });

  it("refuses a version 1 open without a compute unit limit", async () => {
    await expect(openTransaction([1], { computeUnitLimit: 0 })).rejects.toThrow(
      /must set a positive computeUnitLimit/,
    );
  });
});

describe("verifyOpenTransaction across versions", () => {
  it.each([[[0]], [[0, 1]]])("accepts the open built for %j", async advertised => {
    const { open, expected } = await openTransaction(advertised);
    await expect(verifyOpenTransaction(open.transaction, expected)).resolves.toMatchObject({
      channelId: open.channelId,
    });
  });

  it("caps a version 1 open's compute unit limit", async () => {
    const { open, expected } = await openTransaction([1]);
    await expect(
      verifyOpenTransaction(open.transaction, { ...expected, maxComputeUnits: 100_000 }),
    ).rejects.toThrow(/compute_unit_limit_too_high/);
  });

  it("caps a version 1 open's priority fee", async () => {
    const { open, expected } = await openTransaction([1], {
      computeUnitPriceMicroLamports: 1_000,
    });
    // 1,000 microlamports/CU over 200k CU is 200 lamports; a 999 microlamports/CU cap allows 199.8.
    await expect(
      verifyOpenTransaction(open.transaction, { ...expected, maxPriorityFeeMicroLamports: 999 }),
    ).rejects.toThrow(/priority_fee_too_high/);
    await expect(
      verifyOpenTransaction(open.transaction, { ...expected, maxPriorityFeeMicroLamports: 1_000 }),
    ).resolves.toMatchObject({ channelId: open.channelId });
  });

  it("rejects an unknown version 2 open before layout checks", async () => {
    const { open, expected } = await openTransaction([1]);
    await expect(
      verifyOpenTransaction(retagAsVersion2(open.transaction), expected),
    ).rejects.toThrow(/^unsupported_transaction_version|version 2/);
  });
});

describe("payment-channels top-up and close across versions", () => {
  it.each([0, 1] as const)("verifies a version %s top-up", async version => {
    const { topUp, topUpExpected } = await topUpTransaction(version);
    expect(wireVersion(topUp.transaction)).toBe(version);
    await expect(verifyTopUpTransaction(topUp.transaction, topUpExpected)).resolves.toBeUndefined();
  });

  it("caps a version 1 top-up's priority fee", async () => {
    const { topUp, topUpExpected } = await topUpTransaction(1);
    await expect(
      verifyTopUpTransaction(topUp.transaction, {
        ...topUpExpected,
        maxPriorityFeeMicroLamports: 0,
      }),
    ).rejects.toThrow(/priority_fee_too_high/);
  });

  it.each([0, 1] as const)("verifies a version %s request_close", async version => {
    const { transaction, closeExpected } = await closeTransaction(version);
    expect(wireVersion(transaction)).toBe(version);
    await expect(
      verifyRequestCloseTransaction(transaction, closeExpected),
    ).resolves.toBeUndefined();
  });

  it("caps a version 1 request_close's compute unit limit", async () => {
    const { transaction, closeExpected } = await closeTransaction(1);
    await expect(
      verifyRequestCloseTransaction(transaction, { ...closeExpected, maxComputeUnits: 100_000 }),
    ).rejects.toThrow(/compute_unit_limit_too_high/);
  });

  it("rejects an unknown version 2 top-up and request_close", async () => {
    const { topUp, topUpExpected } = await topUpTransaction(1);
    await expect(
      verifyTopUpTransaction(retagAsVersion2(topUp.transaction), topUpExpected),
    ).rejects.toThrow();
    const { transaction, closeExpected } = await closeTransaction(1);
    await expect(
      verifyRequestCloseTransaction(retagAsVersion2(transaction), closeExpected),
    ).rejects.toThrow();
  });
});

describe("payment-channel verifiers enforce the size limit of the message version", () => {
  it.each([
    [0, 1300],
    [1, 4200],
  ] as const)("rejects a version %s open padded to about %s bytes", async (version, target) => {
    const { open, expected, payer } = await openTransaction([version]);
    const size = getBase64Codec().encode(open.transaction).byteLength;
    const oversized = await padded(open.transaction, payer, target - size);
    expect(wireVersion(oversized)).toBe(version);
    await expect(verifyOpenTransaction(oversized, expected)).rejects.toThrow(
      /verifyOpenTransaction: transaction is \d+ bytes, above the (1232|4096)-byte limit/,
    );
  });

  it("accepts a version 1 open above 1232 bytes", async () => {
    const { open, expected, payer } = await openTransaction([1]);
    const size = getBase64Codec().encode(open.transaction).byteLength;
    const larger = await padded(open.transaction, payer, 1400 - size);
    expect(getBase64Codec().encode(larger).byteLength).toBeGreaterThan(1232);
    await expect(verifyOpenTransaction(larger, expected)).resolves.toMatchObject({
      channelId: open.channelId,
    });
  });

  it("rejects an oversized version 0 top-up", async () => {
    const { topUp, topUpExpected, payer } = await topUpTransaction(0);
    const oversized = await padded(topUp.transaction, payer, 1300);
    await expect(verifyTopUpTransaction(oversized, topUpExpected)).rejects.toThrow(
      /verifyTopUpTransaction: transaction is \d+ bytes, above the 1232-byte limit for version 0/,
    );
  });

  it("rejects an oversized version 1 request_close", async () => {
    const { transaction, closeExpected, payer } = await closeTransaction(1);
    const oversized = await padded(transaction, payer, 4200);
    await expect(verifyRequestCloseTransaction(oversized, closeExpected)).rejects.toThrow(
      /verifyRequestCloseTransaction: transaction is \d+ bytes, above the 4096-byte limit for version 1/,
    );
  });
});

describe("payment-channel verifiers enforce the facilitator's accepted versions", () => {
  it("refuses a version 1 open, top-up and request_close when only version 0 is accepted", async () => {
    const { open, expected } = await openTransaction([0, 1]);
    await expect(
      verifyOpenTransaction(open.transaction, { ...expected, acceptedTransactionVersions: [0] }),
    ).rejects.toThrow(/^unsupported_transaction_version: .*accepted versions: legacy, 0$/);
    const { topUp, topUpExpected } = await topUpTransaction(1);
    await expect(
      verifyTopUpTransaction(topUp.transaction, {
        ...topUpExpected,
        acceptedTransactionVersions: [0],
      }),
    ).rejects.toThrow(/^unsupported_transaction_version/);
    const { transaction, closeExpected } = await closeTransaction(1);
    await expect(
      verifyRequestCloseTransaction(transaction, {
        ...closeExpected,
        acceptedTransactionVersions: [0],
      }),
    ).rejects.toThrow(/^unsupported_transaction_version/);
  });

  it("refuses a version 0 open when only version 1 is accepted", async () => {
    const { open, expected } = await openTransaction([0]);
    await expect(
      verifyOpenTransaction(open.transaction, { ...expected, acceptedTransactionVersions: [1] }),
    ).rejects.toThrow(/^unsupported_transaction_version: .*accepted versions: 1$/);
  });
});

describe("verifyOpenTransaction decodes the open args in full", () => {
  it("refuses a byte after the open args", async () => {
    const { open, expected, payer } = await openTransaction([0]);
    const message = decompileTransactionMessage(compiled(open.transaction));
    const instructions = message.instructions.map(instruction =>
      instruction.programAddress === PAYMENT_CHANNELS_PROGRAM_ID
        ? { ...instruction, data: new Uint8Array([...(instruction.data ?? []), 0]) }
        : instruction,
    );
    const signed = await partiallySignTransaction(
      [payer.keyPair],
      compileTransaction({ ...message, instructions } as never),
    );
    await expect(
      verifyOpenTransaction(getBase64EncodedWireTransaction(signed), expected),
    ).rejects.toThrow(/1 trailing bytes after the open args/);
  });
});
