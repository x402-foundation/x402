import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  type Instruction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";

import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
} from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { verifyRequestCloseTransaction } from "../../src/payment-channels/close";
import {
  getRequestCloseInstruction,
  REQUEST_CLOSE_DISCRIMINATOR,
} from "../../src/payment-channels/generated/instructions/requestClose";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { OPEN_MAX_COMPUTE_UNIT_LIMIT } from "../../src/payment-channels/open";

const BLOCKHASH = USDC_MAINNET_ADDRESS as Blockhash;
const CHANNEL = USDC_DEVNET_ADDRESS;
const PROGRAM = address(PAYMENT_CHANNELS_PROGRAM_ID);

let payer: TransactionSigner;
let feePayer: TransactionSigner;
let bystander: TransactionSigner;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  bystander = await generateKeyPairSigner();
});

/** Assemble and payer-sign an arbitrary instruction list behind `txFeePayer`. */
async function wire(instructions: Instruction[], txFeePayer: string = feePayer.address) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    value => setTransactionMessageFeePayer(address(txFeePayer), value),
    value =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 1n },
        value,
      ),
    value => appendTransactionMessageInstructions(instructions, value),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

function close(): Instruction {
  return getRequestCloseInstruction(
    { channel: address(CHANNEL), payer },
    { programAddress: PROGRAM },
  ) as Instruction;
}

function memo(text = "0123456789abcdef0123456789abcdef"): Instruction {
  return {
    accounts: [],
    data: new TextEncoder().encode(text),
    programAddress: MEMO_PROGRAM_ADDRESS as Address,
  };
}

function lighthouse(account: string = bystander.address): Instruction {
  return {
    accounts: [{ address: address(account), role: AccountRole.READONLY }],
    data: new Uint8Array([1]),
    programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address,
  };
}

function rawBudget(data: number[], accounts: Instruction["accounts"] = []): Instruction {
  return {
    accounts,
    data: new Uint8Array(data),
    programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS as Address,
  };
}

function expected(overrides: Record<string, unknown> = {}) {
  return { channelId: CHANNEL, feePayer: feePayer.address, payer: payer.address, ...overrides };
}

