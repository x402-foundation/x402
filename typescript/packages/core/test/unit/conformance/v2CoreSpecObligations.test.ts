/**
 * Conformance: the normative statements of the v2 core specification, asserted
 * against `@x402/core`.
 *
 * `specs/x402-specification-v2.md` states its requirements on seven lines,
 * carrying eleven requirement keywords between them (7 MUST, 2 MUST NOT,
 * 2 SHOULD); `:289` alone carries five. A grep over the full RFC-2119 set
 * returns more, because `MAY` is a permission rather than an obligation and
 * is not counted here. This file holds
 * one test per requirement that is observable from this package, each citing
 * the line it comes from, so that a change to the implementation that
 * silently drops an obligation fails here rather than in review.
 *
 * Statements deliberately not covered, with the reason:
 *
 * - `:285` "clients and servers MUST interpret [the reserved extra keys] as
 *   defined here rather than as opaque scheme-private fields" — a statement
 *   about interpretation with no single observable. Its consequences are the
 *   `:289` obligations, which are covered below.
 * - `:307` "`/verify` … MUST NOT commit payment state or write onchain state"
 *   — binds a facilitator implementation. Asserting it here would test the
 *   mock, not the obligation.
 * - `:401` "A scheme defining multiple settles MUST specify how the
 *   facilitator distinguishes them" — an obligation on scheme documents.
 * - `:608` the non-terminal reading of `settlement_pending` — the subject of
 *   `test/unit/http/settlementPendingIsTerminal.test.ts`, not duplicated here.
 *   The part of `:608` that *is* covered below is its "MUST carry a non-empty
 *   `transaction`" clause, which `:249` states as a field rule.
 */
import { describe, test, expect, beforeEach } from "vitest";

import {
  PAYMENT_FLOWS,
  resolvePaymentFlow,
  applyPaymentFlowWireExtra,
} from "../../../src/server/paymentFlow";
import { x402Client } from "../../../src/client/x402Client";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkClient,
  MockSchemeNetworkServer,
  buildPaymentRequired,
  buildPaymentRequirements,
  buildPaymentPayload,
  buildSupportedResponse,
  buildVerifyResponse,
} from "../../mocks";
import type { Network, Price } from "../../../src/types";

const NETWORK = "test:network" as Network;

describe("§2 Core Payment Flow", () => {
  /**
   * "Invariant: at least one check — a verify or settle before the resource —
   * MUST run before the resource executes. The resource never executes with
   * nothing checked." (specs/x402-specification-v2.md:299)
   *
   * Asserted over the closed phase table rather than a single flow, so a
   * newly added flow cannot satisfy the type and violate the invariant.
   */
  test.each(Object.entries(PAYMENT_FLOWS))(
    "%s runs a check before the resource executes",
    (_flow, phases) => {
      expect(phases.verifyBeforeHandler || phases.settleBeforeHandler).toBe(true);
    },
  );
});

describe("§6.1 Asset transfer methods and payment flows", () => {
  const scheme = {
    scheme: "exact",
    defaultAssetTransferMethod: "eip3009",
    paymentFlows: {
      eip3009: { default: "authorization" as const, supported: ["authorization"] as const },
      permit2: {
        default: "authorization" as const,
        supported: ["authorization", "escrow"] as const,
      },
    },
  };

  /**
   * "Resource servers MUST reject unsupported `assetTransferMethod` / payment
   * flow combinations." (specs/x402-specification-v2.md:289)
   */
  test("rejects an assetTransferMethod the scheme does not declare", () => {
    expect(() =>
      resolvePaymentFlow(
        scheme as never,
        buildPaymentRequirements({ extra: { assetTransferMethod: "teleport" } }),
      ),
    ).toThrow(/does not support assetTransferMethod/);
  });

  test("rejects a paymentFlow the assetTransferMethod does not support", () => {
    expect(() =>
      resolvePaymentFlow(
        scheme as never,
        buildPaymentRequirements({
          extra: { assetTransferMethod: "eip3009", paymentFlow: "escrow" },
        }),
      ),
    ).toThrow(/does not support paymentFlow/);
  });

  /**
   * "When the resolved payment flow is not `authorization`, `PaymentRequired`
   * `accepts[].extra.paymentFlow` MUST be present so clients can reason about
   * pre-handler fund commitment without scheme-specific knowledge …
   * `authorization` MAY be omitted or explicit."
   * (specs/x402-specification-v2.md:289)
   */
  test.each(["upfront", "escrow"] as const)(
    "%s is surfaced on the wire so a client can see pre-handler commitment",
    flow => {
      const extra = applyPaymentFlowWireExtra(
        {},
        { assetTransferMethod: "permit2", paymentFlow: flow },
      );
      expect(extra.paymentFlow).toBe(flow);
    },
  );

  test("authorization may be omitted from the wire", () => {
    const extra = applyPaymentFlowWireExtra(
      {},
      { assetTransferMethod: "permit2", paymentFlow: "authorization" },
    );
    expect(extra.paymentFlow).toBeUndefined();
  });
});

