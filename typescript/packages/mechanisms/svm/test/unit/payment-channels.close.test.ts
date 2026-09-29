import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import { MAX_MEMO_BYTES } from "../../src/constants";
import {
  buildRequestCloseTransaction,
  verifyRequestCloseTransaction,
} from "../../src/payment-channels/close";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

const BLOCKHASH = USDC_MAINNET_ADDRESS;
const CHANNEL = USDC_DEVNET_ADDRESS;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let other: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  other = await generateKeyPairSigner();
});

async function transaction(memo?: string, programId?: string) {
  return buildRequestCloseTransaction({
    blockhash: { blockhash: BLOCKHASH, lastValidBlockHeight: 1n },
    channelId: CHANNEL,
    feePayer: feePayer.address,
    memo,
    payer,
    programId,
  });
}

describe("payment channel request-close boundaries", () => {
  it("builds and verifies nonce and explicit memo variants", async () => {
    await expect(
      verifyRequestCloseTransaction(await transaction(), {
        channelId: CHANNEL,
        feePayer: feePayer.address,
        payer: payer.address,
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyRequestCloseTransaction(await transaction("invoice"), {
        channelId: CHANNEL,
        feePayer: feePayer.address,
        memo: "invoice",
        payer: payer.address,
      }),
    ).resolves.toBeUndefined();
  });

  it("supports an explicitly selected payment-channel program", async () => {
    await expect(
      verifyRequestCloseTransaction(await transaction("custom", PAYMENT_CHANNELS_PROGRAM_ID), {
        channelId: CHANNEL,
        feePayer: feePayer.address,
        memo: "custom",
        payer: payer.address,
        programId: PAYMENT_CHANNELS_PROGRAM_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects envelope and binding substitutions", async () => {
    const encoded = await transaction("invoice");
    const cases = [
      {
        expected: {
          channelId: CHANNEL,
          feePayer: payer.address,
          memo: "invoice",
          payer: payer.address,
        },
        message: /payer must differ/,
      },
      {
        expected: {
          channelId: CHANNEL,
          feePayer: other.address,
          memo: "invoice",
          payer: payer.address,
        },
        message: /required signers|fee payer mismatch/,
      },
      {
        expected: {
          channelId: CHANNEL,
          feePayer: feePayer.address,
          memo: "invoice",
          payer: other.address,
        },
        message: /required signers/,
      },
      {
        expected: {
          channelId: other.address,
          feePayer: feePayer.address,
          memo: "invoice",
          payer: payer.address,
        },
        message: /account binding mismatch/,
      },
      {
        expected: {
          channelId: CHANNEL,
          feePayer: feePayer.address,
          memo: "other",
          payer: payer.address,
        },
        message: /memo mismatch/,
      },
      {
        expected: { channelId: CHANNEL, feePayer: feePayer.address, payer: payer.address },
        message: /nonce memo must be hexadecimal/,
      },
      {
        expected: {
          channelId: CHANNEL,
          feePayer: feePayer.address,
          memo: "invoice",
          payer: payer.address,
          programId: other.address,
        },
        message: /unexpected instruction before request_close/,
      },
    ];
    for (const { expected, message } of cases) {
      await expect(verifyRequestCloseTransaction(encoded, expected)).rejects.toThrow(message);
    }
  });

  it("rejects a memo above the byte limit", async () => {
    await expect(transaction("x".repeat(MAX_MEMO_BYTES + 1))).rejects.toThrow(/exceeds maximum/);
  });
});
