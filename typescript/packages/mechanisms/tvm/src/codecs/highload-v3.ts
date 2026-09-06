import { beginCell, Cell, Dictionary } from "@ton/core";
import { HIGHLOAD_V3_CODE_HASH } from "../constants";
import type { TvmAccountState } from "../types";

export const MAX_SHIFT = 8191;
export const MAX_BIT_NUMBER = 1022;
export const MAX_USABLE_QUERY_SEQNO = MAX_SHIFT * 1023 + (MAX_BIT_NUMBER - 1);

export interface HighloadQueryState {
  oldQueries: Map<number, Cell>;
  queries: Map<number, Cell>;
}

export function seqnoToQueryId(seqno: number): number {
  if (seqno < 0 || seqno > MAX_USABLE_QUERY_SEQNO) {
    throw new Error("Highload V3 seqno is out of range");
  }
  const shift = Math.floor(seqno / 1023);
  const bitNumber = seqno % 1023;
  return (shift << 10) + bitNumber;
}

export function serializeInternalTransfer(actions: Cell, queryId: number): Cell {
  return beginCell().storeUint(0xae42e5a4, 32).storeUint(queryId, 64).storeRef(actions).endCell();
}

export function loadHighloadQueryState(
  accountState: TvmAccountState,
  options: { expectedCodeHash?: string; now?: number } = {},
): HighloadQueryState | null {
  if (!accountState.isActive) {
    return null;
  }
  const expectedCodeHash = options.expectedCodeHash ?? HIGHLOAD_V3_CODE_HASH;
  const stateInit = accountState.stateInit;
  if (!stateInit?.code || !stateInit.data) {
    throw new Error("Active Highload V3 wallet state is missing code or data");
  }
  if (stateInit.code.hash().toString("hex") !== expectedCodeHash) {
    throw new Error("Unexpected code hash for Highload V3 facilitator wallet");
  }

  const data = stateInit.data.beginParse();
  data.loadBuffer(32);
  data.loadUint(32);
  let oldQueries = dictionaryToMap(
    data.loadDict(Dictionary.Keys.Uint(13), Dictionary.Values.Cell()),
  );
  let queries = dictionaryToMap(data.loadDict(Dictionary.Keys.Uint(13), Dictionary.Values.Cell()));
  const lastCleanTime = Number(data.loadUintBig(64));
  const timeout = data.loadUint(22);
  const now = options.now ?? Math.floor(Date.now() / 1000);

  if (lastCleanTime < now - timeout) {
    oldQueries = queries;
    queries = new Map();
  }
  if (lastCleanTime < now - timeout * 2) {
    oldQueries = new Map();
  }

  return { oldQueries, queries };
}

export function queryIdIsProcessed(queryState: HighloadQueryState, queryId: number): boolean {
  const shift = queryId >> 10;
  const bitNumber = queryId & 1023;
  return (
    bitmapContains(queryState.oldQueries.get(shift), bitNumber) ||
    bitmapContains(queryState.queries.get(shift), bitNumber)
  );
}

function bitmapContains(bitmap: Cell | undefined, bitNumber: number): boolean {
  if (!bitmap || bitNumber >= bitmap.bits.length) {
    return false;
  }
  return bitmap.beginParse().skip(bitNumber).preloadBit();
}

function dictionaryToMap<K, V>(dictionary: Dictionary<K & (number | bigint), V>): Map<number, V> {
  const result = new Map<number, V>();
  for (const key of dictionary.keys()) {
    result.set(Number(key), dictionary.get(key) as V);
  }
  return result;
}
