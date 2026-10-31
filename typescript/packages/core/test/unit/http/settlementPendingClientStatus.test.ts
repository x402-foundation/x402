/**
 * The typed client collapses every unsuccessful settle into one status, so an
 * SDK caller cannot tell "reconcile before retrying" from "do not retry".
 *
 * `x402HTTPClient.parsePaymentResult` maps the decoded `PAYMENT-RESPONSE` to a
 * `paymentStatus` with `header.success ? "settled" : "settle_failed"`
 * (`src/http/x402HTTPClient.ts:263`), and `HTTPPaymentStatus` (`:326`) has four
 * members with no non-terminal one. A `settlement_pending` receipt therefore
 * arrives as `settle_failed`, the same value `insufficient_funds` produces.
 *
 * The wire is not the problem. §9 puts the reconcilable facts on the
 * `SettleResponse` rather than the status — `specs/x402-specification-v2.md:608`
 * requires a non-empty `transaction` and `network` on a pending outcome "so the
 * caller can reconcile on chain before deciding whether to retry" — and the
 * server does carry them through (`x402HTTPResourceServer.ts:854`, encoder at
 * `:927`). The third test below reads them back off the same header the client
 * just parsed. What is lost is the typed surface: acting on the difference
 * means decoding `PAYMENT-RESPONSE` yourself and re-implementing the branch.
 *
 * Not asserted: what the pending status should be called, or that the union
 * should grow a member. #3437 is answering what a server returns instead of
 * 402; this pins only that the two outcomes are indistinguishable to a caller
 * reading `paymentStatus`.
 */
import { describe, expect, test } from "vitest";

import { x402HTTPClient } from "../../../src/http/x402HTTPClient";
import { encodePaymentResponseHeader } from "../../../src/http";
import { createCashX402Client } from "../../mocks";
import type { Network, SettleResponse } from "../../../src/types";

const NETWORK = "x402:cash" as Network;
const BROADCAST_HASH = "0xbroadcast";

/**
 * Parse a settle receipt the way an SDK caller does: off the header.
 *
 * Reports rather than asserts, so each test names the outcome it cares about
 * and a change in either direction reddens a named expectation.
 *
 * @param settleResponse - The receipt the resource server put on the wire
 * @returns The caller-visible status and the header fields behind it
 */
function parse(settleResponse: SettleResponse): {
  paymentStatus: string;
  errorReason?: string;
  transaction: string;
} {
  const client = new x402HTTPClient(createCashX402Client("John"));
  const encoded = encodePaymentResponseHeader(settleResponse);

  const result = client.parsePaymentResult({
    status: 402,
    getHeader: (name: string) => (name.toUpperCase() === "PAYMENT-RESPONSE" ? encoded : undefined),
    body: {},
  });

  const header = result.header as SettleResponse;
  return {
    paymentStatus: result.paymentStatus,
    errorReason: header.errorReason,
    transaction: header.transaction,
  };
}

/** A terminal failure: the payer should present a new payment. */
const terminalResponse: SettleResponse = {
  success: false,
  errorReason: "insufficient_funds",
  transaction: "",
  network: NETWORK,
};

/** A non-terminal outcome: the transaction may still confirm on chain. */
const pendingResponse: SettleResponse = {
  success: false,
  errorReason: "settlement_pending",
  transaction: BROADCAST_HASH,
  network: NETWORK,
};

describe("the typed client collapses pending into settle_failed", () => {
  test("a terminal failure is reported as settle_failed", () => {
    const terminal = parse(terminalResponse);

    expect(terminal.paymentStatus).toBe("settle_failed");
    expect(terminal.errorReason).toBe("insufficient_funds");
    // Terminal outcomes carry no hash, so there is nothing to reconcile.
    expect(terminal.transaction).toBe("");
  });

  test("a pending outcome is reported as the same settle_failed", () => {
    const pending = parse(pendingResponse);

    expect(pending.paymentStatus).toBe("settle_failed");
    expect(pending.errorReason).toBe("settlement_pending");
  });

  test("the header carries what the status does not", () => {
    const pending = parse(pendingResponse);
    const terminal = parse(terminalResponse);

    // §9's reconcilable facts survive the round trip...
    expect(pending.errorReason).toBe("settlement_pending");
    expect(pending.transaction).toBe(BROADCAST_HASH);
    expect(pending.transaction).not.toBe(terminal.transaction);

    // ...but the typed status a caller reads does not distinguish them.
    expect(pending.paymentStatus).toBe(terminal.paymentStatus);
  });

  test("no shared literal exists for a fix at `:263` to read", async () => {
    const modules = await Promise.all([
      import("../../../src/server/x402ResourceServer"),
      import("../../../src/server/index"),
      import("../../../src/http/index"),
      import("../../../src/index"),
    ]);
    const shared = modules
      .flatMap(m => Object.keys(m as Record<string, unknown>))
      .filter(k => /SETTLEMENT_PENDING|PENDING_REASON/i.test(k));

    // `SETTLEMENT_PENDING_REASON` is module-private at `x402ResourceServer.ts:158`
    // and re-exported nowhere, so a fix in `http/` has two options: import
    // upward from `server/`, or spell the string a second time. The wire
    // `errorReason` is the only thing coupling the language implementations,
    // and the typed client is about to become the next consumer of it.
    expect(shared).toEqual([]);
  });

  // Self-clearing marker. It compares rather than spelling either value, so it
  // pins the fix direction -- pending must stop reading as the terminal
  // instruction -- rather than the fix's shape, and survives a rename of either
  // literal. The literal pins live in the two plain tests above, which is what
  // catches a change that moves both statuses together.
  test.fails("pending should not read as the terminal instruction", () => {
    const terminal = parse(terminalResponse);
    const pending = parse(pendingResponse);

    expect(pending.paymentStatus).not.toBe(terminal.paymentStatus);
  });
});
