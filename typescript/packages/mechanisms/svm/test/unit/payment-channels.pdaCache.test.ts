import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@solana/kit", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...actual,
    getProgramDerivedAddress: vi.fn(),
  };
});

import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Codec,
  getProgramDerivedAddress,
  getU64Encoder,
  getUtf8Encoder,
} from "@solana/kit";

import { PAYMENT_CHANNELS_PROGRAM_ID } from "../../src/payment-channels/onchain";
import { findPaymentChannelPda } from "../../src/payment-channels/open";

type Seeds = Parameters<typeof findPaymentChannelPda>[0];
type DeriveArgs = Parameters<typeof getProgramDerivedAddress>[0];

const derive = vi.mocked(getProgramDerivedAddress);

/**
 * Builds the same derivation inputs as {@link findPaymentChannelPda}.
 *
 * @param seeds - Channel PDA inputs
 * @returns Args passed to `getProgramDerivedAddress`
 */
function buildDeriveArgs(seeds: Seeds): DeriveArgs {
  const programAddress = address(seeds.programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  return {
    programAddress,
    seeds: [
      getUtf8Encoder().encode("channel"),
      getAddressEncoder().encode(address(seeds.payer)),
      getAddressEncoder().encode(address(seeds.payee)),
      getAddressEncoder().encode(address(seeds.mint)),
      getAddressEncoder().encode(address(seeds.authorizedSigner)),
      getU64Encoder().encode(seeds.salt),
      getU64Encoder().encode(seeds.openSlot),
    ],
  };
}

/**
 * Deterministic stand-in for on-chain PDA derivation (no RPC, no bump search).
 *
 * @param args - Program address and seed bytes
 * @returns Mock PDA and bump
 */
async function fakeDerive(args: DeriveArgs): Promise<readonly [string, number]> {
  const base64 = getBase64Codec();
  const tag = [String(args.programAddress), ...args.seeds.map(seed => base64.decode(seed))].join(
    ":",
  );
  return [`pda:${tag}`, 255];
}

/**
 * Expected PDA from the stand-in derivation, bypassing the LRU cache and spy.
 *
 * @param seeds - Channel PDA inputs
 * @returns The uncached channel PDA
 */
async function uncachedPda(seeds: Seeds): Promise<string> {
  const [pda] = await fakeDerive(buildDeriveArgs(seeds));
  return pda;
}

/**
 * Builds a seed set from fresh keys so no other test has cached it.
 *
 * @returns Unique channel PDA inputs
 */
async function freshSeeds(): Promise<Seeds> {
  const [payer, payee, mint, authorizedSigner] = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner()),
  );
  return {
    authorizedSigner: authorizedSigner!.address,
    mint: mint!.address,
    openSlot: 341_000_000n,
    payee: payee!.address,
    payer: payer!.address,
    salt: 7n,
  };
}

/**
 * Settles a derivation into a comparable string, keeping the error class and
 * SolanaError code as well as the message.
 *
 * @param derivation - Pending derivation
 * @returns The PDA, or "error: <class> <code> <message>"
 */
function settle(derivation: Promise<string>): Promise<string> {
  return derivation.then(
    String,
    (e: Error & { context?: { __code?: number } }) =>
      `error: ${e.constructor.name} ${e.context?.__code ?? "-"} ${e.message}`,
  );
}

