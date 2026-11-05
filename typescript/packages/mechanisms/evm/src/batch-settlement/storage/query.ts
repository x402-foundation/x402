import type { Network } from "@x402/core/types";
import type { Channel, ChannelStorage } from "./channel";

/** Per-call store options. */
export type ChannelStoreOptions = { signal?: AbortSignal };

/**
 * Closed set of worker reads the channel managers issue.
 *
 * A named union rather than optional predicates: an adapter that does not
 * understand a field would otherwise over-return, and over-returning is the
 * dangerous direction (cooperative refund of channels that are not idle).
 * Switching on `kind` with a `never` default makes a new variant a compile
 * error in every custom adapter.
 */
export type ChannelQuery =
  | {
      kind: "claimable";
      network?: Network;
      /** Optional idle cutoff; absent means no idle filter. */
      idleAtOrBefore?: number;
      /** Optional decimal uint256 threshold; absent means any positive unclaimed. */
      minUnclaimed?: string;
      /** Sort claimable rows highest-unclaimed first. Default is input order. */
      unclaimedDesc?: boolean;
      limit?: number;
      cursor?: string;
    }
  | {
      kind: "idleRefundable";
      network?: Network;
      idleAtOrBefore?: number;
      limit?: number;
      cursor?: string;
    }
  | { kind: "withdrawPending"; network?: Network; limit?: number; cursor?: string };

/**
 * Filter for {@link ChannelStorage.settleQuery}: distinct claimed
 * `(network, receiver, token)` tuples.
 */
export type SettleQuery = {
  network?: Network;
  limit?: number;
  cursor?: string;
};

/** Distinct claimed `(network, receiver, token)` used by facilitator settle. */
export type SettleTarget = [network: Network, receiver: `0x${string}`, token: `0x${string}`];

/** One page from {@link ChannelStorage.query} or {@link ChannelStorage.settleQuery}. */
export type QueryPage<T> = { items: T[]; cursor?: string };

/**
 * Returns whether `channel` satisfies `filter`.
 *
 * Uint256 comparisons use `BigInt` so lexicographic string order cannot leak
 * into adapters. When `filter.network` is set, a row without a `network` field
 * does not match.
 *
 * @param channel - Stored channel record.
 * @param filter - Named worker query.
 * @returns Whether the row belongs in the result set.
 */
