import { beforeAll, describe, expect, it } from "vitest";
import { ExactCardanoScheme as ExactCardanoClient } from "../../src/exact/client/scheme";
import {
  ExactCardanoScheme as ExactCardanoFacilitatorBase,
  supportedCardanoNetworks,
  type ExactCardanoFacilitatorConfig,
} from "../../src/exact/facilitator/scheme";
import {
  ExactCardanoScheme as ExactCardanoServerBase,
  type ExactCardanoServerConfig,
} from "../../src/exact/server/scheme";
import {
  CARDANO_MAINNET_CAIP2,
  CARDANO_NETWORKS,
  CARDANO_PREPROD_CAIP2,
  LOVELACE_ASSET,
  USDM_MAINNET_ASSET,
} from "../../src/constants";
import type { ClientCardanoSigner, FacilitatorCardanoSigner } from "../../src/signer";
import { decodeCardanoTransaction } from "../../src/utils";
import { InMemoryCardanoSettlementStore } from "../../src/idempotency";
import { InMemoryMasumiTermsStorage } from "../../src/exact/masumi/storage";
import { buildSignedTerms, computeTermsDigest } from "../../src/exact/masumi/digests";
import type { CardanoExtraMasumi } from "../../src/types";
import { validateMasumiExtra } from "../../src/exact/masumi/schema";
import { issueMasumiRequirements } from "../helpers/masumi";
import type { PaymentRequirements } from "@x402/core/types";
import { buildSignedTx } from "../helpers/buildSignedTx";
import {
  freshPreprodAddress,
  NONCE_REF,
  stubFacilitatorSigner as stubFacilitator,
  TTL_SLOT,
} from "../helpers/stubs";

const PREPROD = CARDANO_PREPROD_CAIP2;

/** Test-only facilitator with explicit volatile replay storage. */
class ExactCardanoFacilitator extends ExactCardanoFacilitatorBase {
  constructor(signer: FacilitatorCardanoSigner, config: ExactCardanoFacilitatorConfig = {}) {
    super(signer, { inMemorySettlementStoreMaxEntries: 4096, ...config });
  }
}

/** Test-only alias; the resource server needs no storage configuration. */
class ExactCardanoServer extends ExactCardanoServerBase {
  constructor(config: ExactCardanoServerConfig = {}) {
    super(config);
  }
}

/** Issues a fresh, spec-valid Masumi quote for the resource-server tests. */
const masumiRequirements = () =>
  issueMasumiRequirements({
    network: PREPROD,
    asset: LOVELACE_ASSET,
    amount: "5000000",
    payByTimeMs: 1_785_756_000_000n,
    confirmationPolicy: { l1Confirmations: 0 },
  });

/** The seller-signed digest a Masumi requirement is stored under. */
const termsDigestOf = (requirements: PaymentRequirements): string =>
  computeTermsDigest(
    buildSignedTerms(requirements.extra as unknown as CardanoExtraMasumi, requirements),
  );

/** Minimal enrich context: the hook only reads the advertised requirements. */
const enrichContext = (requirements: PaymentRequirements[]) => ({
  requirements,
  resourceInfo: { url: "https://example.com/jobs", mimeType: "application/json" },
  paymentRequiredResponse: { x402Version: 2, accepts: requirements },
});

/** Minimal after-verify context for a successfully verified payment. */
const verifyContext = (paymentPayload: { accepted: PaymentRequirements }) => ({
  paymentPayload,
  requirements: paymentPayload.accepted,
  declaredExtensions: {},
  result: { isValid: true, payer: "addr_test1payer" },
});

/** A server, its quote store, an issued Masumi quote and a payment for it. */
async function masumiFixture() {
  const masumiStorage = new InMemoryMasumiTermsStorage();
  const server = new ExactCardanoServer({ masumiStorage });
  const { requirements } = await masumiRequirements();
  const built = await buildSignedTx({
    payTo: requirements.payTo,
    asset: LOVELACE_ASSET,
    amount: BigInt(requirements.amount),
    nonceUtxoRef: NONCE_REF,
    ttlSlot: TTL_SLOT,
    network: PREPROD,
  });
  const payload = {
    x402Version: 2,
    accepted: requirements,
    payload: { transaction: built.transaction, nonce: built.nonce },
  };
  return { server, masumiStorage, requirements, payload };
}

const TX_HASH = "a".repeat(64);

const RECIPIENT = "addr1qxytestrecipientaddress00";

const buildRequirements = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: CARDANO_MAINNET_CAIP2,
  asset: USDM_MAINNET_ASSET,
  amount: "10000",
  payTo: RECIPIENT,
  maxTimeoutSeconds: 600,
  extra: {},
  ...overrides,
});

const stubSigner: ClientCardanoSigner = {
  getAddress: () => "addr1qxsomeaddress00",
  buildAndSignPaymentTransaction: () => ({
    transaction: "AAAA",
    nonce: `${TX_HASH}#0`,
  }),
};

const stubFacilitatorSigner: FacilitatorCardanoSigner = {
  getAddresses: () => ["addr1qfacilitator00"],
  getUtxo: async () => ({ exists: true, address: "addr1qpayer00" }),
  validatePhase1Transaction: async () => undefined,
  getCurrentSlot: async () => 100n,
  submitTransaction: async transaction => ({
    txHash: decodeCardanoTransaction(transaction).txHash,
    status: "confirmed",
  }),
};

