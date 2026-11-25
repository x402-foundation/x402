/**
 * Records what a live run does, so the unit tests can replay it without a network.
 *
 * Set `RECORD_FIXTURES=1` when running the live suites. Every Mirror Node response the
 * facilitator reads, and the outcome of every `verify` and `settle` it is asked, are written to
 * `test/fixtures/transferExecutor/<case>.json`. `test/unit/transferExecutor.recorded.test.ts`
 * feeds those responses back through the real capabilities and expects the same outcomes, so a
 * change to how real records, simulation errors or account lookups are parsed shows up in CI.
 *
 * Only public testnet data is recorded: no key or credential is ever read by this module.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

// Relative to the package root, where the suites and `deploy.ts` are run from.
const FIXTURE_DIR = join(process.cwd(), "test/fixtures/transferExecutor");

/**
 * One Mirror Node request and its response.
 */
export type RecordedCall = {
  method: string;
  /** Path and query, without the host. */
  path: string;
  /** Request body, for POST. */
  body?: string;
  status: number;
  /** Response body, when it is JSON. */
  json?: unknown;
  /** Response body, when it is not JSON. */
  text?: string;
};

/**
 * What `submitContractExecute` returned for a settle, or the error it threw.
 */
export type RecordedSubmit = { transactionId: string; receiptStatus?: string } | { error: string };

/**
 * One `verify` or `settle` the facilitator was asked.
 */
export type RecordedOp = {
  op: "verify" | "settle";
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  response: unknown;
  /** Set on a settle that reached submission. */
  submit?: RecordedSubmit;
};

/**
 * A recorded case: how the facilitator was set up, what it was asked and what it read.
 */
export type RecordedCase = {
  name: string;
  feePayer: string;
  config: { executors: string[]; gasLimit: number; simulationGasCeiling?: number };
  ops: RecordedOp[];
  calls: RecordedCall[];
};

export const isRecording = Boolean(process.env.RECORD_FIXTURES);

const cases = new Map<string, RecordedCase>();
let installed = false;
/** Greater than zero while the facilitator runs a `verify` or `settle`. */
let facilitatorCalls = 0;

/**
 * Runs a facilitator call. Only Mirror Node requests made while it runs are recorded: the
 * suites' own setup and polling reads are not something a replay needs.
 *
 * @param run - The `verify` or `settle` call
 * @returns Its result
 */
export async function asFacilitatorCall<T>(run: () => Promise<T>): Promise<T> {
  facilitatorCalls++;
  try {
    return await run();
  } finally {
    facilitatorCalls--;
  }
}

/**
 * Returns the name of the running test.
 *
 * @returns Describe and test titles, joined by " > "
 */
function currentName(): string {
  return expect.getState().currentTestName ?? "";
}

/**
 * Returns false for tests whose ordering a replay could not reproduce.
 *
 * @param name - Test name
 * @returns True when the test may be recorded
 */
function recordable(name: string): boolean {
  return name !== "" && !name.includes("concurrent");
}

/**
 * Returns the record of the running test, creating it.
 *
 * @param setup - Facilitator setup to store when the record is created
 * @returns The record, or undefined when this test is not recorded
 */
export function caseFor(
  setup: Omit<RecordedCase, "name" | "ops" | "calls">,
): RecordedCase | undefined {
  const name = currentName();
  if (!isRecording || !recordable(name)) {
    return undefined;
  }
  let recorded = cases.get(name);
  if (!recorded) {
    recorded = { name, ...setup, ops: [], calls: [] };
    cases.set(name, recorded);
  }
  return recorded;
}

/**
 * Starts recording Mirror Node traffic and registers the write-out. Safe to call repeatedly.
 */
export function installRecorder(): void {
  if (!isRecording || installed) {
    return;
  }
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const recorded = cases.get(currentName());
    if (!recorded || facilitatorCalls === 0) {
      return response;
    }
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    recorded.calls.push({
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: typeof init?.body === "string" ? init.body : undefined,
      status: response.status,
      ...(json === undefined ? { text } : { json }),
    });
    return new Response(text, { status: response.status, headers: response.headers });
  };
  afterAll(() => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const recorded of cases.values()) {
      if (recorded.ops.length === 0) {
        continue;
      }
      const slimmed = { ...recorded, calls: slimCalls(recorded.calls) };
      writeFileSync(
        join(FIXTURE_DIR, `${fileName(recorded.name)}.json`),
        JSON.stringify(slimmed) + "\n",
      );
    }
  });
}

/**
 * Names a fixture file from the test's titles below the suite, prefixed by the suite.
 *
 * @param name - Test name, titles joined by " > "
 * @returns File name without extension
 */
function fileName(name: string): string {
  const suite = name.includes("signed-owner") ? "signed" : "mock";
  const slug = name
    .split(" > ")
    .slice(suite === "signed" ? -1 : -2)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90)
    .replace(/-$/, "");
  return `${suite}-${slug}`;
}

/**
 * Fields of a record entry the facilitator reads.
 */
const RECORD_ENTRY_FIELDS = [
  "charged_tx_fee",
  "consensus_timestamp",
  "nft_transfers",
  "nonce",
  "parent_consensus_timestamp",
  "result",
  "scheduled",
  "staking_reward_transfers",
  "token_transfers",
  "transaction_id",
  "transfers",
];

/**
 * Cuts a Mirror Node response to the fields the facilitator reads. The Mirror Node sends far
 * more (embedded recent transactions of an account, request bytes, bloom filters, state
 * changes), tens of kilobytes that nothing reads.
 *
 * @param path - Request path, without the query
 * @param json - Parsed response
 * @returns The response a replay needs
 */
function slimJson(path: string, json: unknown): unknown {
  if (typeof json !== "object" || json === null) {
    return json;
  }
  const full = json as Record<string, unknown>;
  const pick = (source: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(keys.filter(k => k in source).map(k => [k, source[k]]));
  if (/^\/api\/v1\/accounts\/[^/]+$/.test(path)) {
    return pick(full, ["account", "alias", "evm_address", "key"]);
  }
  if (/^\/api\/v1\/transactions\//.test(path) && Array.isArray(full.transactions)) {
    return {
      transactions: full.transactions.map(entry => pick(entry as never, RECORD_ENTRY_FIELDS)),
    };
  }
  if (/^\/api\/v1\/contracts\/results\//.test(path) && Array.isArray(full.logs)) {
    return {
      logs: full.logs.map(log => pick(log as never, ["address", "data", "topics"])),
    };
  }
  if (/^\/api\/v1\/tokens\/[^/]+$/.test(path)) {
    return pick(full, ["token_id", "type", "custom_fees"]);
  }
  return json;
}

/**
 * Keeps what a replay needs. Polling leaves earlier responses for the same GET that a replay
 * must not wait through, so only the last one is kept, and each response is cut to the fields
 * the facilitator reads.
 *
 * @param calls - Every recorded call, in order
 * @returns The calls to store
 */
function slimCalls(calls: RecordedCall[]): RecordedCall[] {
  const kept: RecordedCall[] = [];
  const lastGet = new Map<string, number>();
  for (const call of calls) {
    const path = call.path.split("?")[0];
    const stored =
      call.status === 200 && call.json !== undefined
        ? { ...call, json: slimJson(path, call.json) }
        : call;
    if (stored.method === "GET") {
      const key = `${stored.method} ${stored.path}`;
      const previous = lastGet.get(key);
      if (previous !== undefined) {
        kept[previous] = stored;
        continue;
      }
      lastGet.set(key, kept.length);
    }
    kept.push(stored);
  }
  return kept;
}
