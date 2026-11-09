import { describe, it, expect, beforeEach } from "vitest";
import type { Network } from "@x402/core/types";
import {
  InMemoryChannelStorage,
  type Channel,
} from "../../../src/batch-settlement/storage/channel";
import {
  matchesChannelQuery,
  queryByScan,
  queryChannels,
  querySettleTargets,
  settleQueryByScan,
  sortChannels,
} from "../../../src/batch-settlement/storage/query";
import type { ChannelConfig } from "../../../src/batch-settlement/types";

const NETWORK_A = "eip155:84532" as Network;
const NETWORK_B = "eip155:1" as Network;
const RECEIVER_A = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const RECEIVER_B = "0x2222222222222222222222222222222222222222" as `0x${string}`;
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const NOW = 1_700_000_000_000;
const IDLE_AT = NOW - 60_000;

const FRESH = id(1);
const IDLE_CLAIMABLE = id(2);
const PENDING = id(3);
const LEX_SMALLER = id(4);
const LEX_LARGER = id(5);
const IDLE_ESCROW = id(6);
const ZERO_BALANCE = id(7);
const WITHDRAW_ONLY = id(8);
const PAIR_A = id(9);
const PAIR_A_DUP = id(10);
const PAIR_B = id(11);
const PAIR_A_ON_B = id(12);

describe("queryChannels", () => {
  let storage: InMemoryChannelStorage;

  beforeEach(async () => {
    storage = new InMemoryChannelStorage();
    for (const channel of seed()) {
      await storage.updateChannel(channel.channelId, () => channel);
    }
  });

  it("selects rows whose charged amount exceeds totalClaimed as BigInt", async () => {
    expect(await ids({ kind: "claimable" })).toEqual([PENDING, FRESH, IDLE_CLAIMABLE, LEX_LARGER]);
  });

  it("applies idleAtOrBefore to claimable rows", async () => {
    expect(await ids({ kind: "claimable", idleAtOrBefore: IDLE_AT })).toEqual([
      PENDING,
      IDLE_CLAIMABLE,
      LEX_LARGER,
    ]);
  });

  it("applies minUnclaimed to claimable rows", async () => {
    expect(await ids({ kind: "claimable", minUnclaimed: "50" })).toEqual([
      PENDING,
      FRESH,
      IDLE_CLAIMABLE,
    ]);
  });

  it("matches either threshold or idle when both are set on claimable", async () => {
    expect(await ids({ kind: "claimable", minUnclaimed: "1000", idleAtOrBefore: IDLE_AT })).toEqual(
      [PENDING, IDLE_CLAIMABLE, LEX_LARGER],
    );
  });

  it("fails closed on an unparseable minUnclaimed", async () => {
    expect(await ids({ kind: "claimable", minUnclaimed: "not-a-number" })).toEqual([]);
    expect(
      await ids({
        kind: "claimable",
        minUnclaimed: "not-a-number",
        idleAtOrBefore: IDLE_AT,
      }),
    ).toEqual([PENDING, IDLE_CLAIMABLE, LEX_LARGER]);
  });

  it("compares unclaimed deltas as BigInt against minUnclaimed", () => {
    const row = channel(id(20), { chargedCumulativeAmount: "100" });
    expect(matchesChannelQuery(row, { kind: "claimable", minUnclaimed: "50" })).toBe(true);
    expect(matchesChannelQuery(row, { kind: "claimable", minUnclaimed: "150" })).toBe(false);
  });

  it("sorts claimable rows withdraw-pending first then highest unclaimed", () => {
    const low = channel(id(21), { chargedCumulativeAmount: "10" });
    const high = channel(id(22), { chargedCumulativeAmount: "100" });
    const pending = channel(id(23), { chargedCumulativeAmount: "50", withdrawRequestedAt: 1 });
    const input = [low, high, pending];
    expect(
      sortChannels(input, { kind: "claimable", unclaimedDesc: true }).map(entry => entry.channelId),
    ).toEqual([pending.channelId, high.channelId, low.channelId]);
    expect(input.map(entry => entry.channelId)).toEqual([
      low.channelId,
      high.channelId,
      pending.channelId,
    ]);
  });

  it("filters claimable rows by network when the row carries one", async () => {
    expect(await ids({ kind: "claimable", network: NETWORK_B })).toEqual([]);
  });

  it("selects idle refundable rows with remaining escrow", async () => {
    expect(await ids({ kind: "idleRefundable", idleAtOrBefore: IDLE_AT })).toEqual([
      IDLE_CLAIMABLE,
      PENDING,
      LEX_SMALLER,
      LEX_LARGER,
      IDLE_ESCROW,
    ]);
  });

  it("selects withdraw-pending rows", async () => {
    expect(await ids({ kind: "withdrawPending" })).toEqual([PENDING, WITHDRAW_ONLY]);
  });

  it("pages claimable results with limit and cursor", async () => {
    const first = await queryChannels(storage, { kind: "claimable", limit: 1 });
    expect(first.items.map(channel => channel.channelId)).toEqual([PENDING]);
    expect(first.cursor).toBeDefined();

    const rest = await queryChannels(storage, {
      kind: "claimable",
      limit: 10,
      cursor: first.cursor,
    });
    expect(rest.items.map(channel => channel.channelId)).toEqual([
      FRESH,
      IDLE_CLAIMABLE,
      LEX_LARGER,
    ]);
    expect(rest.cursor).toBeUndefined();
  });

  it("dedupes claimed settle targets per network, receiver, and token", async () => {
    expect(await querySettleTargets(storage, {})).toEqual({
      items: [
        [NETWORK_A, RECEIVER_A, TOKEN_A],
        [NETWORK_B, RECEIVER_B, TOKEN_B],
        [NETWORK_B, RECEIVER_A, TOKEN_A],
      ],
    });
  });

  it("filters claimed settle targets by network", async () => {
    expect(await querySettleTargets(storage, { network: NETWORK_B })).toEqual({
      items: [
        [NETWORK_B, RECEIVER_B, TOKEN_B],
        [NETWORK_B, RECEIVER_A, TOKEN_A],
      ],
    });
  });

  it("matches native query implementations to the scan shims", async () => {
    const querying = Object.assign(storage, {
      query: (filter: Parameters<typeof queryByScan>[1]) => queryByScan(storage, filter),
      settleQuery: (filter: Parameters<typeof settleQueryByScan>[1]) =>
        settleQueryByScan(storage, filter),
    });

    await expect(queryChannels(querying, { kind: "claimable" })).resolves.toEqual(
      await queryByScan(storage, { kind: "claimable" }),
    );
    await expect(querySettleTargets(querying, {})).resolves.toEqual(
      await settleQueryByScan(storage, {}),
    );
  });

  async function ids(filter: Parameters<typeof queryChannels>[1]): Promise<string[]> {
    return (await queryChannels(storage, filter)).items.map(channel => channel.channelId);
  }
});