describe("ExactCardanoScheme client", () => {
  const client = new ExactCardanoClient(stubSigner);

  it("declares the 'exact' scheme", () => {
    expect(client.scheme).toBe("exact");
  });

  it("rejects non-Cardano networks", async () => {
    const reqs = buildRequirements({ network: "ethereum:1" });
    await expect(client.createPaymentPayload(2, reqs)).rejects.toThrow(
      /Unsupported Cardano network/,
    );
  });

  it("rejects invalid pay-to addresses", async () => {
    await expect(
      client.createPaymentPayload(2, buildRequirements({ payTo: "0xnope" })),
    ).rejects.toThrow(/Invalid Cardano pay-to address/);
  });

  it("rejects invalid asset units", async () => {
    await expect(
      client.createPaymentPayload(2, buildRequirements({ asset: "not.a.unit" })),
    ).rejects.toThrow(/canonical lowercase form/);
  });

  it("rejects non-numeric amounts", async () => {
    await expect(
      client.createPaymentPayload(2, buildRequirements({ amount: "10.5" })),
    ).rejects.toThrow(/positive canonical integer/);
  });

  it("rejects zero, leading-zero, and uppercase wire values", async () => {
    await expect(
      client.createPaymentPayload(2, buildRequirements({ amount: "0" })),
    ).rejects.toThrow(/positive canonical integer/);
    await expect(
      client.createPaymentPayload(2, buildRequirements({ amount: "010000" })),
    ).rejects.toThrow(/positive canonical integer/);
    await expect(
      client.createPaymentPayload(
        2,
        buildRequirements({ asset: USDM_MAINNET_ASSET.toUpperCase() }),
      ),
    ).rejects.toThrow(/canonical lowercase form/);
  });

  it("rejects Masumi settlement fields returned for a default payment", async () => {
    const c = new ExactCardanoClient({
      ...stubSigner,
      buildAndSignPaymentTransaction: () => ({
        transaction: "AAAA",
        nonce: `${TX_HASH}#0`,
        settlementLayer: "l1",
      }),
    });
    await expect(c.createPaymentPayload(2, buildRequirements())).rejects.toThrow(
      /non-Masumi payment/,
    );
  });

  it("returns a payload from the signer for valid requirements", async () => {
    const result = await client.createPaymentPayload(2, buildRequirements());
    expect(result.x402Version).toBe(2);
    // An absent `submissionPolicy` normalizes to `server`, and the payload
    // records the mode the signer was asked to honour.
    expect(result.payload).toEqual({
      transaction: "AAAA",
      nonce: `${TX_HASH}#0`,
      submissionMode: "server",
    });
  });

  it("selects the mode the server's submissionPolicy dictates", async () => {
    const seen: string[] = [];
    const recordingSigner: ClientCardanoSigner = {
      getAddress: () => "addr1qxsomeaddress00",
      buildAndSignPaymentTransaction: input => {
        seen.push(input.submissionMode);
        return {
          transaction: "AAAA",
          nonce: `${TX_HASH}#0`,
          submissionMode: input.submissionMode,
        };
      },
    };
    const c = new ExactCardanoClient(recordingSigner);
    await c.createPaymentPayload(2, buildRequirements({ extra: { submissionPolicy: "client" } }));
    expect(seen).toEqual(["client"]);

    // `either` leaves the choice to the client's configured preference.
    const preferring = new ExactCardanoClient(recordingSigner, "client");
    const result = await preferring.createPaymentPayload(
      2,
      buildRequirements({ extra: { submissionPolicy: "either" } }),
    );
    expect((result.payload as { submissionMode: string }).submissionMode).toBe("client");
  });

  it("rejects requirements carrying an invalid policy", async () => {
    await expect(
      client.createPaymentPayload(
        2,
        buildRequirements({ extra: { confirmationPolicy: { l1Confirmations: 99 } } }),
      ),
    ).rejects.toThrow(/invalid submission\/confirmation policy/);
  });

  it("rejects a signer that ignored client-submission mode", async () => {
    const lyingSigner: ClientCardanoSigner = {
      getAddress: () => "addr1qxsomeaddress00",
      buildAndSignPaymentTransaction: () => ({
        transaction: "AAAA",
        nonce: `${TX_HASH}#0`,
        submissionMode: "server" as const,
      }),
    };
    const c = new ExactCardanoClient(lyingSigner);
    await expect(
      c.createPaymentPayload(2, buildRequirements({ extra: { submissionPolicy: "client" } })),
    ).rejects.toThrow(/honoured submissionMode server, expected client/);
  });

  it("rejects a signer that omits client-submission mode", async () => {
    const omittingSigner: ClientCardanoSigner = {
      getAddress: () => "addr1qxsomeaddress00",
      buildAndSignPaymentTransaction: () => ({
        transaction: "AAAA",
        nonce: `${TX_HASH}#0`,
      }),
    };
    const c = new ExactCardanoClient(omittingSigner);
    await expect(
      c.createPaymentPayload(2, buildRequirements({ extra: { submissionPolicy: "client" } })),
    ).rejects.toThrow(/honoured submissionMode undefined, expected client/);
  });

  it("rejects signer responses with invalid nonce", async () => {
    const badSigner: ClientCardanoSigner = {
      getAddress: () => "addr1q",
      buildAndSignPaymentTransaction: () => ({ transaction: "AA", nonce: "bad" }),
    };
    const c = new ExactCardanoClient(badSigner);
    await expect(c.createPaymentPayload(2, buildRequirements())).rejects.toThrow(
      /Cardano signer returned an invalid nonce/,
    );
  });
});

