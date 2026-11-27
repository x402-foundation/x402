/**
 * Replays recorded Hedera testnet runs of `transferExecutor` without a network.
 *
 * The fixtures in `test/fixtures/transferExecutor` were written by the live suites
 * (`RECORD_FIXTURES=1`, see `test/integrations/mock-executor/recorder.ts`). Each holds the
 * Mirror Node responses the facilitator read during one case, the result of the contract call
 * it submitted, and the `verify` and `settle` outcomes it returned.
 *
 * Here the real capabilities (`createHederaResolveEvmAddress`, `createHederaSimulateContractCall`,
 * `createHederaGetTransactionRecord`, ...) read those responses back through a stubbed `fetch`, and
 * the real facilitator must return the same outcomes. Unlike the other unit tests, whose Mirror
 * Node and consensus records are written by hand, this checks the parsing and the settlement
 * judgement against what the real network sent: real revert messages, real child records and logs,
 * and a payer debited through an allowance.
 *
 * To refresh the fixtures after a deliberate behaviour change, re-run the live suites with
 * `RECORD_FIXTURES=1` (see `test/integrations/mock-executor/README.md`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExactHederaScheme } from "../../src/exact/facilitator/scheme";
import type { FacilitatorHederaSigner } from "../../src/signer";
import {
  createHederaGetTokenCustomFees,
  createHederaGetTransactionRecord,
  createHederaResolveEvmAddress,
  createHederaSimulateContractCall,
} from "../../src/transferExecutorCapabilities";
import type {
  RecordedCall,
  RecordedCase,
  RecordedSubmit,
} from "../integrations/mock-executor/recorder";

const NETWORK = "hedera:testnet";
const FIXTURE_DIR = join(process.cwd(), "test/fixtures/transferExecutor");

const recordedCases: RecordedCase[] = readdirSync(FIXTURE_DIR)
  .filter(file => file.endsWith(".json"))
  .sort()
  .map(file => JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as RecordedCase);

/**
 * Serves recorded Mirror Node responses. A GET is answered with its recorded response, and a POST
 * with the recorded responses to the same body in order, the last one repeating. A request that
 * was not recorded fails the test: the facilitator read something the live run never did.
 *
 * @param calls - The recorded calls of one case
 * @returns A `fetch` replacement
 */
function replayFetch(calls: RecordedCall[]): typeof fetch {
  const queues = new Map<string, RecordedCall[]>();
  for (const call of calls) {
    const key = `${call.method} ${call.path} ${call.body ?? ""}`;
    queues.set(key, [...(queues.get(key) ?? []), call]);
  }
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body = typeof init?.body === "string" ? init.body : "";
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search} ${body}`;
    const queue = queues.get(key);
    if (!queue) {
      throw new Error(`unrecorded Mirror Node request: ${key}`);
    }
    const call = queue.length > 1 ? queue.shift()! : queue[0];
    return new Response(call.json === undefined ? call.text : JSON.stringify(call.json), {
      status: call.status,
    });
  };
}

/**
 * Builds a facilitator whose Mirror Node capabilities are the real ones, over replayed responses,
 * and whose submission returns what the live run's submission did.
 *
 * @param recorded - The recorded case
 * @returns The facilitator scheme
 */
function replayFacilitator(recorded: RecordedCase): ExactHederaScheme {
  const submits: RecordedSubmit[] = recorded.ops.flatMap(op => (op.submit ? [op.submit] : []));
  const mirror = {};
  const signer: FacilitatorHederaSigner = {
    getAddresses: () => [recorded.feePayer],
    signAndSubmitTransaction: vi.fn(),
    verifyPayerSignature: vi.fn(),
    preflightTransfer: vi.fn(),
    resolveEvmAddress: createHederaResolveEvmAddress(mirror),
    getTokenCustomFees: createHederaGetTokenCustomFees(mirror),
    simulateContractCall: createHederaSimulateContractCall(mirror),
    submitContractExecute: async () => {
      const next = submits.shift();
      if (!next) {
        throw new Error("the live run submitted fewer calls than this replay");
      }
      if ("error" in next) {
        throw new Error(next.error);
      }
      return next;
    },
    getTransactionRecord: createHederaGetTransactionRecord(mirror),
  };
  return new ExactHederaScheme(signer, {
    transferExecutor: {
      executors: { [NETWORK]: recorded.config.executors },
      gasLimit: recorded.config.gasLimit,
      simulationGasCeiling: recorded.config.simulationGasCeiling,
    },
  });
}

describe("transferExecutor replayed from recorded testnet runs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has recorded cases for success and for each kind of failure", () => {
    const outcomes = recordedCases.flatMap(recorded =>
      recorded.ops.map(op => {
        const response = op.response as {
          success?: boolean;
          isValid?: boolean;
          errorReason?: string;
        };
        return op.op === "settle"
          ? response.success
            ? "settled"
            : response.errorReason
          : "verified";
      }),
    );
    expect(recordedCases.length).toBeGreaterThanOrEqual(15);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        "settled",
        "settlement_payee_credit_mismatch",
        "settlement_payer_debit_mismatch",
        "settlement_unexpected_transfer",
      ]),
    );
  });

  it.each(recordedCases.map(recorded => [recorded.name, recorded] as const))(
    "%s",
    async (_name, recorded) => {
      vi.stubGlobal("fetch", replayFetch(recorded.calls));
      const scheme = replayFacilitator(recorded);

      for (const op of recorded.ops) {
        const response = await scheme[op.op](op.payload, op.requirements);
        expect(response).toEqual(op.response);
      }
    },
  );
});