describe("§6.1 Client obligations on paymentFlow", () => {
  let client: x402Client;
  let schemeClient: MockSchemeNetworkClient;

  beforeEach(() => {
    schemeClient = new MockSchemeNetworkClient("test-scheme");
    client = new x402Client();
    client.register(NETWORK, schemeClient);
    client.setSpendControls(false);
  });

  /**
   * "Clients MUST NOT construct a payment for a `paymentFlow` they do not
   * recognize, and SHOULD skip such `accepts[]` entries when selecting."
   * (specs/x402-specification-v2.md:289)
   */
  test("no payment is constructed when every accepts entry is an unrecognized flow", async () => {
    await expect(
      client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [buildPaymentRequirements({ extra: { paymentFlow: "teleport" } })],
        }),
      ),
    ).rejects.toThrow(/recognized paymentFlow/);
    expect(schemeClient.createPaymentPayloadCalls).toHaveLength(0);
  });

  test("an unrecognized flow is skipped in favour of a recognized one", async () => {
    const recognized = buildPaymentRequirements({ extra: { paymentFlow: "escrow" } });
    await client.createPaymentPayload(
      buildPaymentRequired({
        accepts: [buildPaymentRequirements({ extra: { paymentFlow: "teleport" } }), recognized],
      }),
    );
    expect(schemeClient.createPaymentPayloadCalls).toHaveLength(1);
    expect(schemeClient.createPaymentPayloadCalls[0].requirements.extra).toEqual({
      paymentFlow: "escrow",
    });
  });

  /**
   * "When a resource offers both `authorization` (post-handler settlement) and
   * a pre-handler-settlement flow (`upfront` or `escrow`) for the same request,
   * clients SHOULD prefer `authorization`."
   * (specs/x402-specification-v2.md:289)
   *
   * The default selector takes `accepts[0]`, so the pre-handler entry is put
   * first: preferring authorization has to be the selection step's doing, not
   * the ordering's.
   */
  test.each(["upfront", "escrow"] as const)(
    "authorization is preferred over a leading %s entry",
    async flow => {
      await client.createPaymentPayload(
        buildPaymentRequired({
          accepts: [
            buildPaymentRequirements({ extra: { paymentFlow: flow } }),
            buildPaymentRequirements({ extra: { paymentFlow: "authorization" } }),
          ],
        }),
      );
      expect(schemeClient.createPaymentPayloadCalls[0].requirements.extra).toEqual({
        paymentFlow: "authorization",
      });
    },
  );

  test("an omitted paymentFlow counts as authorization when preferring", async () => {
    await client.createPaymentPayload(
      buildPaymentRequired({
        accepts: [
          buildPaymentRequirements({ extra: { paymentFlow: "escrow" } }),
          buildPaymentRequirements({ extra: {} }),
        ],
      }),
    );
    expect(schemeClient.createPaymentPayloadCalls[0].requirements.extra).toEqual({});
  });
});

describe("§5.3.2 / §9 settlement_pending carries its broadcast hash", () => {
  /**
   * "`transaction` … MUST be non-empty when `errorReason` is
   * `settlement_pending`" (specs/x402-specification-v2.md:249, restated at
   * :608).
   *
   * The hash is what makes the code non-terminal: it is the handle the caller
   * reconciles on. `settleWithPendingRetry` reads it as such — it retries a
   * pending outcome only when a hash is present
   * (`x402ResourceServer.ts:2048`).
   *
   * These two tests record both halves of that: a conforming pending response
   * is treated as non-terminal and resumed, and a response that violates the
   * MUST is not — it takes the terminal path with nothing raised. The core
   * consumes the field correctly; nothing in it holds a facilitator to the
   * obligation, so a malformed pending is indistinguishable here from a
   * terminal failure.
   */
  const settleCountFor = async (transaction: string): Promise<number> => {
    let settleCalls = 0;
    const facilitator = new MockFacilitatorClient(
      buildSupportedResponse({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }] }),
      buildVerifyResponse({ isValid: true }),
    );
    facilitator.settle = async () => {
      settleCalls++;
      return {
        success: false,
        errorReason: "settlement_pending",
        transaction,
        network: NETWORK,
      };
    };

    const resourceServer = new x402ResourceServer(facilitator);
    resourceServer.register(
      NETWORK,
      new MockSchemeNetworkServer("exact", {
        amount: "1000000",
        asset: "TEST_ASSET",
        extra: {},
      }),
    );
    await resourceServer.initialize();

    const httpServer = new x402HTTPResourceServer(resourceServer, {
      "/api/test": {
        accepts: {
          scheme: "exact",
          payTo: "test_recipient",
          price: "$1.00" as Price,
          network: NETWORK,
        },
      },
    });
    await httpServer.processSettlement(
      buildPaymentPayload(),
      buildPaymentRequirements({ scheme: "exact", network: NETWORK }),
    );
    return settleCalls;
  };

  test("a conforming pending response is resumed rather than concluded", async () => {
    expect(await settleCountFor("0xbroadcast")).toBe(2);
  });

  test("a pending response without the required hash takes the terminal path", async () => {
    expect(await settleCountFor("")).toBe(1);
  });
});