describe("ExactCardanoScheme facilitator", () => {
  it("requires replay persistence unless volatile storage is explicit", () => {
    expect(() => new ExactCardanoFacilitatorBase(stubFacilitatorSigner)).toThrow(
      /durable settlementStore/,
    );
  });

  it("declares CAIP family and scheme identifier", () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    expect(facilitator.scheme).toBe("exact");
    expect(facilitator.caipFamily).toBe("cardano:*");
  });

  it("returns its addresses via getSigners", () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    expect(facilitator.getSigners(CARDANO_MAINNET_CAIP2)).toEqual(["addr1qfacilitator00"]);
  });

  it("advertises its capabilities via getExtra", () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    expect(facilitator.getExtra(CARDANO_PREPROD_CAIP2)).toEqual({
      assetTransferMethods: ["default", "masumi", "script"],
      // No Hydra client is configured, so only L1 is offered.
      settlementLayers: ["l1"],
      // The client builds and signs the whole transaction, so it pays the fee.
      areFeesSponsored: false,
      // This stub signer has no evidence hook, so client submission is not offered.
      submissionModes: ["server"],
      l1Confirmations: {
        server: { minimum: 0, maximum: 0 },
      },
    });
  });

  it("advertises client submission once it can authenticate evidence", () => {
    const facilitator = new ExactCardanoFacilitator({
      ...stubFacilitatorSigner,
      getTransactionEvidence: async () => ({ status: "confirmed" as const, confirmations: 3 }),
    });
    const extra = facilitator.getExtra(CARDANO_PREPROD_CAIP2)!;
    expect(extra.submissionModes).toEqual(["server", "client"]);
    expect(extra.l1Confirmations).toEqual({
      server: { minimum: 0, maximum: 20 },
      client: { minimum: 0, maximum: 20 },
    });
  });

  it("advertises mempool evidence when the operator enables it", () => {
    const facilitator = new ExactCardanoFacilitator(
      {
        ...stubFacilitatorSigner,
        getTransactionEvidence: async () => ({ status: "mempool" as const, confirmations: -1 }),
      },
      { acceptMempool: true },
    );
    const extra = facilitator.getExtra(CARDANO_PREPROD_CAIP2)!;
    expect(extra.l1Confirmations).toEqual({
      server: { minimum: -1, maximum: 20 },
      client: { minimum: -1, maximum: 20 },
    });
  });

  it("does not advertise server submission without a complete phase-1 validator", () => {
    const facilitator = new ExactCardanoFacilitator({
      ...stubFacilitatorSigner,
      validatePhase1Transaction: undefined,
      getTransactionEvidence: async () => ({ status: "confirmed" as const, confirmations: 3 }),
    });
    const extra = facilitator.getExtra(CARDANO_PREPROD_CAIP2)!;
    expect(extra.submissionModes).toEqual(["client"]);
    expect(extra.l1Confirmations).toEqual({
      client: { minimum: 0, maximum: 20 },
    });
  });

  it("rejects payloads when networks differ", async () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    const result = await facilitator.verify(
      {
        x402Version: 2,
        accepted: buildRequirements({ network: "cardano:preview" }),
        payload: { transaction: "AA", nonce: `${TX_HASH}#0` },
      },
      buildRequirements(),
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
  });

  it("rejects payloads with non-Cardano networks", async () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    const reqs = buildRequirements({ network: "ethereum:1" });
    const result = await facilitator.verify(
      { x402Version: 2, accepted: reqs, payload: { transaction: "AA", nonce: `${TX_HASH}#0` } },
      reqs,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("network_mismatch");
  });

  it("rejects non-canonical requirements before decoding the transaction", async () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    for (const reqs of [
      buildRequirements({ amount: "0" }),
      buildRequirements({ amount: "010000" }),
      buildRequirements({ asset: USDM_MAINNET_ASSET.toUpperCase() }),
    ]) {
      const result = await facilitator.verify(
        { x402Version: 2, accepted: reqs, payload: { transaction: "AA", nonce: `${TX_HASH}#0` } },
        reqs,
      );
      expect(result.invalidReason).toBe("invalid_exact_cardano_requirements");
    }
  });

  it("rejects payloads with malformed nonce", async () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    const reqs = buildRequirements();
    const result = await facilitator.verify(
      { x402Version: 2, accepted: reqs, payload: { transaction: "AA", nonce: "bad" } },
      reqs,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_cardano_payload_nonce_invalid");
  });

  it("rejects payloads missing transaction", async () => {
    const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner);
    const reqs = buildRequirements();
    const result = await facilitator.verify(
      { x402Version: 2, accepted: reqs, payload: { nonce: `${TX_HASH}#0` } },
      reqs,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("invalid_exact_cardano_payload");
  });

  it("exposes the supported networks", () => {
    expect(supportedCardanoNetworks()).toEqual(CARDANO_NETWORKS);
  });

  it("rejects a script payment whose payTo is not the declared script address", async () => {
    class TestFacilitator extends ExactCardanoFacilitator {}
    const facilitator = new TestFacilitator(stubFacilitatorSigner);
    const result = await (
      facilitator as unknown as {
        runMethodSpecificChecks: (
          requirements: PaymentRequirements,
          decoded: unknown,
          context: unknown,
        ) => Promise<{ ok: true } | { ok: false; reason: string }>;
      }
    ).runMethodSpecificChecks(
      buildRequirements({
        payTo: RECIPIENT,
        extra: { assetTransferMethod: "script", scriptHash: "deadbeef" },
      }),
      { outputs: [] },
      { payload: { transaction: "AA", nonce: `${TX_HASH}#0` }, payer: "addr1qpayer00" },
    );
    expect(result).toEqual({
      ok: false,
      reason: "invalid_exact_cardano_payload_script_address_mismatch",
    });
  });

  describe("settlement", () => {
    // `settle()` re-derives its state from the real transaction, so these
    // isolation tests need a decodable one. Verification itself is stubbed out
    // by overriding verify(), which settle() still dispatches through.
    let transaction: string;
    let canonicalTxHash: string;
    let reqs: PaymentRequirements;

    /** A facilitator whose verification always passes. */
    class FakeOk extends ExactCardanoFacilitator {
      override async verify() {
        return { isValid: true, payer: "addr1qpayer00" };
      }
    }

    /**
     * Builds a payment payload around the shared fixture transaction.
     *
     * @param submissionMode - Optional payload submission mode.
     * @returns The payment payload.
     */
    const payloadFor = (submissionMode?: "server" | "client") => ({
      x402Version: 2,
      accepted: reqs,
      payload: { transaction, nonce: NONCE_REF, ...(submissionMode ? { submissionMode } : {}) },
    });

    beforeAll(async () => {
      const built = await buildSignedTx({
        payTo: await freshPreprodAddress(),
        asset: LOVELACE_ASSET,
        amount: 2_000_000n,
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: PREPROD,
      });
      transaction = built.transaction;
      canonicalTxHash = decodeCardanoTransaction(transaction).txHash;
      reqs = buildRequirements({ network: PREPROD, asset: LOVELACE_ASSET, amount: "2000000" });
    }, 60_000);

    it("rejects a submitter response for a different transaction id", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => ({ txHash: "b".repeat(64), status: "confirmed" }),
          getTransactionEvidence: async () => ({ status: "unknown", confirmations: -2 }),
        }),
      );
      const result = await facilitator.settle(payloadFor(), reqs);
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe("exact_cardano_settlement_failed");
      expect(result.errorMessage).toContain(`expected ${canonicalTxHash}`);
    });

    // The race the spec's mitigation targets: two callers reaching submission
    // before either has landed.
    it("rejects a concurrent second settle for the same transaction", async () => {
      let release: () => void = () => {};
      let signalReachedSubmit: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      // Resolves once the first call is genuinely mid-submission, so the second
      // call races a claim that is in flight rather than one not yet taken.
      const reachedSubmit = new Promise<void>(resolve => {
        signalReachedSubmit = resolve;
      });
      let submits = 0;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => {
            submits += 1;
            signalReachedSubmit();
            await gate;
            return { txHash: canonicalTxHash, status: "confirmed" };
          },
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 1 }),
        }),
      );
      const first = facilitator.settle(payloadFor(), reqs);
      await reachedSubmit;

      const second = await facilitator.settle(payloadFor(), reqs);
      expect(second.success).toBe(false);
      expect(second.errorReason).toBe("duplicate_settlement");

      release();
      expect((await first).success).toBe(true);
      // The duplicate never reached the node.
      expect(submits).toBe(1);
    });

    it("coordinates settlement claims across facilitator instances", async () => {
      let release: () => void = () => {};
      let signalReachedSubmit: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const reachedSubmit = new Promise<void>(resolve => {
        signalReachedSubmit = resolve;
      });
      let submits = 0;
      const signer = stubFacilitator({
        submitTransaction: async () => {
          submits += 1;
          signalReachedSubmit();
          await gate;
          return { txHash: canonicalTxHash, status: "confirmed" };
        },
        getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 1 }),
      });
      const settlementStore = new InMemoryCardanoSettlementStore();
      const firstFacilitator = new FakeOk(signer, { settlementStore });
      const secondFacilitator = new FakeOk(signer, { settlementStore });

      const first = firstFacilitator.settle(payloadFor(), reqs);
      await reachedSubmit;
      const duplicate = await secondFacilitator.settle(payloadFor(), reqs);

      expect(duplicate.success).toBe(false);
      expect(duplicate.errorReason).toBe("duplicate_settlement");
      release();
      expect((await first).success).toBe(true);
      expect(submits).toBe(1);
    });

    // A transaction that has not reached the required depth returns
    // payment_pending; the spec REQUIRES the paid retry to resume observing it
    // rather than be refused, or a fully paid payment could never be released.
    it("resumes a pending settlement on retry without submitting again", async () => {
      let submits = 0;
      let confirmations = 0;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => {
            submits += 1;
            return { txHash: canonicalTxHash, status: "confirmed" };
          },
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations }),
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const strict = buildRequirements({
        ...reqs,
        extra: { confirmationPolicy: { l1Confirmations: 2 } },
      });

      const pending = await facilitator.settle({ ...payloadFor(), accepted: strict }, strict);
      expect(pending.success).toBe(false);
      expect(pending.errorReason).toBe("payment_pending");

      // The chain advances; the retry must now succeed.
      confirmations = 2;
      const retry = await facilitator.settle({ ...payloadFor(), accepted: strict }, strict);
      expect(retry.success).toBe(true);
      expect(retry.extra).toMatchObject({ confirmations: 2 });
      expect(submits).toBe(1);
    });

    // Most providers expose no mempool read, so a just-broadcast transaction is
    // briefly indistinguishable from an unknown one. That is pending, not proof
    // the transaction does not exist.
    it("reports a just-submitted but not-yet-observable transaction as pending", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => ({ txHash: canonicalTxHash, status: "mempool" }),
          getTransactionEvidence: async () => ({ status: "unknown", confirmations: -2 }),
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const settle = await facilitator.settle(payloadFor(), reqs);
      expect(settle.success).toBe(false);
      // Not `evidence_mismatch`: the node took it, we just cannot see it yet.
      expect(settle.errorReason).toBe("exact_cardano_settlement_not_confirmed");
      expect(settle.extra).toMatchObject({ status: "mempool" });
    });

    // A signer that broadcasts and then waits for inclusion throws on a
    // confirmation timeout with the transaction already in flight. Releasing the
    // claim there would make the retry rebroadcast a transaction that may
    // already have landed — and typically fail on spent inputs, leaving the
    // payer charged with no resource.
    it("keeps the claim when submission throws after the transaction landed", async () => {
      let submits = 0;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => {
            submits += 1;
            // Broadcast succeeded; the wait for confirmation did not.
            throw new Error("timed out awaiting confirmation");
          },
          // The ledger nonetheless has it.
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 1 }),
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );

      // The throw is recovered from: the transaction is on-chain, so this
      // settles rather than reporting a failed payment.
      const first = await facilitator.settle(payloadFor(), reqs);
      expect(first.success).toBe(true);
      expect(first.extra).toMatchObject({ confirmations: 1 });

      // And the retry resumes observation without a second broadcast.
      const retry = await facilitator.settle(payloadFor(), reqs);
      expect(retry.success).toBe(true);
      expect(submits).toBe(1);
    });

    it("tombstones a transaction after definitive pre-ledger rejection", async () => {
      let submits = 0;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => {
            submits += 1;
            throw new Error("BadInputsUTxO (input already spent)");
          },
          getTransactionEvidence: async () => ({ status: "unknown", confirmations: -2 }),
          isDefinitiveSubmissionRejection: error =>
            error instanceof Error && error.message.includes("BadInputsUTxO"),
        }),
      );
      const failed = await facilitator.settle(payloadFor(), reqs);
      expect(failed.success).toBe(false);
      expect(failed.errorReason).toBe("exact_cardano_settlement_definitively_rejected");
      expect(failed.errorMessage).toContain("BadInputsUTxO");

      // The handler already ran before settlement. Reusing or replacing this
      // payment could bind that result to different bytes, so the quote is now
      // terminal and the rejected transaction is never broadcast again.
      const retry = await facilitator.settle(payloadFor(), reqs);
      expect(retry.errorReason).toBe("exact_cardano_settlement_definitively_rejected");
      expect(submits).toBe(1);
    });

    it("retains the claim after an ambiguous submission failure", async () => {
      let submits = 0;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => {
            submits += 1;
            throw new Error("provider connection closed");
          },
          getTransactionEvidence: async () => ({ status: "unknown", confirmations: -2 }),
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const first = await facilitator.settle(payloadFor(), reqs);
      expect(first.success).toBe(false);
      expect(first.transaction).toBe(decodeCardanoTransaction(transaction).txHash);
      await facilitator.settle(payloadFor(), reqs);
      expect(submits).toBe(1);
    });

    it("refuses a retry that flips the normalized submission mode", async () => {
      const facilitator = new FakeOk(stubFacilitator());
      const either = buildRequirements({ ...reqs, extra: { submissionPolicy: "either" } });
      const first = await facilitator.settle({ ...payloadFor("server"), accepted: either }, either);
      expect(first.success).toBe(true);
      const flipped = await facilitator.settle(
        { ...payloadFor("client"), accepted: either },
        either,
      );
      expect(flipped.success).toBe(false);
      expect(flipped.errorReason).toBe("invalid_exact_cardano_payload_submission_mode_mismatch");
    });

    it("reports the strongest verified evidence in the response extra", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 4 }),
        }),
      );
      const settle = await facilitator.settle(payloadFor(), reqs);
      expect(settle.success).toBe(true);
      expect(settle.extra).toMatchObject({
        status: "confirmed",
        submissionMode: "server",
        confirmations: 4,
      });
    });

    it("reports payment_pending when evidence is below the confirmation policy", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 0 }),
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const strict = buildRequirements({
        ...reqs,
        extra: { confirmationPolicy: { l1Confirmations: 3 } },
      });
      const settle = await facilitator.settle({ ...payloadFor(), accepted: strict }, strict);
      expect(settle.success).toBe(false);
      expect(settle.errorReason).toBe("payment_pending");
      expect(settle.extra).toMatchObject({ status: "pending", confirmations: 0 });
    });

    it("settles a self-submitted -1 payment without polling for inclusion", async () => {
      let evidenceCalls = 0;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => ({ txHash: canonicalTxHash, status: "mempool" }),
          // Present but must not be consulted: providers cannot see the mempool,
          // so polling would block until the transaction reaches a block.
          getTransactionEvidence: async () => {
            evidenceCalls++;
            return { status: "unknown", confirmations: -2 };
          },
        }),
        { acceptMempool: true },
      );
      const lenient = buildRequirements({
        ...reqs,
        extra: { confirmationPolicy: { l1Confirmations: -1 } },
      });

      const settle = await facilitator.settle({ ...payloadFor(), accepted: lenient }, lenient);

      expect(settle.success).toBe(true);
      expect(settle.extra?.status).toBe("mempool");
      expect(evidenceCalls).toBe(0);
    });

    it("rejects mempool-only settlements when acceptMempool is disabled (default)", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => ({ txHash: canonicalTxHash, status: "mempool" }),
          getTransactionEvidence: undefined,
        }),
      );
      const settle = await facilitator.settle(payloadFor(), reqs);
      expect(settle.success).toBe(false);
      expect(settle.errorReason).toBe("exact_cardano_settlement_not_confirmed");
    });

    it("accepts mempool-only settlements when acceptMempool is true and the policy allows -1", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => ({ txHash: canonicalTxHash, status: "mempool" }),
          getTransactionEvidence: undefined,
        }),
        { acceptMempool: true },
      );
      const lenient = buildRequirements({
        ...reqs,
        extra: { confirmationPolicy: { l1Confirmations: -1 } },
      });
      const settle = await facilitator.settle({ ...payloadFor(), accepted: lenient }, lenient);
      expect(settle.success).toBe(true);
      expect(settle.extra).toMatchObject({ status: "mempool", confirmations: -1 });
    });

    it("surfaces the underlying error message when submission throws", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => {
            throw new Error("BadInputsUTxO (input already spent)");
          },
        }),
      );
      const settle = await facilitator.settle(payloadFor(), reqs);
      expect(settle.success).toBe(false);
      expect(settle.errorReason).toBe("exact_cardano_settlement_failed");
      expect(settle.errorMessage).toContain("BadInputsUTxO");
    });

    it("never submits in client mode, settling from authenticated evidence alone", async () => {
      let submitted = 0;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => {
            submitted += 1;
            return { txHash: "abc", status: "confirmed" };
          },
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 2 }),
        }),
      );
      const clientReqs = buildRequirements({
        ...reqs,
        extra: { submissionPolicy: "client" },
      });
      const settle = await facilitator.settle(
        { ...payloadFor("client"), accepted: clientReqs },
        clientReqs,
      );
      expect(settle.success).toBe(true);
      expect(submitted).toBe(0);
      expect(settle.extra).toMatchObject({ submissionMode: "client", confirmations: 2 });
    });

    it("refuses a payload whose mode the policy does not allow", async () => {
      const facilitator = new FakeOk(stubFacilitator());
      const serverOnly = buildRequirements({ ...reqs, extra: { submissionPolicy: "server" } });
      const settle = await facilitator.settle(
        { ...payloadFor("client"), accepted: serverOnly },
        serverOnly,
      );
      expect(settle.success).toBe(false);
      expect(settle.errorReason).toBe("invalid_exact_cardano_payload_submission_mode_mismatch");
    });
  });
});

