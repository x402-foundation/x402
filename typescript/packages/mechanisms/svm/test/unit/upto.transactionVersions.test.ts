/**
 * Transaction message version negotiation for `upto` and the shared
 * payment-channels open transaction. The version gate is exercised with a
 * genuine transaction-v1 wire payload, which `@solana/kit` >= 8 decodes.
 */
import {
  generateKeyPairSigner,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import { verifyRequestCloseTransaction } from "../../src/payment-channels/close";
import {
  buildOpenPaymentChannelTransaction,
  verifyOpenTransaction,
  verifyTopUpTransaction,
} from "../../src/payment-channels/open";
import { resolveTransactionVersion } from "../../src/utils";
import { buildVersion1WireTransaction } from "./helpers/signedTransaction";

const DUMMY_BLOCKHASH = USDC_DEVNET_ADDRESS;

function wireVersion(transactionBase64: string): number | string {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version;
}

async function openTransaction() {
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
    transactionVersion: resolveTransactionVersion({ transactionVersions: [0] }),
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

describe("payment-channels open builder", () => {
  it("builds a version 0 open transaction", async () => {
    const { open } = await openTransaction();
    expect(wireVersion(open.transaction)).toBe(0);
  });
});

describe("verifyOpenTransaction version gate", () => {
  it("rejects a real version 1 message before layout checks", async () => {
    const { open, expected, payer, feePayer } = await openTransaction();
    const v1 = await buildVersion1WireTransaction({ feePayer: feePayer.address, payer });
    expect(wireVersion(v1)).toBe(1);

    // The v1 payload has no ComputeBudget prefix and no `open` instruction; a
    // layout error would name one of those, so the version prefix proves the
    // gate ran first.
    await expect(verifyOpenTransaction(v1, expected)).rejects.toThrow(
      /^unsupported_transaction_version/,
    );

    await expect(verifyOpenTransaction(open.transaction, expected)).resolves.toMatchObject({
      channelId: open.channelId,
    });
  });
});

describe("payment-channels top-up and close version gates", () => {
  it("rejects a real version 1 top-up before layout checks", async () => {
    const { open, expected, payer, feePayer } = await openTransaction();
    const v1 = await buildVersion1WireTransaction({ feePayer: feePayer.address, payer });
    expect(wireVersion(v1)).toBe(1);
    await expect(
      verifyTopUpTransaction(v1, {
        ...expected,
        channelId: open.channelId,
        amount: 1n,
        maxPriorityFeeMicroLamports: 0,
      }),
    ).rejects.toThrow(/^unsupported_transaction_version/);
  });

  it("rejects a real version 1 close before signer and layout checks", async () => {
    const { open, payer, feePayer } = await openTransaction();
    const v1 = await buildVersion1WireTransaction({ feePayer: feePayer.address, payer });
    expect(wireVersion(v1)).toBe(1);
    await expect(
      verifyRequestCloseTransaction(v1, {
        payer: payer.address,
        feePayer: feePayer.address,
        channelId: open.channelId,
        maxPriorityFeeMicroLamports: 0,
      }),
    ).rejects.toThrow(/^unsupported_transaction_version/);
  });
});
