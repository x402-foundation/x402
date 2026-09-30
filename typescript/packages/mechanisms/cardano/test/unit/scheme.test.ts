import { PrivateKey } from "@evolution-sdk/evolution";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { InMemoryCardanoSettlementStore } from "../../src/settlementStore";
import { InMemoryMasumiTermsStorage } from "../../src/exact/masumi/storage";
import { buildSignedTerms, computeTermsDigest } from "../../src/exact/masumi/digests";
import { masumiEscrowAddress } from "../../src/exact/masumi/blueprint";
import { toMasumiSellerSigner } from "../../src/exact/masumi/issue";
import { paymentPayloadFromTransportContext } from "../../src/exact/server/masumiIssuer";
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

/** Test-only alias; the facilitator defaults to a process-local settlement store. */
class ExactCardanoFacilitator extends ExactCardanoFacilitatorBase {
  constructor(signer: FacilitatorCardanoSigner, config: ExactCardanoFacilitatorConfig = {}) {
    super(signer, config);
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

  it("returns a payload from the signer for valid requirements", async () => {
    const result = await client.createPaymentPayload(2, buildRequirements());
    expect(result.x402Version).toBe(2);
    // The payload carries exactly the signed transaction and its nonce; the
    // facilitator broadcasts it, so nothing else travels on the wire.
    expect(result.payload).toEqual({ transaction: "AAAA", nonce: `${TX_HASH}#0` });
  });

  it("rejects requirements carrying an invalid policy", async () => {
    await expect(
      client.createPaymentPayload(
        2,
        buildRequirements({ extra: { confirmationPolicy: { l1Confirmations: 99 } } }),
      ),
    ).rejects.toThrow(/invalid confirmation policy/);
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
  it("constructs with a bounded in-memory settlement store by default", () => {
    expect(() => new ExactCardanoFacilitatorBase(stubFacilitatorSigner)).not.toThrow();
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
      // The client builds and signs the whole transaction, so it pays the fee.
      areFeesSponsored: false,
      // This stub signer has no evidence hook, so only canonical inclusion is offered.
      l1Confirmations: { minimum: 0, maximum: 0 },
    });
  });

  it("advertises confirmation depth once it can authenticate evidence", () => {
    const facilitator = new ExactCardanoFacilitator({
      ...stubFacilitatorSigner,
      getTransactionEvidence: async () => ({ status: "confirmed" as const, confirmations: 3 }),
    });
    expect(facilitator.getExtra(CARDANO_PREPROD_CAIP2)!.l1Confirmations).toEqual({
      minimum: 0,
      maximum: 20,
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
    expect(facilitator.getExtra(CARDANO_PREPROD_CAIP2)!.l1Confirmations).toEqual({
      minimum: -1,
      maximum: 20,
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
    /** Requirements the fixture does NOT pay (verification is faked around them). */
    let reqs: PaymentRequirements;
    /** Requirements the fixture really pays, for tests that run real verification. */
    let realReqs: PaymentRequirements;

    /** A facilitator whose verification always passes, on first call and on the retry. */
    class FakeOk extends ExactCardanoFacilitator {
      override async verify() {
        return { isValid: true, payer: "addr1qpayer00" };
      }
      protected override async verifyBroadcast() {
        return { isValid: true, payer: "addr1qpayer00" };
      }
    }

    /**
     * Builds a payment payload around the shared fixture transaction.
     *
     * @returns The payment payload.
     */
    const payloadFor = () => ({
      x402Version: 2,
      accepted: reqs,
      payload: { transaction, nonce: NONCE_REF },
    });

    beforeAll(async () => {
      const payTo = await freshPreprodAddress();
      const built = await buildSignedTx({
        payTo,
        asset: LOVELACE_ASSET,
        amount: 2_000_000n,
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: PREPROD,
      });
      transaction = built.transaction;
      canonicalTxHash = decodeCardanoTransaction(transaction).txHash;
      reqs = buildRequirements({ network: PREPROD, asset: LOVELACE_ASSET, amount: "2000000" });
      realReqs = buildRequirements({
        network: PREPROD,
        asset: LOVELACE_ASSET,
        amount: "2000000",
        payTo,
        extra: { confirmationPolicy: { l1Confirmations: 1 } },
      });
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

    it("settles with the default in-memory settlement store", async () => {
      const facilitator = new (class extends ExactCardanoFacilitatorBase {
        override async verify() {
          return { isValid: true, payer: "addr1qpayer00" };
        }
        protected override async verifyBroadcast() {
          return { isValid: true, payer: "addr1qpayer00" };
        }
      })(stubFacilitator());
      const first = await facilitator.settle(payloadFor(), reqs);
      expect(first.success).toBe(true);
      // The default store still guards the retry: same transaction, no rebroadcast.
      const retry = await facilitator.settle(payloadFor(), reqs);
      expect(retry.success).toBe(true);
    });

    // A transaction that has not reached the required depth returns the
    // non-terminal settlement_pending; core retries once with the same payload
    // and the facilitator resumes observing rather than refusing, or a fully
    // paid payment could never be released.
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
      expect(pending.errorReason).toBe("settlement_pending");
      // Core's retry predicate needs the broadcast hash on the pending result.
      expect(pending.transaction).toBe(canonicalTxHash);
      expect(pending.extra).toMatchObject({ status: "pending", transactionId: canonicalTxHash });

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
      // The node took it and a block will follow, so core may retry.
      expect(settle.errorReason).toBe("settlement_pending");
      expect(settle.transaction).toBe(canonicalTxHash);
      expect(settle.extra).toMatchObject({ status: "pending", confirmations: -1 });
    });

    // A resumed observation that still cannot see the transaction stays pending
    // while the validity window is open; once the TTL slot has passed the
    // transaction can no longer land, so waiting further would be pointless.
    it("fails a resumed settlement whose validity window closed unobserved", async () => {
      let currentSlot = TTL_SLOT - 1n;
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => ({ txHash: canonicalTxHash, status: "mempool" }),
          getTransactionEvidence: async () => ({ status: "unknown", confirmations: -2 }),
          getCurrentSlot: async () => currentSlot,
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      expect((await facilitator.settle(payloadFor(), reqs)).errorReason).toBe("settlement_pending");
      // Still inside the window: keep waiting.
      expect((await facilitator.settle(payloadFor(), reqs)).errorReason).toBe("settlement_pending");
      // Just past the TTL is still inside the indexing grace: a transaction
      // included in the TTL block may not be visible yet.
      currentSlot = TTL_SLOT + 1n;
      expect((await facilitator.settle(payloadFor(), reqs)).errorReason).toBe("settlement_pending");
      currentSlot = TTL_SLOT + 600n;
      const expired = await facilitator.settle(payloadFor(), reqs);
      expect(expired.success).toBe(false);
      expect(expired.errorReason).toBe("exact_cardano_settlement_failed");
      expect(expired.errorMessage).toContain("validity window closed");
      expect(expired.transaction).toBe(canonicalTxHash);
      expect(expired.extra).toEqual({ status: "expired" });
    });

    // A rejected payment must not leave a claim behind: nothing was broadcast,
    // so the same transaction can be settled once the objection is gone.
    it("reports the transaction id on a verification failure and releases the claim", async () => {
      const settlementStore = new InMemoryCardanoSettlementStore();
      const signer = stubFacilitator();
      let submits = 0;
      const strict = new (class extends ExactCardanoFacilitatorBase {
        override async verify() {
          return { isValid: false, invalidReason: "custom_policy_rejection", payer: "" };
        }
      })(signer, { settlementStore });
      const rejected = await strict.settle(payloadFor(), reqs);
      expect(rejected.success).toBe(false);
      expect(rejected.errorReason).toBe("custom_policy_rejection");
      expect(rejected.transaction).toBe(canonicalTxHash);

      const lenient = new FakeOk(
        {
          ...signer,
          submitTransaction: async (tx, network) => {
            submits += 1;
            return signer.submitTransaction(tx, network);
          },
        },
        { settlementStore },
      );
      expect((await lenient.settle(payloadFor(), reqs)).success).toBe(true);
      expect(submits).toBe(1);
    });

    // Real verification on the retry: once the transaction is broadcast its
    // inputs are spent and the ledger may not have indexed it yet, so a retry
    // must not be failed by the pre-broadcast preconditions.
    it("resumes a broadcast transaction even when its inputs are spent and evidence is unavailable", async () => {
      let submits = 0;
      let phase: "before" | "lagging" | "confirmed" = "before";
      const base = stubFacilitator();
      const facilitator = new ExactCardanoFacilitator(
        {
          ...base,
          submitTransaction: async () => {
            submits += 1;
            return { txHash: canonicalTxHash, status: "mempool" as const };
          },
          getUtxo: async (ref, network) =>
            phase === "before"
              ? base.getUtxo(ref, network)
              : { ...(await base.getUtxo(ref, network)), exists: false },
          getTransactionEvidence: async () => {
            if (phase === "before") return { status: "confirmed", confirmations: 0 };
            if (phase === "lagging") throw new Error("Blockfrost 502");
            return { status: "confirmed", confirmations: 1 };
          },
        },
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const realPayload = { ...payloadFor(), accepted: realReqs };

      const first = await facilitator.settle(realPayload, realReqs);
      expect(first.errorReason).toBe("settlement_pending");
      expect(submits).toBe(1);

      phase = "lagging";
      const retry = await facilitator.settle(realPayload, realReqs);
      expect(retry.success).toBe(false);
      expect(retry.errorReason).toBe("settlement_pending");
      expect(retry.transaction).toBe(canonicalTxHash);

      phase = "confirmed";
      const done = await facilitator.settle(realPayload, realReqs);
      expect(done.success, done.errorReason).toBe(true);
      expect(submits).toBe(1);
    });

    // Core retries `settle()` exactly once, so a payment gets two of these waits
    // to reach the policy; preprod block gaps of 80s have been observed, and two
    // 60s waits let such a payment end as a terminal 402 for the client.
    it("waits 75s by default for the policy before reporting settlement_pending", async () => {
      vi.useFakeTimers();
      try {
        let polls = 0;
        const facilitator = new FakeOk(
          stubFacilitator({
            submitTransaction: async () => ({
              txHash: canonicalTxHash,
              status: "mempool" as const,
            }),
            getTransactionEvidence: async () => {
              polls += 1;
              return { status: "confirmed", confirmations: 0 };
            },
          }),
        );
        let outcome: Awaited<ReturnType<typeof facilitator.settle>> | undefined;
        const settling = facilitator.settle(payloadFor(), reqs).then(result => {
          outcome = result;
          return result;
        });
        await vi.advanceTimersByTimeAsync(69_000);
        expect(outcome, "still waiting after 69s").toBeUndefined();
        await vi.advanceTimersByTimeAsync(11_000);
        const result = await settling;
        expect(result.errorReason).toBe("settlement_pending");
        expect(result.extra).toMatchObject({ status: "pending", confirmations: 0 });
        expect(polls).toBeGreaterThanOrEqual(14);
      } finally {
        vi.useRealTimers();
      }
    });

    // A provider hiccup while re-reading a transaction this facilitator already
    // broadcast is not a verdict on the payment: the retry must stay
    // non-terminal so the next attempt can observe the transaction once the
    // lookup recovers, instead of failing a payment that is landing on chain.
    it("keeps a broadcast transaction pending when the retry's chain lookup fails", async () => {
      let submits = 0;
      let phase: "before" | "lookup-failing" | "owner-unresolved" | "confirmed" = "before";
      const base = stubFacilitator();
      const facilitator = new ExactCardanoFacilitator(
        {
          ...base,
          submitTransaction: async () => {
            submits += 1;
            return { txHash: canonicalTxHash, status: "mempool" as const };
          },
          getUtxo: async (ref, network) => {
            if (phase === "lookup-failing") throw new Error("Blockfrost 502");
            if (phase === "owner-unresolved") return { exists: false };
            return base.getUtxo(ref, network);
          },
          getTransactionEvidence: async () =>
            phase === "confirmed"
              ? { status: "confirmed", confirmations: 1 }
              : { status: "unknown", confirmations: -2 },
        },
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const realPayload = { ...payloadFor(), accepted: realReqs };

      const first = await facilitator.settle(realPayload, realReqs);
      expect(first.errorReason).toBe("settlement_pending");
      expect(submits).toBe(1);

      for (const outage of ["lookup-failing", "owner-unresolved"] as const) {
        phase = outage;
        const retry = await facilitator.settle(realPayload, realReqs);
        expect(retry.success).toBe(false);
        expect(retry.errorReason, outage).toBe("settlement_pending");
        expect(retry.transaction).toBe(canonicalTxHash);
        expect(retry.extra).toMatchObject({ status: "pending", transactionId: canonicalTxHash });
      }

      phase = "confirmed";
      const done = await facilitator.settle(realPayload, realReqs);
      expect(done.success, done.errorReason).toBe(true);
      expect(submits).toBe(1);
    });

    // The retry skips only the preconditions the broadcast made moot; a second
    // resource server presenting the same transaction against its own
    // requirements must still be refused.
    it("refuses to resume a broadcast transaction against different requirements", async () => {
      let submits = 0;
      const facilitator = new ExactCardanoFacilitator(
        stubFacilitator({
          submitTransaction: async () => {
            submits += 1;
            return { txHash: canonicalTxHash, status: "mempool" as const };
          },
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 0 }),
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const realPayload = { ...payloadFor(), accepted: realReqs };
      expect((await facilitator.settle(realPayload, realReqs)).errorReason).toBe(
        "settlement_pending",
      );

      const elsewhere = { ...realReqs, payTo: await freshPreprodAddress() };
      const hijack = await facilitator.settle({ ...realPayload, accepted: elsewhere }, elsewhere);
      expect(hijack.success).toBe(false);
      expect(hijack.errorReason).toBe("invalid_exact_cardano_payload_recipient_mismatch");
      expect(hijack.transaction).toBe(canonicalTxHash);
      expect(submits).toBe(1);
    });

    // Mempool evidence below the policy is not a refusal when inclusion can
    // still be observed: the retry will see the block.
    it("reports observed mempool evidence below the policy as pending", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          submitTransaction: async () => ({ txHash: canonicalTxHash, status: "mempool" }),
          getTransactionEvidence: async () => ({ status: "mempool", confirmations: -1 }),
        }),
        { confirmationTimeoutMs: 1, confirmationPollMs: 1 },
      );
      const settle = await facilitator.settle(payloadFor(), reqs);
      expect(settle.success).toBe(false);
      expect(settle.errorReason).toBe("settlement_pending");
      expect(settle.extra).toMatchObject({ status: "pending", confirmations: -1 });
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

    it("reports the strongest verified evidence in the response extra", async () => {
      const facilitator = new FakeOk(
        stubFacilitator({
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 4 }),
        }),
      );
      const settle = await facilitator.settle(payloadFor(), reqs);
      expect(settle.success).toBe(true);
      expect(settle.extra).toEqual({ status: "confirmed", confirmations: 4 });
    });

    it("reports settlement_pending when evidence is below the confirmation policy", async () => {
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
      expect(settle.errorReason).toBe("settlement_pending");
      expect(settle.extra).toMatchObject({
        status: "pending",
        confirmations: 0,
        transactionId: canonicalTxHash,
      });
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
  // Merging it into the requirements would put `assetTransferMethods` and
  // friends inside `extra` — and the Masumi `extra` is a CLOSED object, so
  // every Masumi 402 would be invalid on arrival.
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
          l1Confirmations: { minimum: 0, maximum: 20 },
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
          extra: { assetTransferMethods: ["default"] },
        },
        [],
      ),
    ).rejects.toThrow(/did not advertise an l1Confirmations range/);
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

  it("rejects requirements outside the advertised confirmation range", async () => {
    const server = new ExactCardanoServer();
    await expect(
      server.enhancePaymentRequirements(
        buildRequirements({ extra: { confirmationPolicy: { l1Confirmations: 1 } } }),
        {
          x402Version: 2,
          scheme: "exact",
          network: CARDANO_MAINNET_CAIP2,
          extra: {
            assetTransferMethods: ["default"],
            l1Confirmations: { minimum: 0, maximum: 0 },
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

describe("ExactCardanoScheme server Masumi issuer", () => {
  const seller = toMasumiSellerSigner({
    mnemonic: PrivateKey.generateMnemonic(),
    network: PREPROD,
  });
  const capabilities = () => ({
    x402Version: 2 as const,
    scheme: "exact",
    network: PREPROD,
    extra: new ExactCardanoFacilitator(stubFacilitator()).getExtra(PREPROD),
  });

  /** A route template: the method selected, the escrow as payTo, no terms yet. */
  const template = (extra: Record<string, unknown> = {}): PaymentRequirements =>
    buildRequirements({
      network: PREPROD,
      asset: LOVELACE_ASSET,
      amount: "5000000",
      payTo: masumiEscrowAddress(PREPROD),
      extra: {
        assetTransferMethod: "masumi",
        confirmationPolicy: { l1Confirmations: 0 },
        areFeesSponsored: false,
        ...extra,
      },
    });

  const issuingServer = (masumiStorage = new InMemoryMasumiTermsStorage()) => ({
    server: new ExactCardanoServer({ masumiStorage, masumi: { seller } }),
    masumiStorage,
  });

  const enrich = async (
    server: ExactCardanoServer,
    requirements: PaymentRequirements[],
    extra: Record<string, unknown> = {},
  ): Promise<PaymentRequirements[]> =>
    (await server.enrichPaymentRequiredResponse({
      ...enrichContext(requirements),
      ...extra,
    } as never)) ?? requirements;

  it("issues a seller-signed quote for a template and keeps the template's baseline", async () => {
    const { server, masumiStorage } = issuingServer();
    const plain = buildRequirements({ network: PREPROD, asset: LOVELACE_ASSET, amount: "1" });

    const [issued, untouched] = await enrich(server, [template(), plain]);

    expect(untouched).toEqual(plain);
    expect(validateMasumiExtra(issued.extra, PREPROD).ok).toBe(true);
    const extra = issued.extra as unknown as CardanoExtraMasumi;
    expect(extra.terms.sellerAddress).toBe(seller.sellerAddress);
    // Core's additive policy: payment terms and every template key survive.
    expect(issued.payTo).toBe(template().payTo);
    expect(issued.amount).toBe("5000000");
    expect(issued.maxTimeoutSeconds).toBe(600);
    expect(extra.confirmationPolicy).toEqual({ l1Confirmations: 0 });
    expect(extra.areFeesSponsored).toBe(false);
    // payByTime is anchored to maxTimeoutSeconds; the commitment names the resource.
    expect(BigInt(extra.terms.payByTime)).toBeLessThanOrEqual(BigInt(Date.now() + 600_000));
    expect(extra.inputCommitment.parts[0]).toMatchObject({
      name: "resource",
      content: { url: "https://example.com/jobs" },
    });
    expect((await masumiStorage.get(termsDigestOf(issued)))?.requirements).toEqual(issued);
  });

  it("issues a fresh quote for every unpaid 402", async () => {
    const { server } = issuingServer();
    const [first] = await enrich(server, [template()]);
    const [second] = await enrich(server, [template()]);
    expect((first.extra as unknown as CardanoExtraMasumi).terms.sellerNonce).not.toBe(
      (second.extra as unknown as CardanoExtraMasumi).terms.sellerNonce,
    );
  });

  it("answers a paid retry with the quote it was issued", async () => {
    const { server } = issuingServer();
    const [issued] = await enrich(server, [template()]);
    const paymentPayload = {
      x402Version: 2,
      accepted: issued,
      payload: { transaction: "AA", nonce: NONCE_REF },
    };

    // Core passes the failed payload directly on error responses...
    const [viaContext] = await enrich(server, [template()], { paymentPayload });
    expect(viaContext).toEqual(issued);
    // ...but not on the paid path, where only the transport context carries it.
    const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const [viaHttp] = await enrich(server, [template()], {
      transportContext: { request: { paymentHeader } },
    });
    expect(viaHttp).toEqual(issued);
    const [viaMcp] = await enrich(server, [template()], {
      transportContext: { meta: { "x402/payment": paymentPayload } },
    });
    expect(viaMcp).toEqual(issued);
  });

  it("issues a fresh quote when the paid retry names terms it does not hold", async () => {
    const { server } = issuingServer();
    const { requirements: foreign } = await masumiRequirements();
    const [issued] = await enrich(server, [template()], {
      paymentPayload: {
        x402Version: 2,
        accepted: foreign,
        payload: { transaction: "AA", nonce: NONCE_REF },
      },
    });
    expect(termsDigestOf(issued)).not.toBe(termsDigestOf(foreign));
    expect(validateMasumiExtra(issued.extra, PREPROD).ok).toBe(true);
  });

  it("issues a fresh quote when the stored quote no longer fits the route", async () => {
    const { server } = issuingServer();
    const [issued] = await enrich(server, [template()]);
    const paymentPayload = {
      x402Version: 2,
      accepted: issued,
      payload: { transaction: "AA", nonce: NONCE_REF },
    };
    // The route now charges more: the old quote must not be served again.
    const [reissued] = await enrich(server, [{ ...template(), amount: "6000000" }], {
      paymentPayload,
    });
    expect(reissued.amount).toBe("6000000");
    expect(termsDigestOf(reissued)).not.toBe(termsDigestOf(issued));
  });

  it("leaves a fully issued Masumi requirement untouched", async () => {
    const { server } = issuingServer();
    const { requirements } = await masumiRequirements();
    expect(
      await server.enrichPaymentRequiredResponse(enrichContext([requirements]) as never),
    ).toBeUndefined();
  });

  it("refuses a template when no issuer is configured", async () => {
    const server = new ExactCardanoServer();
    await expect(server.enhancePaymentRequirements(template(), capabilities(), [])).rejects.toThrow(
      /configured with a `masumi` issuer/,
    );
    await expect(enrich(server, [template()])).rejects.toThrow(/configured with a `masumi` issuer/);
  });

  it("refuses a template whose payTo is not the escrow address", async () => {
    const { server } = issuingServer();
    await expect(
      server.enhancePaymentRequirements({ ...template(), payTo: RECIPIENT }, capabilities(), []),
    ).rejects.toThrow(new RegExp(`must be the escrow address ${masumiEscrowAddress(PREPROD)}`));
  });

  it("refuses a template whose deadlines would exceed the seller's horizon", async () => {
    const { server } = issuingServer();
    await expect(
      server.enhancePaymentRequirements(
        { ...template(), maxTimeoutSeconds: 40 * 24 * 60 * 60 },
        capabilities(),
        [],
      ),
    ).rejects.toThrow(/horizon/);
  });

  it("replaces one template per hook invocation, in accept order", async () => {
    const { server } = issuingServer();
    // Core invokes the hook once per Cardano accept; only accepts on the
    // invoking accept's network may gain keys, so each call issues one quote.
    const [firstPass1, firstPass2] = await enrich(server, [template(), template()]);
    expect((firstPass1.extra as { terms?: unknown }).terms).toBeDefined();
    expect((firstPass2.extra as { terms?: unknown }).terms).toBeUndefined();
    const [secondPass1, secondPass2] = await enrich(server, [firstPass1, firstPass2]);
    expect(secondPass1).toEqual(firstPass1);
    expect((secondPass2.extra as { terms?: unknown }).terms).toBeDefined();
  });

  it("refuses a template carrying keys the issuer would have to drop", async () => {
    const { server } = issuingServer();
    await expect(
      server.enhancePaymentRequirements(template({ memo: "hi" }), capabilities(), []),
    ).rejects.toThrow(/may only carry/);
  });

  it("accepts a well-formed template through enhancement", async () => {
    const { server } = issuingServer();
    const enhanced = await server.enhancePaymentRequirements(template(), capabilities(), []);
    expect(enhanced.extra?.assetTransferMethod).toBe("masumi");
    expect(enhanced.extra?.areFeesSponsored).toBe(false);
  });

  it("reads a payload only from transports it recognises", () => {
    const payload = {
      x402Version: 2,
      accepted: template(),
      payload: { transaction: "AA", nonce: NONCE_REF },
    };
    expect(paymentPayloadFromTransportContext(undefined)).toBeUndefined();
    expect(
      paymentPayloadFromTransportContext({ request: { paymentHeader: "not base64 json" } }),
    ).toBeUndefined();
    expect(
      paymentPayloadFromTransportContext({ meta: { "x402/payment": { nope: true } } }),
    ).toBeUndefined();
    expect(
      paymentPayloadFromTransportContext({
        request: { paymentHeader: Buffer.from(JSON.stringify(payload)).toString("base64") },
      }),
    ).toEqual(payload);
  });
});