describe("ExactCardanoScheme server", () => {
  it("stores each issued Masumi quote under its terms digest", async () => {
    const stored: string[] = [];
    class RecordingStorage extends InMemoryMasumiTermsStorage {
      async updateTerms(
        digest: string,
        update: Parameters<InMemoryMasumiTermsStorage["updateTerms"]>[1],
      ): ReturnType<InMemoryMasumiTermsStorage["updateTerms"]> {
        stored.push(digest);
        return super.updateTerms(digest, update);
      }
    }
    const masumiStorage = new RecordingStorage();
    const server = new ExactCardanoServer({ masumiStorage });
    const { requirements } = await masumiRequirements();
    const plain = buildRequirements({ network: PREPROD, asset: LOVELACE_ASSET, amount: "5000000" });

    await server.enrichPaymentRequiredResponse(enrichContext([requirements, plain]) as never);

    // Only the Masumi accept is persisted; default/script never reach the store.
    expect(stored).toEqual([termsDigestOf(requirements)]);
    expect((await masumiStorage.get(termsDigestOf(requirements)))?.requirements).toEqual(
      requirements,
    );
  });

  it("keeps the first issued quote when the same terms are served again", async () => {
    const masumiStorage = new InMemoryMasumiTermsStorage();
    const server = new ExactCardanoServer({ masumiStorage });
    const { requirements } = await masumiRequirements();
    const rotated = { ...requirements, amount: "9999999" };

    await server.enrichPaymentRequiredResponse(enrichContext([requirements]) as never);
    await server.enrichPaymentRequiredResponse(enrichContext([rotated]) as never);

    const stored = await masumiStorage.get(termsDigestOf(requirements));
    expect(stored?.requirements.amount).toBe(requirements.amount);
  });

  it("accepts a paid retry that presents the quote it was issued", async () => {
    const { server, masumiStorage, requirements, payload } = await masumiFixture();
    await server.enrichPaymentRequiredResponse(enrichContext([requirements]) as never);

    expect(
      await server.schemeHooks.onAfterVerify!(verifyContext(payload) as never),
    ).toBeUndefined();
    expect((await masumiStorage.get(termsDigestOf(requirements)))?.claimedTxHash).toBe(
      decodeCardanoTransaction(payload.payload.transaction as string).txHash,
    );

    // The same transaction may retry while settlement is still pending.
    expect(
      await server.schemeHooks.onAfterVerify!(verifyContext(payload) as never),
    ).toBeUndefined();
  });

  it("rejects a paid retry quoting terms this server never issued", async () => {
    const { server, payload } = await masumiFixture();

    expect(await server.schemeHooks.onAfterVerify!(verifyContext(payload) as never)).toEqual({
      abort: true,
      reason: "masumi_terms_unknown",
      message: expect.stringContaining("did not issue"),
    });
  });

  it("rejects a paid retry that altered the issued requirements", async () => {
    const { server, requirements, payload } = await masumiFixture();
    await server.enrichPaymentRequiredResponse(enrichContext([requirements]) as never);

    // `areFeesSponsored` sits outside termsDigest coverage, so the digest still
    // resolves and the stored copy is what catches the mutation.
    const mutated = {
      ...payload,
      accepted: {
        ...requirements,
        extra: { ...(requirements.extra as Record<string, unknown>), areFeesSponsored: true },
      } as PaymentRequirements,
    };

    expect(await server.schemeHooks.onAfterVerify!(verifyContext(mutated) as never)).toEqual({
      abort: true,
      reason: "masumi_terms_mismatch",
      message: expect.stringContaining("altered the issued payment requirements"),
    });
  });

  it("binds one transaction per terms digest and refuses a second", async () => {
    const { server, requirements, payload } = await masumiFixture();
    const other = await buildSignedTx({
      payTo: requirements.payTo,
      asset: LOVELACE_ASSET,
      amount: 5_000_000n,
      nonceUtxoRef: NONCE_REF,
      ttlSlot: TTL_SLOT,
      network: PREPROD,
    });
    await server.enrichPaymentRequiredResponse(enrichContext([requirements]) as never);

    expect(
      await server.schemeHooks.onAfterVerify!(verifyContext(payload) as never),
    ).toBeUndefined();

    const second = {
      ...payload,
      payload: { transaction: other.transaction, nonce: other.nonce },
    };
    expect(await server.schemeHooks.onAfterVerify!(verifyContext(second) as never)).toEqual({
      abort: true,
      reason: "duplicate_settlement",
      message: expect.stringContaining("different Cardano transaction"),
    });
  });

  it("leaves default and script payments untouched by quote storage", async () => {
    const masumiStorage = new InMemoryMasumiTermsStorage();
    const server = new ExactCardanoServer({ masumiStorage });
    const payTo = await freshPreprodAddress();
    const built = await buildSignedTx({
      payTo,
      asset: LOVELACE_ASSET,
      amount: 2_000_000n,
      nonceUtxoRef: NONCE_REF,
      ttlSlot: TTL_SLOT,
      network: PREPROD,
    });
    const requirements = buildRequirements({
      network: PREPROD,
      payTo,
      asset: LOVELACE_ASSET,
      amount: "2000000",
      extra: { assetTransferMethod: "script" },
    });
    const payload = {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: built.transaction, nonce: built.nonce },
    };

    expect(
      await server.schemeHooks.onAfterVerify!(verifyContext(payload) as never),
    ).toBeUndefined();
    // A second, different transaction for the same requirements is a facilitator
    // concern for these methods, not a resource-server one.
    expect(
      await server.schemeHooks.onAfterVerify!(verifyContext(payload) as never),
    ).toBeUndefined();
  });

  it("needs no storage configuration to construct", () => {
    expect(() => new ExactCardanoServerBase()).not.toThrow();
  });
  it("parses Money strings to USDM atomic units", async () => {
    const server = new ExactCardanoServer();
    const result = await server.parsePrice("$1.50", CARDANO_MAINNET_CAIP2);
    expect(result.amount).toBe("1500000");
    expect(result.asset).toBe(USDM_MAINNET_ASSET);
  });

  it("passes through AssetAmount", async () => {
    const server = new ExactCardanoServer();
    const result = await server.parsePrice(
      { amount: "12345", asset: USDM_MAINNET_ASSET, extra: { tier: "premium" } },
      CARDANO_MAINNET_CAIP2,
    );
    expect(result.amount).toBe("12345");
    expect(result.extra?.tier).toBe("premium");
  });

  it("rejects non-canonical AssetAmount values before issuing requirements", async () => {
    const server = new ExactCardanoServer();
    await expect(
      server.parsePrice({ amount: "0", asset: LOVELACE_ASSET }, CARDANO_MAINNET_CAIP2),
    ).rejects.toThrow(/positive canonical integer/);
    await expect(
      server.parsePrice({ amount: "001", asset: LOVELACE_ASSET }, CARDANO_MAINNET_CAIP2),
    ).rejects.toThrow(/positive canonical integer/);
    await expect(
      server.parsePrice(
        { amount: "1", asset: USDM_MAINNET_ASSET.toUpperCase() },
        CARDANO_MAINNET_CAIP2,
      ),
    ).rejects.toThrow(/canonical lowercase Cardano form/);
  });

  it("rejects non-canonical custom money parser results", async () => {
    const server = new ExactCardanoServer();
    server.registerMoneyParser(async () => ({
      amount: "01",
      asset: USDM_MAINNET_ASSET,
    }));
    await expect(server.parsePrice("1", CARDANO_MAINNET_CAIP2)).rejects.toThrow(
      /positive canonical integer/,
    );
  });

  it("reports decimals only for default assets", () => {
    const server = new ExactCardanoServer();
    expect(server.getAssetDecimals(USDM_MAINNET_ASSET, CARDANO_MAINNET_CAIP2)).toBe(6);
    expect(server.getAssetDecimals(LOVELACE_ASSET, CARDANO_MAINNET_CAIP2)).toBeUndefined();
  });

  it("resolves a ticker-suffixed Money string to USDM", async () => {
    const server = new ExactCardanoServer();
    const parsed = await server.parsePrice("0.25 USDM", CARDANO_MAINNET_CAIP2);
    expect(parsed).toEqual({ amount: "250000", asset: USDM_MAINNET_ASSET, extra: {} });
    await expect(server.parsePrice("0.25 USDC", CARDANO_MAINNET_CAIP2)).rejects.toThrow(
      /No USDC default asset/,
    );
  });

  it("rejects a Money value that rounds to zero atomic units", async () => {
    const server = new ExactCardanoServer();
    await expect(server.parsePrice("$0.0000001", CARDANO_MAINNET_CAIP2)).rejects.toThrow(
      /must be a positive canonical integer: 0/,
    );
  });

  it("supports MoneyParser chaining", async () => {
    const server = new ExactCardanoServer();
    server.registerMoneyParser(async amount =>
      amount > 100
        ? { amount: (amount * 1e6).toString(), asset: USDM_MAINNET_ASSET, extra: { tier: "vip" } }
        : null,
    );
    const big = await server.parsePrice("150", CARDANO_MAINNET_CAIP2);
    expect(big.extra?.tier).toBe("vip");
    const small = await server.parsePrice("1", CARDANO_MAINNET_CAIP2);
    expect(small.extra?.tier).toBeUndefined();
    expect(small.amount).toBe("1000000");
  });

  // `/supported` extra is capability advertisement, not payload semantics.
  // Merging it into the requirements would put `assetTransferMethods`,
  // `settlementLayers` and friends inside `extra` — and the Masumi `extra` is a
  // CLOSED object, so every Masumi 402 would be invalid on arrival.
  it("enhancePaymentRequirements leaves the requirements' extra untouched", async () => {
    const server = new ExactCardanoServer();
    const baseRequirements = buildRequirements({ extra: { foo: "bar" } });
    const enhanced = await server.enhancePaymentRequirements(
      baseRequirements,
      {
        x402Version: 2,
        scheme: "exact",
        network: CARDANO_MAINNET_CAIP2,
        extra: {
          assetTransferMethods: ["default", "masumi", "script"],
          settlementLayers: ["l1"],
          submissionModes: ["server", "client"],
          l1Confirmations: {
            server: { minimum: 0, maximum: 20 },
            client: { minimum: 0, maximum: 20 },
          },
        },
      },
      [],
    );
    expect(enhanced.extra).toEqual({ foo: "bar" });
  });

  // A facilitator that publishes an `extra` has claimed to describe itself, so a
  // capability this scheme selects and cannot find there is a rejection — not
  // silent permission to serve a 402 nobody can settle.
  it("rejects a half-filled facilitator capability advertisement", async () => {
    const server = new ExactCardanoServer();
    await expect(
      server.enhancePaymentRequirements(
        buildRequirements(),
        {
          x402Version: 2,
          scheme: "exact",
          network: CARDANO_MAINNET_CAIP2,
          extra: { assetTransferMethods: ["default"], settlementLayers: ["l1"] },
        },
        [],
      ),
    ).rejects.toThrow(/did not advertise submissionModes/);
  });

  // `auto` lets the buyer pick, but this scheme can only authenticate L1 — a
  // Hydra payload is refused in verifyMasumiLock — so a Hydra-only facilitator
  // must not satisfy it.
  it("rejects Masumi auto settlement against a Hydra-only facilitator", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "5000000",
      payByTimeMs: BigInt(Date.now() + 5 * 60 * 1000),
      settlementPolicy: "auto",
      confirmationPolicy: { l1Confirmations: 0 },
    });
    const server = new ExactCardanoServer();
    const capabilities = (layers: string[]) => ({
      x402Version: 2 as const,
      scheme: "exact",
      network: CARDANO_PREPROD_CAIP2,
      extra: {
        assetTransferMethods: ["default", "masumi"],
        settlementLayers: layers,
        submissionModes: ["server"],
        l1Confirmations: { server: { minimum: 0, maximum: 20 } },
      },
    });

    await expect(
      server.enhancePaymentRequirements(requirements, capabilities(["hydra"]), []),
    ).rejects.toThrow(/does not support Masumi auto settlement/);
    await expect(
      server.enhancePaymentRequirements(requirements, capabilities(["l1"]), []),
    ).resolves.toBeDefined();
  });

  it("rejects an explicit Masumi hydra policy the facilitator does not advertise", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "5000000",
      payByTimeMs: BigInt(Date.now() + 5 * 60 * 1000),
      settlementPolicy: "hydra",
      confirmationPolicy: { l1Confirmations: 0 },
    });
    const server = new ExactCardanoServer();
    await expect(
      server.enhancePaymentRequirements(
        requirements,
        {
          x402Version: 2,
          scheme: "exact",
          network: CARDANO_PREPROD_CAIP2,
          extra: {
            assetTransferMethods: ["default", "masumi"],
            settlementLayers: ["l1"],
            submissionModes: ["server"],
            l1Confirmations: { server: { minimum: 0, maximum: 20 } },
          },
        },
        [],
      ),
    ).rejects.toThrow(/does not support Masumi hydra settlement/);
  });

  it("accepts requirements when the facilitator advertises no capabilities at all", async () => {
    const server = new ExactCardanoServer();
    const enhanced = await server.enhancePaymentRequirements(
      buildRequirements({ extra: { foo: "bar" } }),
      { x402Version: 2, scheme: "exact", network: CARDANO_MAINNET_CAIP2 },
      [],
    );
    expect(enhanced.extra).toEqual({ foo: "bar" });
  });

  it("rejects requirements whose submission mode is not advertised", async () => {
    const server = new ExactCardanoServer();
    await expect(
      server.enhancePaymentRequirements(
        buildRequirements(),
        {
          x402Version: 2,
          scheme: "exact",
          network: CARDANO_MAINNET_CAIP2,
          extra: {
            assetTransferMethods: ["default"],
            settlementLayers: ["l1"],
            submissionModes: ["client"],
            l1Confirmations: { client: { minimum: 0, maximum: 20 } },
          },
        },
        [],
      ),
    ).rejects.toThrow(/does not support server submission/);
  });

  it("rejects requirements outside the advertised confirmation range", async () => {
    const server = new ExactCardanoServer();
    await expect(
      server.enhancePaymentRequirements(
        buildRequirements({
          extra: { submissionPolicy: "server", confirmationPolicy: { l1Confirmations: 1 } },
        }),
        {
          x402Version: 2,
          scheme: "exact",
          network: CARDANO_MAINNET_CAIP2,
          extra: {
            assetTransferMethods: ["default"],
            settlementLayers: ["l1"],
            submissionModes: ["server"],
            l1Confirmations: { server: { minimum: 0, maximum: 0 } },
          },
        },
        [],
      ),
    ).rejects.toThrow(/confirmation range does not include 1/);
  });

  it("keeps an issued Masumi extra schema-valid through enhancement", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "5000000",
      payByTimeMs: 1_785_756_000_000n,
      confirmationPolicy: { l1Confirmations: 0 },
    });
    const server = new ExactCardanoServer();
    const enhanced = await server.enhancePaymentRequirements(
      requirements,
      {
        x402Version: 2,
        scheme: "exact",
        network: CARDANO_PREPROD_CAIP2,
        extra: new ExactCardanoFacilitator(stubFacilitator()).getExtra(CARDANO_PREPROD_CAIP2),
      },
      [],
    );
    expect(validateMasumiExtra(enhanced.extra, CARDANO_PREPROD_CAIP2).ok).toBe(true);
    // The fee model is the one capability restated in the 402.
    expect(enhanced.extra?.areFeesSponsored).toBe(false);
  });

  it("rejects a Masumi extra that claims sponsored fees", async () => {
    const { requirements } = await issueMasumiRequirements({
      network: CARDANO_PREPROD_CAIP2,
      asset: LOVELACE_ASSET,
      amount: "5000000",
      payByTimeMs: 1_785_756_000_000n,
      confirmationPolicy: { l1Confirmations: 0 },
    });
    const claimed = { ...requirements.extra, areFeesSponsored: true };
    expect(validateMasumiExtra(claimed, CARDANO_PREPROD_CAIP2).ok).toBe(false);
  });
});