function id(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function seed(): Channel[] {
  return [
    channel(FRESH, { chargedCumulativeAmount: "100", lastRequestTimestamp: NOW }),
    channel(IDLE_CLAIMABLE, {
      chargedCumulativeAmount: "100",
      lastRequestTimestamp: NOW - 120_000,
    }),
    channel(PENDING, {
      chargedCumulativeAmount: "100",
      lastRequestTimestamp: NOW - 120_000,
      withdrawRequestedAt: 1,
    }),
    channel(LEX_SMALLER, {
      chargedCumulativeAmount: "9",
      totalClaimed: "10",
      lastRequestTimestamp: NOW - 120_000,
    }),
    channel(LEX_LARGER, {
      chargedCumulativeAmount: "10",
      totalClaimed: "9",
      lastRequestTimestamp: NOW - 120_000,
    }),
    channel(IDLE_ESCROW, { lastRequestTimestamp: NOW - 120_000, balance: "500" }),
    channel(ZERO_BALANCE, { lastRequestTimestamp: NOW - 120_000, balance: "0" }),
    channel(WITHDRAW_ONLY, { withdrawRequestedAt: 99 }),
    channel(PAIR_A, {
      totalClaimed: "10",
      chargedCumulativeAmount: "10",
      receiver: RECEIVER_A,
      token: TOKEN_A,
    }),
    channel(PAIR_A_DUP, {
      totalClaimed: "20",
      chargedCumulativeAmount: "20",
      receiver: RECEIVER_A,
      token: TOKEN_A,
    }),
    channel(PAIR_B, {
      totalClaimed: "5",
      chargedCumulativeAmount: "5",
      receiver: RECEIVER_B,
      token: TOKEN_B,
      network: NETWORK_B,
    }),
    channel(PAIR_A_ON_B, {
      totalClaimed: "7",
      chargedCumulativeAmount: "7",
      receiver: RECEIVER_A,
      token: TOKEN_A,
      network: NETWORK_B,
    }),
  ];
}

function channel(
  channelId: string,
  extra: Partial<Channel> & {
    network?: Network;
    receiver?: `0x${string}`;
    token?: `0x${string}`;
  },
): Channel {
  const { network = NETWORK_A, receiver = RECEIVER_A, token = TOKEN_A, ...rest } = extra;
  const config: ChannelConfig = {
    payer: "0x3333333333333333333333333333333333333333",
    payerAuthorizer: "0x0000000000000000000000000000000000000000",
    receiver,
    receiverAuthorizer: "0x0000000000000000000000000000000000000000",
    token,
    withdrawDelay: 900,
    salt: channelId as `0x${string}`,
  };
  return {
    channelId,
    channelConfig: config,
    chargedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    signature: "0x",
    balance: "1000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: NOW,
    ...rest,
    network,
  } as Channel;
}