describe("request-close envelope verification", () => {
  it("accepts a capped Compute Budget prefix and a Lighthouse suffix", async () => {
    const encoded = await wire([
      getSetComputeUnitLimitInstruction({ units: 10_000 }) as Instruction,
      getSetComputeUnitPriceInstruction({ microLamports: 1_000 }) as Instruction,
      close(),
      lighthouse(),
      memo(),
    ]);
    await expect(verifyRequestCloseTransaction(encoded, expected())).resolves.toBeUndefined();
    // Operator caps below the spec maxima still admit a compliant prefix.
    await expect(
      verifyRequestCloseTransaction(
        encoded,
        expected({ maxComputeUnits: 20_000, maxPriorityFeeMicroLamports: 2_000 }),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects Compute Budget instructions outside the sponsor's policy", async () => {
    const cases: [Instruction[], RegExp][] = [
      [
        [
          getSetComputeUnitLimitInstruction({
            units: OPEN_MAX_COMPUTE_UNIT_LIMIT + 1,
          }) as Instruction,
        ],
        /compute unit limit exceeds sponsor cap/,
      ],
      [
        [
          getSetComputeUnitPriceInstruction({
            microLamports: MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS + 1,
          }) as Instruction,
        ],
        /compute unit price exceeds sponsor cap/,
      ],
      [
        [
          getSetComputeUnitLimitInstruction({ units: 1 }) as Instruction,
          getSetComputeUnitLimitInstruction({ units: 2 }) as Instruction,
        ],
        /invalid SetComputeUnitLimit/,
      ],
      [
        [
          getSetComputeUnitPriceInstruction({ microLamports: 1 }) as Instruction,
          getSetComputeUnitLimitInstruction({ units: 1 }) as Instruction,
        ],
        /invalid SetComputeUnitLimit/,
      ],
      [
        [
          getSetComputeUnitPriceInstruction({ microLamports: 1 }) as Instruction,
          getSetComputeUnitPriceInstruction({ microLamports: 2 }) as Instruction,
        ],
        /invalid SetComputeUnitPrice/,
      ],
      [[rawBudget([2, 1, 0])], /invalid SetComputeUnitLimit/],
      [[rawBudget([3, 1, 0])], /invalid SetComputeUnitPrice/],
      [[rawBudget([1, 0, 0, 0, 0])], /unsupported Compute Budget instruction/],
      [[rawBudget([])], /invalid Compute Budget instruction/],
      [
        [rawBudget([2, 16, 39, 0, 0], [{ address: address(CHANNEL), role: AccountRole.READONLY }])],
        /invalid Compute Budget instruction/,
      ],
    ];
    for (const [prefix, message] of cases) {
      await expect(
        verifyRequestCloseTransaction(await wire([...prefix, close(), memo()]), expected()),
      ).rejects.toThrow(message);
    }
  });

  it("rejects a prefix-only transaction that never reaches request_close", async () => {
    const encoded = await wire([getSetComputeUnitLimitInstruction({ units: 1 }) as Instruction]);
    await expect(verifyRequestCloseTransaction(encoded, expected())).rejects.toThrow(
      /required signers/,
    );
    // With the payer forced into the signer set, the missing close is what fails.
    const withPayer = await wire([
      getSetComputeUnitLimitInstruction({ units: 1 }) as Instruction,
      {
        accounts: [{ address: address(CHANNEL), role: AccountRole.READONLY }],
        data: new Uint8Array([REQUEST_CLOSE_DISCRIMINATOR]),
        programAddress: address(bystander.address),
      },
    ]);
    await expect(verifyRequestCloseTransaction(withPayer, expected())).rejects.toThrow(
      /required signers/,
    );
  });

  it("rejects a suffix the sponsor does not allow", async () => {
    const cases: [Instruction[], RegExp][] = [
      [[memo(), memo()], /invalid Memo suffix/],
      [
        [
          {
            accounts: [{ address: address(CHANNEL), role: AccountRole.READONLY }],
            data: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
            programAddress: MEMO_PROGRAM_ADDRESS as Address,
          },
        ],
        /invalid Memo suffix/,
      ],
      [[memo("x".repeat(MAX_MEMO_BYTES + 1))], /memo exceeds the byte limit/],
      [[lighthouse(), lighthouse(), lighthouse(), lighthouse(), memo()], /too many Lighthouse/],
      [[lighthouse(feePayer.address), memo()], /feePayer must not be a suffix account/],
      [
        [
          {
            accounts: [],
            data: new Uint8Array([1]),
            programAddress: address(bystander.address),
          },
          memo(),
        ],
        /unsupported suffix instruction/,
      ],
    ];
    for (const [suffix, message] of cases) {
      await expect(
        verifyRequestCloseTransaction(await wire([close(), ...suffix]), expected()),
      ).rejects.toThrow(message);
    }
  });

  it("rejects a memo whose data is absent when a nonce is required", async () => {
    const encoded = await wire([
      close(),
      { accounts: [], programAddress: MEMO_PROGRAM_ADDRESS as Address },
    ]);
    await expect(verifyRequestCloseTransaction(encoded, expected())).rejects.toThrow(
      /nonce memo must be hexadecimal/,
    );
  });

  it("rejects a transaction whose fee payer slot is not the sponsor", async () => {
    // Both required signers are present, but the payer sits in the fee-payer slot.
    const encoded = await wire(
      [
        close(),
        {
          accounts: [{ address: address(feePayer.address), role: AccountRole.READONLY_SIGNER }],
          data: new Uint8Array([1]),
          programAddress: LIGHTHOUSE_PROGRAM_ADDRESS as Address,
        },
        memo(),
      ],
      payer.address,
    );
    await expect(verifyRequestCloseTransaction(encoded, expected())).rejects.toThrow(
      /transaction fee payer mismatch/,
    );
  });

  it("rejects a missing or forged payer signature", async () => {
    const unsigned = await wire([
      {
        accounts: [
          { address: address(payer.address), role: AccountRole.READONLY_SIGNER },
          { address: address(CHANNEL), role: AccountRole.WRITABLE },
        ],
        data: new Uint8Array([REQUEST_CLOSE_DISCRIMINATOR]),
        programAddress: PROGRAM,
      },
      memo(),
    ]);
    await expect(verifyRequestCloseTransaction(unsigned, expected())).rejects.toThrow(
      /missing payer signature/,
    );

    const signed = Buffer.from(await wire([close(), memo()]), "base64");
    // Wire layout: signature count, then one 64-byte signature per signer in
    // static-account order (fee payer first, payer second).
    signed[1 + 64 + 7] ^= 0xff;
    await expect(
      verifyRequestCloseTransaction(signed.toString("base64"), expected()),
    ).rejects.toThrow(/invalid payer signature/);
  });
});