export function matchesChannelQuery(channel: Channel, filter: ChannelQuery): boolean {
  if (filter.network !== undefined && channelNetwork(channel) !== filter.network) {
    return false;
  }

  switch (filter.kind) {
    case "claimable": {
      if (BigInt(channel.chargedCumulativeAmount) <= BigInt(channel.totalClaimed)) {
        return false;
      }
      const threshold = filter.minUnclaimed;
      const idle = filter.idleAtOrBefore;
      if (threshold !== undefined && idle !== undefined) {
        return matchesUnclaimedThreshold(channel, threshold) || matchesIdle(channel, idle);
      }
      if (threshold !== undefined) {
        return matchesUnclaimedThreshold(channel, threshold);
      }
      return matchesIdle(channel, idle);
    }
    case "idleRefundable":
      if (BigInt(channel.balance) === 0n) {
        return false;
      }
      return matchesIdle(channel, filter.idleAtOrBefore);
    case "withdrawPending":
      return channel.withdrawRequestedAt > 0;
    default: {
      const _exhaustive: never = filter;
      throw new Error(`unhandled channel query: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Orders query matches. Claimable rows put withdraw-pending first, then
 * highest-unclaimed when `unclaimedDesc` is set.
 *
 * @param channels - Rows already accepted by {@link matchesChannelQuery}.
 * @param filter - Named worker query.
 * @returns A new array in worker-consumption order.
 */
export function sortChannels<T extends Channel>(channels: T[], filter: ChannelQuery): T[] {
  switch (filter.kind) {
    case "claimable":
      return [...channels].sort((a, b) => {
        const pendingA = a.withdrawRequestedAt > 0 ? 0 : 1;
        const pendingB = b.withdrawRequestedAt > 0 ? 0 : 1;
        if (pendingA !== pendingB) {
          return pendingA - pendingB;
        }
        if (!filter.unclaimedDesc) {
          return 0;
        }
        const unclaimedA = BigInt(a.chargedCumulativeAmount) - BigInt(a.totalClaimed);
        const unclaimedB = BigInt(b.chargedCumulativeAmount) - BigInt(b.totalClaimed);
        if (unclaimedA === unclaimedB) {
          return 0;
        }
        return unclaimedA > unclaimedB ? -1 : 1;
      });
    case "idleRefundable":
    case "withdrawPending":
      return [...channels];
    default: {
      const _exhaustive: never = filter;
      throw new Error(`unhandled channel query: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Scan-backed {@link ChannelStorage.query}. Dumps `list()`, filters, sorts, and
 * slices. `limit` / `cursor` only page the already-loaded match list; a native
 * adapter should apply them as read bounds.
 *
 * @param storage - Channel store to scan.
 * @param filter - Named worker query.
 * @returns One page of matching channels.
 */
export async function queryByScan<T extends Channel>(
  storage: ChannelStorage<T>,
  filter: ChannelQuery,
): Promise<QueryPage<T>> {
  const matched = sortChannels(
    (await storage.list()).filter(channel => matchesChannelQuery(channel, filter)),
    filter,
  );
  return pageItems(matched, filter.limit, filter.cursor);
}

/**
 * Scan-backed {@link ChannelStorage.settleQuery}: claimed rows
 * (`totalClaimed > 0`) deduped per `(network, receiver, token)`.
 *
 * @param storage - Channel store to scan.
 * @param filter - Settle query.
 * @returns One page of distinct settle targets in first-seen order.
 */
export async function settleQueryByScan<T extends Channel>(
  storage: ChannelStorage<T>,
  filter: SettleQuery = {},
): Promise<QueryPage<SettleTarget>> {
  const targets = new Map<string, SettleTarget>();
  for (const channel of await storage.list()) {
    if (BigInt(channel.totalClaimed) === 0n) {
      continue;
    }
    const network = channelNetwork(channel) ?? filter.network;
    if (!network || (filter.network !== undefined && network !== filter.network)) {
      continue;
    }
    const receiver = channel.channelConfig.receiver;
    const token = channel.channelConfig.token;
    const key = `${network}:${receiver.toLowerCase()}:${token.toLowerCase()}`;
    if (!targets.has(key)) {
      targets.set(key, [network, receiver, token]);
    }
  }
  return pageItems([...targets.values()], filter.limit, filter.cursor);
}

/**
 * Runs a named worker query, using a native `storage.query` when present and
 * {@link queryByScan} otherwise.
 *
 * @param storage - Channel store.
 * @param filter - Named worker query.
 * @param opts - Optional per-call store options.
 * @returns One page of matching channels.
 */
export async function queryChannels<T extends Channel>(
  storage: ChannelStorage<T>,
  filter: ChannelQuery,
  opts?: ChannelStoreOptions,
): Promise<QueryPage<T>> {
  return (await storage.query?.(filter, opts)) ?? queryByScan(storage, filter);
}

/**
 * Lists distinct claimed settle targets, using native `storage.settleQuery`
 * when present and {@link settleQueryByScan} otherwise.
 *
 * @param storage - Channel store.
 * @param filter - Settle query.
 * @param opts - Optional per-call store options.
 * @returns One page of distinct settle targets.
 */
export async function querySettleTargets<T extends Channel>(
  storage: ChannelStorage<T>,
  filter: SettleQuery = {},
  opts?: ChannelStoreOptions,
): Promise<QueryPage<SettleTarget>> {
  return (await storage.settleQuery?.(filter, opts)) ?? settleQueryByScan(storage, filter);
}

/**
 * Returns whether a channel meets the idle cutoff.
 *
 * @param channel - Stored channel record.
 * @param idleAtOrBefore - Inclusive idle cutoff.
 * @returns Whether the channel is idle.
 */
function matchesIdle(channel: Channel, idleAtOrBefore?: number): boolean {
  if (idleAtOrBefore === undefined) {
    return true;
  }
  return channel.lastRequestTimestamp <= idleAtOrBefore;
}

/**
 * Returns whether a channel meets the unclaimed threshold.
 *
 * @param channel - Stored channel record.
 * @param minUnclaimed - Minimum unclaimed amount.
 * @returns Whether the threshold passes.
 */
function matchesUnclaimedThreshold(channel: Channel, minUnclaimed: string): boolean {
  let threshold: bigint;
  try {
    threshold = BigInt(minUnclaimed);
  } catch {
    return false;
  }
  if (threshold < 0n) {
    return false;
  }
  return BigInt(channel.chargedCumulativeAmount) - BigInt(channel.totalClaimed) >= threshold;
}

/**
 * Reads the optional network field from a channel record.
 *
 * @param channel - Stored channel record.
 * @returns The network or undefined.
 */
function channelNetwork(channel: Channel): Network | undefined {
  const network = (channel as Channel & { network?: unknown }).network;
  return typeof network === "string" ? (network as Network) : undefined;
}

/**
 * Applies scan-shim pagination to a result list.
 *
 * @param items - Result items.
 * @param limit - Optional page size.
 * @param cursor - Optional page cursor.
 * @returns A result page.
 */
function pageItems<T>(items: T[], limit?: number, cursor?: string): QueryPage<T> {
  const start = parseQueryCursor(cursor);
  const remaining = items.length - start;
  if (remaining <= 0) {
    return { items: [] };
  }
  const size = limit === undefined ? remaining : Math.max(0, limit);
  const end = start + size;
  const page = items.slice(start, end);
  return {
    items: page,
    ...(end < items.length ? { cursor: String(end) } : {}),
  };
}

/**
 * Parses a scan-shim cursor into a non-negative offset.
 *
 * @param cursor - Opaque page cursor.
 * @returns The page offset.
 */
function parseQueryCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}