describe("findPaymentChannelPda cache", () => {
  beforeEach(() => {
    derive.mockReset();
    derive.mockImplementation(fakeDerive);
  });

  it("returns the uncached PDA and derives each seed set only once", async () => {
    const seeds = await freshSeeds();
    const expected = await uncachedPda(seeds);

    expect(await findPaymentChannelPda(seeds)).toBe(expected);
    expect(await findPaymentChannelPda({ ...seeds })).toBe(expected);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("never serves one seed set's PDA for another, including permuted seeds", async () => {
    // Every input drawn from a tiny shared pool, so seed sets differ only by
    // which field holds which value — the case an ambiguous key would confuse.
    // Salt/slot pairs (1, 23) and (12, 3) also concatenate to the same digits.
    const pool = await Promise.all(
      Array.from({ length: 3 }, async () => (await generateKeyPairSigner()).address),
    );
    const seedSets: Seeds[] = [];
    for (const payer of pool)
      for (const payee of pool)
        for (const mint of pool)
          for (const authorizedSigner of pool)
            for (const salt of [1n, 12n])
              for (const openSlot of [3n, 23n])
                seedSets.push({ authorizedSigner, mint, openSlot, payee, payer, salt });
    const expected = await Promise.all(seedSets.map(uncachedPda));
    expect(new Set(expected).size).toBe(seedSets.length);

    for (const [i, seeds] of seedSets.entries()) {
      expect(await findPaymentChannelPda(seeds)).toBe(expected[i]);
    }
    for (const i of seedSets.map((_, i) => i).reverse()) {
      expect(await findPaymentChannelPda(seedSets[i]!)).toBe(expected[i]);
    }
    expect(derive).toHaveBeenCalledTimes(seedSets.length);
  });

  it("shares entries between an omitted and an explicit default programId only", async () => {
    const seeds = await freshSeeds();
    const otherProgram = (await generateKeyPairSigner()).address;

    const byDefault = await findPaymentChannelPda(seeds);
    expect(await findPaymentChannelPda({ ...seeds, programId: PAYMENT_CHANNELS_PROGRAM_ID })).toBe(
      byDefault,
    );
    expect(derive).toHaveBeenCalledTimes(1);

    const underOther = await findPaymentChannelPda({ ...seeds, programId: otherProgram });
    expect(underOther).toBe(await uncachedPda({ ...seeds, programId: otherProgram }));
    expect(underOther).not.toBe(byDefault);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed derivation", async () => {
    const seeds = await freshSeeds();
    derive.mockRejectedValueOnce(new Error("derivation failed"));

    await expect(findPaymentChannelPda(seeds)).rejects.toThrow("derivation failed");
    expect(await findPaymentChannelPda(seeds)).toBe(await uncachedPda(seeds));
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it("keys coercible seeds by what they encode to, so they cannot poison other lookups", async () => {
    const seeds = await freshSeeds();
    // Stringifies as salt 123 but encodes as salt 124.
    const twoFaced = { toString: () => "123", valueOf: () => 124n } as unknown as bigint;
    const expected = await uncachedPda({ ...seeds, salt: twoFaced });
    expect(expected).not.toBe(await uncachedPda({ ...seeds, salt: 123n }));

    expect(await findPaymentChannelPda({ ...seeds, salt: twoFaced })).toBe(expected);
    expect(await findPaymentChannelPda({ ...seeds, salt: 123n })).toBe(
      await uncachedPda({ ...seeds, salt: 123n }),
    );
    expect(await findPaymentChannelPda({ ...seeds, salt: twoFaced })).toBe(expected);

    const other = (await generateKeyPairSigner()).address;
    const boxed = Object.assign(new String(seeds.payer), { toString: () => other });
    const boxedSeeds = { ...seeds, payer: boxed as unknown as string };
    expect(await settle(findPaymentChannelPda(boxedSeeds))).toBe(
      await settle(uncachedPda(boxedSeeds)),
    );
    expect(await findPaymentChannelPda({ ...seeds, payer: other })).toBe(
      await uncachedPda({ ...seeds, payer: other }),
    );
  });

  it("derives a coercible programId uncached, so it cannot poison primitive lookups", async () => {
    const seeds = await freshSeeds();
    const otherProgram = (await generateKeyPairSigner()).address;
    // Stringifies as the default program for the first `limit` coercions, then
    // as another program, so a key and a hash that coerce it separately differ.
    const switching = (limit: number) => {
      let coercions = 0;
      const programId = Object.assign(new String(PAYMENT_CHANNELS_PROGRAM_ID), {
        toString: () => (coercions++ < limit ? PAYMENT_CHANNELS_PROGRAM_ID : otherProgram),
      });
      return { ...seeds, programId: programId as unknown as string };
    };

    for (let limit = 0; limit <= 20; limit++) {
      expect(await settle(findPaymentChannelPda(switching(limit)))).toBe(
        await settle(uncachedPda(switching(limit))),
      );
      expect(await findPaymentChannelPda(seeds)).toBe(await uncachedPda(seeds));
    }
  });

  it("reads each input once, programId first, then the seeds in order", async () => {
    const seeds: Seeds = { ...(await freshSeeds()), programId: PAYMENT_CHANNELS_PROGRAM_ID };
    const reads: string[] = [];
    const logged = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(seeds).map(([name, value]) => [
          name,
          {
            enumerable: true,
            get: () => {
              reads.push(name);
              return value;
            },
          },
        ]),
      ),
    ) as Seeds;

    expect(await findPaymentChannelPda(logged)).toBe(await uncachedPda(seeds));
    expect(reads).toEqual([
      "programId",
      "payer",
      "payee",
      "mint",
      "authorizedSigner",
      "salt",
      "openSlot",
    ]);
  });

  it("reads and coerces inputs in the same order as the uncached derivation", async () => {
    const seeds = await freshSeeds();
    // salt reports 7 until openSlot has been read, so the result depends on salt
    // being coerced before openSlot is read.
    const stateful = (onEarlySalt: () => bigint) => {
      let openSlotRead = false;
      return {
        ...seeds,
        salt: { valueOf: () => (openSlotRead ? 8n : onEarlySalt()) } as unknown as bigint,
        get openSlot() {
          openSlotRead = true;
          return seeds.openSlot;
        },
      };
    };
    const expected = await uncachedPda(stateful(() => 7n));
    expect(expected).toBe(await uncachedPda({ ...seeds, salt: 7n }));
    expect(await findPaymentChannelPda(stateful(() => 7n))).toBe(expected);

    const early = () => {
      throw new Error("salt coerced before openSlot was read");
    };
    await expect(uncachedPda(stateful(early))).rejects.toThrow("salt coerced before openSlot");
    await expect(findPaymentChannelPda(stateful(early))).rejects.toThrow(
      "salt coerced before openSlot",
    );
  });

  it("rejects invalid inputs exactly as the uncached derivation does, before hashing", async () => {
    const seeds = await freshSeeds();
    for (const bad of [
      { ...seeds, payer: "not-a-base58-address" },
      { ...seeds, payer: "1".repeat(100_000) },
      { ...seeds, payer: "x", salt: 1n << 100_000n },
      { ...seeds, salt: 1n << 64n },
      { ...seeds, openSlot: -1n },
    ]) {
      const expected = await settle(uncachedPda(bad));
      expect(expected).toMatch(/^error: /);
      expect(await settle(findPaymentChannelPda(bad))).toBe(expected);
      expect(await settle(findPaymentChannelPda(bad))).toBe(expected);
    }
    expect(derive).not.toHaveBeenCalled();
  });

  it("derives from what a Proxy's getters return, whatever its descriptors report", async () => {
    const [cached, other] = await Promise.all([freshSeeds(), freshSeeds()]);
    await findPaymentChannelPda(cached);

    const lying = new Proxy(cached, { get: (_, name) => other[name as keyof Seeds] });
    expect(await findPaymentChannelPda(lying)).toBe(await uncachedPda(other));

    const invalid = new Proxy(cached, {
      get: (target, name) => (name === "payer" ? "x" : target[name as keyof Seeds]),
    });
    expect(await settle(findPaymentChannelPda(invalid))).toBe(await settle(uncachedPda(invalid)));

    const noDescriptors = new Proxy(cached, {
      getOwnPropertyDescriptor: () => {
        throw new Error("descriptor read");
      },
    });
    expect(await findPaymentChannelPda(noDescriptors)).toBe(await uncachedPda(cached));
  });

  it("holds 4,096 seed sets, evicting the least recently used", async () => {
    let calls = 0;
    derive.mockImplementation(async () => [`pda-${calls++}`, 255] as never);
    const seeds = await freshSeeds();
    const at = (i: number) => ({ ...seeds, salt: BigInt(i) });

    // Filling the cache with new seed sets evicts everything older.
    for (let i = 0; i < 4_096; i++) await findPaymentChannelPda(at(i));
    expect(await findPaymentChannelPda(at(0))).toBe("pda-0");
    expect(derive).toHaveBeenCalledTimes(4_096);

    // at(0) was just used, so the next insert evicts at(1) instead.
    await findPaymentChannelPda(at(4_096));
    expect(await findPaymentChannelPda(at(0))).toBe("pda-0");
    expect(await findPaymentChannelPda(at(1))).toBe("pda-4097");
    expect(derive).toHaveBeenCalledTimes(4_098);
  });
});
