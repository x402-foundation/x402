import { Data, Transaction } from "@evolution-sdk/evolution";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, FacilitatorClient } from "@x402/core/server";
import {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from "@x402/core/types";

import { ExactCardanoScheme as ExactCardanoClient } from "../../src/exact/client/scheme";
import {
  ExactCardanoScheme as ExactCardanoFacilitatorBase,
  type ExactCardanoFacilitatorConfig,
} from "../../src/exact/facilitator/scheme";
import {
  ExactCardanoScheme as ExactCardanoServerBase,
  type ExactCardanoServerConfig,
} from "../../src/exact/server/scheme";
import {
  toClientCardanoSigner,
  toFacilitatorCardanoSigner,
  type CardanoUtxoSnapshot,
  type FacilitatorCardanoSigner,
} from "../../src/signer";
import { LOVELACE_ASSET, USDM_PREPROD_ASSET } from "../../src/constants";
import { buildScriptDatumInline } from "../../src/exact/script/datum";
import { decodeCardanoTransaction, slotToPosixMs } from "../../src/utils";
import { buildSignedTx, getFixtureInputSnapshot } from "../helpers/buildSignedTx";
import { issueMasumiRequirements } from "../helpers/masumi";
import {
  buildRequirements,
  buildStubMasumiLockTx,
  freshPreprodAddress,
  MINIMAL_PLUTUS_V3,
  NETWORK,
  NONCE_REF,
  scriptAddressFor,
  stubBuyerAddress,
  stubClientSigner,
  stubFacilitatorSigner,
  TTL_SLOT,
} from "../helpers/stubs";

/** Test-only facilitator with explicit volatile replay storage. */
class ExactCardanoFacilitator extends ExactCardanoFacilitatorBase {
  constructor(signer: FacilitatorCardanoSigner, config: ExactCardanoFacilitatorConfig = {}) {
    super(signer, { inMemorySettlementStoreMaxEntries: 4096, ...config });
  }
}

/** Test-only resource server with explicit volatile replay storage. */
class ExactCardanoServer extends ExactCardanoServerBase {
  constructor(config: ExactCardanoServerConfig = {}) {
    super({ inMemoryStore: {}, ...config });
  }
}

/**
 * Wraps the x402Facilitator for use with x402ResourceServer.
 */
class CardanoFacilitatorClient implements FacilitatorClient {
  readonly scheme = "exact";
  readonly network = NETWORK;
  readonly x402Version = 2;

  /**
   * @param facilitator - The x402 facilitator to wrap.
   */
  constructor(private readonly facilitator: x402Facilitator) {}

  /**
   * @param paymentPayload - The payment payload to verify.
   * @param paymentRequirements - The payment requirements.
   * @returns The verification response.
   */
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  /**
   * @param paymentPayload - The payment payload to settle.
   * @param paymentRequirements - The payment requirements.
   * @returns The settlement response.
   */
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  /**
   * @returns The supported payment kinds.
   */
  getSupported(): Promise<SupportedResponse> {
    return Promise.resolve(this.facilitator.getSupported());
  }
}

describe("Cardano Integration Tests (deterministic, offline)", () => {
  let recipient: string;

  beforeAll(async () => {
    recipient = await freshPreprodAddress();
  });

  describe("x402Client / x402ResourceServer / x402Facilitator - full flow", () => {
    let client: x402Client;
    let server: x402ResourceServer;

    beforeEach(async () => {
      // The offline flows pay lovelace (not USD-pegged) and USDM above the $1
      // default cap, so they opt out of spend controls like the e2e harness.
      client = x402Client.fromConfig({
        schemes: [{ network: NETWORK, client: new ExactCardanoClient(stubClientSigner()) }],
        spendControls: false,
      });

      const facilitator = new x402Facilitator().register(
        NETWORK,
        new ExactCardanoFacilitator(stubFacilitatorSigner()),
      );
      server = new x402ResourceServer(new CardanoFacilitatorClient(facilitator));
      server.register(NETWORK, new ExactCardanoServer());
      await server.initialize();
    });

    it("verifies and settles a lovelace payment end to end", async () => {
      const accepts = [buildRequirements(recipient, "1000000")];
      const resource = {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      };
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, resource);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      expect(paymentPayload.x402Version).toBe(2);
      expect(paymentPayload.accepted.scheme).toBe("exact");
      expect(
        (paymentPayload.payload as { transaction: string }).transaction.length,
      ).toBeGreaterThan(0);
      expect((paymentPayload.payload as { nonce: string }).nonce).toBe(NONCE_REF);

      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);
      const nonceSnapshot = getFixtureInputSnapshot(NONCE_REF);
      expect(nonceSnapshot).toBeDefined();
      expect(verifyResponse.payer).toBe(nonceSnapshot!.address);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.network).toBe(NETWORK);
      // The canonical transaction id computed over the body, not the
      // submitter's echoed hash — that is what the duplicate cache keys on.
      expect(settleResponse.transaction).toBe(
        decodeCardanoTransaction((paymentPayload.payload as { transaction: string }).transaction)
          .txHash,
      );
      expect(settleResponse.extra).toMatchObject({
        status: "confirmed",
        submissionMode: "server",
        confirmations: 1,
      });
    });

    it("verifies and settles a native USDM payment end to end", async () => {
      // 0.5 USDM: a default-spend-controls client must recognise USDM as the
      // network's default asset and accept it under the $1 cap.
      const guardedClient = x402Client.fromConfig({
        schemes: [{ network: NETWORK, client: new ExactCardanoClient(stubClientSigner()) }],
      });
      const accepts = [buildRequirements(recipient, "500000", USDM_PREPROD_ASSET)];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      });

      const paymentPayload = await guardedClient.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
    });

    it("refuses lovelace under default spend controls (not a USD-pegged default asset)", async () => {
      const guardedClient = x402Client.fromConfig({
        schemes: [{ network: NETWORK, client: new ExactCardanoClient(stubClientSigner()) }],
      });
      const accepts = [buildRequirements(recipient, "2000000", LOVELACE_ASSET)];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      });

      await expect(guardedClient.createPaymentPayload(paymentRequired)).rejects.toThrow(
        /spendControls/,
      );
    });

    it("verifies and settles a script payment (no datum) end to end", async () => {
      const { address: scriptAddr } = scriptAddressFor(MINIMAL_PLUTUS_V3);
      const accepts = [
        buildRequirements(scriptAddr, "2000000", LOVELACE_ASSET, {
          assetTransferMethod: "script",
          script: { type: "plutusV3", code: MINIMAL_PLUTUS_V3 },
        }),
      ];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      });

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
    });

    it("verifies and settles a script payment carrying an inline datum end to end", async () => {
      const { address: scriptAddr } = scriptAddressFor(MINIMAL_PLUTUS_V3);
      // A server-defined contract datum the client must attach verbatim.
      const datumHex = Data.toCBORHex(Data.constr(0n, [Data.int(42n)]));
      const accepts = [
        buildRequirements(scriptAddr, "2000000", LOVELACE_ASSET, {
          assetTransferMethod: "script",
          script: { type: "plutusV3", code: MINIMAL_PLUTUS_V3 },
          datum: datumHex,
        }),
      ];
      const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
        url: "https://company.co",
        description: "Company Co. resource",
        mimeType: "application/json",
      });

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const accepted = server.findMatchingRequirements(accepts, paymentPayload);
      expect(accepted).toBeDefined();

      const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await server.settlePayment(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);

      // The client attached the server-declared datum to the script output.
      const decoded = decodeCardanoTransaction(
        (paymentPayload.payload as { transaction: string }).transaction,
      );
      const scriptOutput = decoded.outputs.find(o => o.address === scriptAddr);
      expect(scriptOutput?.datum).toBe(datumHex);
    });

    it("verifies and settles a masumi escrow lock end to end", async () => {
      const { requirements } = await issueMasumiRequirements({
        network: NETWORK,
        asset: LOVELACE_ASSET,
        amount: "50000000",
        payByTimeMs: BigInt(slotToPosixMs(NETWORK, TTL_SLOT)),
      });
      const paymentRequired = await server.createPaymentRequiredResponse([requirements], {
        url: "https://agent.example.com/weather",
        description: "Agent job",
        mimeType: "application/json",
      });

      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const payloadFields = paymentPayload.payload as {
        submissionMode: string;
        settlementLayer: string;
        transaction: string;
      };
      expect(payloadFields.submissionMode).toBe("server");
      expect(payloadFields.settlementLayer).toBe("l1");

      const accepted = server.findMatchingRequirements([requirements], paymentPayload);
      expect(accepted).toBeDefined();

      // The escrow output carries the exact lock value and an inline datum.
      const decoded = decodeCardanoTransaction(payloadFields.transaction);
      const escrowOutputs = decoded.outputs.filter(o => o.address === requirements.payTo);
      expect(escrowOutputs).toHaveLength(1);
      expect(escrowOutputs[0].datum).toBeDefined();
      expect(escrowOutputs[0].coin).toBe(50_000_000n);

      // The datum's buyer must control the nonce input, so the facilitator has
      // to resolve that UTXO's real owner.
      const buyer = await stubBuyerAddress();
      expect(buyer).toBeTruthy();
      const buyerOwned = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const verifyResponse = await buyerOwned.verify(paymentPayload, accepted!);
      expect(verifyResponse.isValid).toBe(true);

      const settleResponse = await buyerOwned.settle(paymentPayload, accepted!);
      expect(settleResponse.success).toBe(true);
      expect(settleResponse.extra).toMatchObject({
        status: "confirmed",
        submissionMode: "server",
        settlementLayer: "l1",
      });
    });

    it("refuses a second, different transaction for the same Masumi terms", async () => {
      const { requirements } = await issueMasumiRequirements({
        network: NETWORK,
        asset: LOVELACE_ASSET,
        amount: "50000000",
        payByTimeMs: BigInt(slotToPosixMs(NETWORK, TTL_SLOT)),
      });
      const paymentRequired = await server.createPaymentRequiredResponse([requirements], {
        url: "https://agent.example.com/weather",
        description: "Agent job",
        mimeType: "application/json",
      });

      // Two independently built locks for the same 402: both are individually
      // valid and have different transaction ids, so only the termsDigest
      // binding stops the duplicate deposit.
      const first = await client.createPaymentPayload(paymentRequired);
      const otherLock = await buildStubMasumiLockTx(
        requirements.extra!,
        NETWORK,
        requirements.payTo,
        LOVELACE_ASSET,
        50_000_000n,
        `${"b".repeat(64)}#0`,
      );
      const second: PaymentPayload = {
        x402Version: 2,
        accepted: requirements,
        payload: { ...otherLock, submissionMode: "server", settlementLayer: "l1" },
      };
      const firstTx = decodeCardanoTransaction(
        (first.payload as { transaction: string }).transaction,
      ).txHash;
      const secondTx = decodeCardanoTransaction(otherLock.transaction).txHash;
      expect(firstTx).not.toBe(secondTx);

      const buyer = await stubBuyerAddress();
      expect(buyer).toBeTruthy();
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      expect((await facilitator.settle(first, requirements)).success).toBe(true);

      const duplicate = await facilitator.settle(second, requirements);
      expect(duplicate.success).toBe(false);
      expect(duplicate.errorReason).toBe("duplicate_settlement");
    });
  });

  describe("facilitator verify() rules against real signed transactions", () => {
    /**
     * Builds an x402 payload from a freshly built fixture transaction.
     *
     * @param payTo - The address the transaction output pays.
     * @param amount - The lovelace amount the output carries.
     * @param requirements - The requirements to verify the payload against.
     * @returns The payload and requirements pair.
     */
    async function fixturePayload(
      payTo: string,
      amount: bigint,
      datum?: ReturnType<typeof inlineDatum>,
    ): Promise<{ payload: PaymentPayload; nonceSnapshot: CardanoUtxoSnapshot }> {
      const built = await buildSignedTx({
        payTo,
        asset: LOVELACE_ASSET,
        amount,
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: NETWORK,
        ...(datum ? { datum } : {}),
      });
      return {
        payload: {
          x402Version: 2,
          accepted: buildRequirements(payTo, amount.toString()),
          payload: { transaction: built.transaction, nonce: built.nonce },
        },
        nonceSnapshot: built.nonceSnapshot,
      };
    }

    it("accepts a transaction that satisfies every rule", async () => {
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const { payload, nonceSnapshot } = await fixturePayload(recipient, 1_000_000n);
      const result = await facilitator.verify(payload, buildRequirements(recipient, "1000000"));
      expect(result.isValid).toBe(true);
      expect(result.payer).toBe(nonceSnapshot.address);
    });

    it("rejects when the output pays a different recipient (rule 3)", async () => {
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const other = await freshPreprodAddress();
      const { payload } = await fixturePayload(recipient, 1_000_000n);
      const result = await facilitator.verify(payload, buildRequirements(other, "1000000"));
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_recipient_mismatch");
    });

    it("rejects when the output amount is insufficient (rule 4)", async () => {
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const { payload } = await fixturePayload(recipient, 500_000n);
      const result = await facilitator.verify(payload, buildRequirements(recipient, "1000000"));
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_amount_insufficient");
    });

    it("rejects when the output is below the protocol min-UTXO", async () => {
      // An absurdly large coinsPerUtxoByte pushes the min-UTXO far above the
      // output's 1 ADA, exercising the min-UTXO comparison branch.
      const facilitator = new ExactCardanoFacilitator(
        stubFacilitatorSigner({ getCoinsPerUtxoByte: async () => 100_000n }),
      );
      const { payload } = await fixturePayload(recipient, 1_000_000n);
      const result = await facilitator.verify(payload, buildRequirements(recipient, "1000000"));
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_min_utxo_insufficient");
    });

    it("accepts an output that meets the protocol min-UTXO", async () => {
      const facilitator = new ExactCardanoFacilitator(
        stubFacilitatorSigner({ getCoinsPerUtxoByte: async () => 4310n }),
      );
      const { payload } = await fixturePayload(recipient, 2_000_000n);
      const result = await facilitator.verify(payload, buildRequirements(recipient, "2000000"));
      expect(result.isValid).toBe(true);
    });

    it("rejects when the nonce UTXO is already spent (rule 5)", async () => {
      const facilitator = new ExactCardanoFacilitator(
        stubFacilitatorSigner({ getUtxo: async () => ({ exists: false }) }),
      );
      const { payload } = await fixturePayload(recipient, 1_000_000n);
      const result = await facilitator.verify(payload, buildRequirements(recipient, "1000000"));
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_nonce_not_on_chain");
    });

    it("rejects when the transaction TTL has expired (rule 6)", async () => {
      const facilitator = new ExactCardanoFacilitator(
        stubFacilitatorSigner({ getCurrentSlot: async () => TTL_SLOT + 1n }),
      );
      const { payload } = await fixturePayload(recipient, 1_000_000n);
      const result = await facilitator.verify(payload, buildRequirements(recipient, "1000000"));
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_ttl_expired");
    });

    it("accepts a script payment to the reconstructed script address", async () => {
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const { address: scriptAddr } = scriptAddressFor(MINIMAL_PLUTUS_V3);
      const { payload } = await fixturePayload(scriptAddr, 2_000_000n);
      const requirements = buildRequirements(scriptAddr, "2000000", LOVELACE_ASSET, {
        assetTransferMethod: "script",
        script: { type: "plutusV3", code: MINIMAL_PLUTUS_V3 },
      });
      const result = await facilitator.verify(payload, requirements);
      expect(result.isValid).toBe(true);
    });

    it("accepts a script payment carrying an inline datum (datum not verified)", async () => {
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const { address: scriptAddr } = scriptAddressFor(MINIMAL_PLUTUS_V3);
      // A server-defined contract datum; the client attaches it verbatim.
      const datumHex = Data.toCBORHex(Data.constr(0n, [Data.int(42n)]));
      const datum = buildScriptDatumInline({
        assetTransferMethod: "script",
        script: { type: "plutusV3", code: MINIMAL_PLUTUS_V3 },
        datum: datumHex,
      });
      const { payload } = await fixturePayload(scriptAddr, 2_000_000n, datum);
      const requirements = buildRequirements(scriptAddr, "2000000", LOVELACE_ASSET, {
        assetTransferMethod: "script",
        script: { type: "plutusV3", code: MINIMAL_PLUTUS_V3 },
        datum: datumHex,
      });
      const result = await facilitator.verify(payload, requirements);
      expect(result.isValid).toBe(true);
      // The datum landed on the script output exactly as supplied.
      const decoded = decodeCardanoTransaction(
        (payload.payload as { transaction: string }).transaction,
      );
      const scriptOutput = decoded.outputs.find(o => o.address === scriptAddr);
      expect(scriptOutput?.datum).toBe(datumHex);
    });

    it("rejects a script payment whose payTo is not the declared script", async () => {
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const { payload } = await fixturePayload(recipient, 2_000_000n);
      const requirements = buildRequirements(recipient, "2000000", LOVELACE_ASSET, {
        assetTransferMethod: "script",
        script: { type: "plutusV3", code: MINIMAL_PLUTUS_V3 },
      });
      const result = await facilitator.verify(payload, requirements);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_script_address_mismatch");
    });

    it("rejects a masumi payment whose payTo is not the derived escrow address", async () => {
      const { requirements } = await issueMasumiRequirements({
        network: NETWORK,
        asset: LOVELACE_ASSET,
        amount: "5000000",
        payByTimeMs: BigInt(slotToPosixMs(NETWORK, TTL_SLOT)),
      });
      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const { payload } = await fixturePayload(recipient, 5_000_000n);
      const result = await facilitator.verify(payload, {
        ...requirements,
        payTo: recipient,
      });
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_requirements_masumi_deployment");
    });

    it("accepts a multi-input tx when every input is unspent, rejects when one is spent", async () => {
      const secondRef = `${"b".repeat(64)}#0`;
      // Small nonce funding + a second wallet UTXO forces coin selection to add
      // a second input, so the transaction has more than just the nonce input.
      const built = await buildSignedTx({
        payTo: recipient,
        asset: LOVELACE_ASSET,
        amount: 2_000_000n,
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: NETWORK,
        fundingLovelace: 1_000_000n,
        secondInput: { ref: secondRef, lovelace: 5_000_000n },
      });
      expect(decodeCardanoTransaction(built.transaction).inputs).toHaveLength(2);

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: buildRequirements(recipient, "2000000"),
        payload: { transaction: built.transaction, nonce: built.nonce },
      };
      const requirements = buildRequirements(recipient, "2000000");

      // All inputs unspent → valid.
      const ok = await new ExactCardanoFacilitator(stubFacilitatorSigner()).verify(
        payload,
        requirements,
      );
      expect(ok.isValid).toBe(true);

      // The coin-selected (non-nonce) input is already spent → rejected.
      const unspentSigner = stubFacilitatorSigner();
      const spent = await new ExactCardanoFacilitator(
        stubFacilitatorSigner({
          getUtxo: async (ref, network) => ({
            ...(await unspentSigner.getUtxo(ref, network)),
            exists: !ref.startsWith("bbbb"),
          }),
        }),
      ).verify(payload, requirements);
      expect(spent.isValid).toBe(false);
      expect(spent.invalidReason).toBe("invalid_exact_cardano_payload_input_not_available");
    });

    // A phase-2-invalid ("failed script") transaction lands under its own id but
    // consumes its collateral instead of its inputs and creates NONE of its
    // declared outputs. Decoding it shows a perfectly good payment output that
    // the ledger never produced, so accepting it hands over the resource for
    // free — the more so in client mode, where the client picks what to submit.
    it("rejects a phase-2-invalid transaction even though it decodes as paying", async () => {
      const built = await buildSignedTx({
        payTo: recipient,
        asset: LOVELACE_ASSET,
        amount: 2_000_000n,
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: NETWORK,
      });
      const original = Transaction.fromCBORBytes(
        Uint8Array.from(Buffer.from(built.transaction, "base64")),
      );
      const failed = new Transaction.Transaction({
        body: original.body,
        witnessSet: original.witnessSet,
        isValid: false,
        auxiliaryData: null,
      });
      const transaction = Buffer.from(Transaction.toCBORBytes(failed)).toString("base64");

      // It still decodes as a valid-looking payment to the right address.
      const decoded = decodeCardanoTransaction(transaction);
      expect(decoded.outputs.some(o => o.address === recipient && o.coin >= 2_000_000n)).toBe(true);
      expect(decoded.isValid).toBe(false);

      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: buildRequirements(recipient, "2000000"),
          payload: { transaction, nonce: NONCE_REF },
        },
        buildRequirements(recipient, "2000000"),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_phase2_invalid");
    });

    it("accepts a client-submitted payment carrying no Plutus redeemers", async () => {
      const built = await buildSignedTx({
        payTo: recipient,
        asset: LOVELACE_ASSET,
        amount: 2_000_000n,
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: NETWORK,
      });
      expect(decodeCardanoTransaction(built.transaction).redeemerCount).toBe(0);

      const clientReqs = buildRequirements(recipient, "2000000", LOVELACE_ASSET, {
        submissionPolicy: "client",
      });
      const facilitator = new ExactCardanoFacilitator(
        stubFacilitatorSigner({
          getTransactionEvidence: async () => ({ status: "confirmed", confirmations: 1 }),
        }),
      );
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: clientReqs,
          payload: { transaction: built.transaction, nonce: NONCE_REF, submissionMode: "client" },
        },
        clientReqs,
      );
      expect(result.isValid).toBe(true);
    });

    it("rejects a transaction whose vkey signature does not match the body", async () => {
      // Graft a second transaction's witness onto the first's body: the grafted
      // signature was produced over a different body hash, so it is invalid.
      const valid = await buildSignedTx({
        payTo: recipient,
        asset: LOVELACE_ASSET,
        amount: 1_000_000n,
        nonceUtxoRef: NONCE_REF,
        ttlSlot: TTL_SLOT,
        network: NETWORK,
      });
      const otherTx = await buildSignedTx({
        payTo: await freshPreprodAddress(),
        asset: LOVELACE_ASSET,
        amount: 1_500_000n,
        nonceUtxoRef: `${"c".repeat(64)}#0`,
        ttlSlot: TTL_SLOT,
        network: NETWORK,
      });
      const base64ToTx = (b64: string) =>
        Transaction.fromCBORBytes(Uint8Array.from(Buffer.from(b64, "base64")));
      const tampered = new Transaction.Transaction({
        body: base64ToTx(valid.transaction).body,
        witnessSet: base64ToTx(otherTx.transaction).witnessSet,
        isValid: true,
        auxiliaryData: null,
      });
      const tamperedTransaction = Buffer.from(Transaction.toCBORBytes(tampered)).toString("base64");

      const facilitator = new ExactCardanoFacilitator(stubFacilitatorSigner());
      const result = await facilitator.verify(
        {
          x402Version: 2,
          accepted: buildRequirements(recipient, "1000000"),
          payload: { transaction: tamperedTransaction, nonce: NONCE_REF },
        },
        buildRequirements(recipient, "1000000"),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_exact_cardano_payload_invalid_signature");
    });
  });

  describe("Price parsing", () => {
    let server: x402ResourceServer;
    let cardanoServer: ExactCardanoServer;

    beforeEach(async () => {
      const facilitator = new x402Facilitator().register(
        NETWORK,
        new ExactCardanoFacilitator(stubFacilitatorSigner()),
      );
      server = new x402ResourceServer(new CardanoFacilitatorClient(facilitator));
      cardanoServer = new ExactCardanoServer();
      server.register(NETWORK, cardanoServer);
      await server.initialize();
    });

    it("parses Money formats to USDM atomic units (6 decimals)", async () => {
      const cases = [
        { input: "$1.00", expected: "1000000" },
        { input: "1.50", expected: "1500000" },
        { input: 2.5, expected: "2500000" },
      ];
      for (const { input, expected } of cases) {
        const requirements = await server.buildPaymentRequirements({
          scheme: "exact",
          payTo: recipient,
          price: input,
          network: NETWORK,
        });
        expect(requirements).toHaveLength(1);
        expect(requirements[0].amount).toBe(expected);
        expect(requirements[0].asset).toBe(USDM_PREPROD_ASSET);
      }
    });

    it("passes AssetAmount through unchanged", async () => {
      const requirements = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: recipient,
        price: { amount: "12345", asset: USDM_PREPROD_ASSET, extra: { tier: "premium" } },
        network: NETWORK,
      });
      expect(requirements[0].amount).toBe("12345");
      expect(requirements[0].extra?.tier).toBe("premium");
    });

    it("honors a registered custom MoneyParser", async () => {
      cardanoServer.registerMoneyParser(async amount =>
        amount > 100
          ? { amount: (amount * 1e6).toString(), asset: USDM_PREPROD_ASSET, extra: { tier: "vip" } }
          : null,
      );
      const big = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: recipient,
        price: 150,
        network: NETWORK,
      });
      expect(big[0].extra?.tier).toBe("vip");
      const small = await server.buildPaymentRequirements({
        scheme: "exact",
        payTo: recipient,
        price: 50,
        network: NETWORK,
      });
      expect(small[0].extra?.tier).toBeUndefined();
      expect(small[0].amount).toBe("50000000");
    });
  });
});

// Live preprod settlement. Skipped unless a funded client wallet, a Blockfrost
// project id and a payee address are provided. Mirrors the env-gated style of
// the other mechanisms but skips cleanly so CI without secrets stays green.
//
// The facilitator needs no funds — it only broadcasts the client's already
// signed transaction — so FACILITATOR_CARDANO_MNEMONIC is optional.
const LIVE_ENV = {
  clientMnemonic: process.env.CLIENT_CARDANO_MNEMONIC,
  blockfrostBaseUrl: process.env.BLOCKFROST_PREPROD_URL,
  blockfrostProjectId: process.env.BLOCKFROST_PROJECT_ID,
  payTo: process.env.RESOURCE_SERVER_CARDANO_ADDRESS || process.env.SERVER_CARDANO_ADDRESS,
};
const LIVE_READY = Object.values(LIVE_ENV).every(Boolean);
/** Optional; only exposes an address in `/supported`. */
const LIVE_FACILITATOR_MNEMONIC = process.env.FACILITATOR_CARDANO_MNEMONIC;

describe.skipIf(!LIVE_READY)("Cardano Integration Tests (live preprod)", () => {
  const provider = {
    blockfrost: {
      baseUrl: LIVE_ENV.blockfrostBaseUrl!,
      projectId: LIVE_ENV.blockfrostProjectId!,
    },
  };

  /**
   * Wires a live client / facilitator / resource-server triple against preprod.
   *
   * @returns The client and the resource server.
   */
  async function liveStack(): Promise<{ client: x402Client; server: x402ResourceServer }> {
    const clientSigner = toClientCardanoSigner({
      mnemonic: LIVE_ENV.clientMnemonic!,
      network: NETWORK,
      provider,
    });
    const facilitatorSigner = toFacilitatorCardanoSigner({
      ...(LIVE_FACILITATOR_MNEMONIC ? { mnemonic: LIVE_FACILITATOR_MNEMONIC } : {}),
      network: NETWORK,
      provider,
      awaitConfirmation: true,
    });

    const client = x402Client.fromConfig({
      schemes: [{ network: NETWORK, client: new ExactCardanoClient(clientSigner) }],
      spendControls: false,
    });
    const facilitator = new x402Facilitator().register(
      NETWORK,
      new ExactCardanoFacilitator(facilitatorSigner),
    );
    const server = new x402ResourceServer(new CardanoFacilitatorClient(facilitator));
    server.register(NETWORK, new ExactCardanoServer());
    await server.initialize();
    return { client, server };
  }

  /** The nonce UTXO the previous live payment consumed. */
  let lastSpentNonce: string | undefined;

  /**
   * Waits until the provider's address index no longer offers the UTXO the
   * previous payment consumed. `awaitTx` only proves block inclusion; the
   * address-UTXO index can still lag, and the reference signer always takes the
   * first wallet UTXO as its nonce — so without this a back-to-back payment
   * rebuilds on a spent input and the node rejects it.
   *
   * @param address - The funding wallet's bech32 address.
   * @returns Nothing.
   */
  async function waitForFreshUtxo(address: string): Promise<void> {
    if (!lastSpentNonce) return;
    const deadline = Date.now() + 120_000;
    for (;;) {
      const response = await fetch(`${provider.blockfrost.baseUrl}/addresses/${address}/utxos`, {
        headers: { project_id: provider.blockfrost.projectId },
      });
      if (response.ok) {
        const utxos = (await response.json()) as Array<{
          tx_hash: string;
          output_index: number;
        }>;
        const fresh = utxos.some(u => `${u.tx_hash}#${u.output_index}` !== lastSpentNonce);
        if (fresh) return;
      }
      if (Date.now() > deadline) {
        throw new Error(`wallet ${address} still only offers the spent ${lastSpentNonce}`);
      }
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
  }

  /**
   * Runs one payment all the way to settlement against preprod.
   *
   * @param requirements - The requirements to pay.
   * @returns The settle response.
   */
  async function payLive(requirements: PaymentRequirements): Promise<SettleResponse> {
    const { client, server } = await liveStack();
    await waitForFreshUtxo(
      toClientCardanoSigner({
        mnemonic: LIVE_ENV.clientMnemonic!,
        network: NETWORK,
        provider,
      }).getAddress(),
    );
    const accepts = [requirements];
    const paymentRequired = await server.createPaymentRequiredResponse(accepts, {
      url: "https://company.co",
      description: "Company Co. resource",
      mimeType: "application/json",
    });

    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const accepted = server.findMatchingRequirements(accepts, paymentPayload);
    expect(accepted).toBeDefined();

    const verifyResponse = await server.verifyPayment(paymentPayload, accepted!);
    expect(verifyResponse.isValid, `verify failed: ${verifyResponse.invalidReason}`).toBe(true);

    lastSpentNonce = (paymentPayload.payload as { nonce: string }).nonce;
    return server.settlePayment(paymentPayload, accepted!);
  }

  // Canonical block inclusion rather than the default one confirmation: a
  // preprod block is ~20s, and the reference facilitator signer already awaits
  // inclusion before reporting. The threshold itself is covered offline.
  const LIVE_CONFIRMATION_POLICY = { l1Confirmations: 0 };

  it("verifies and settles an address-to-address payment", async () => {
    const settleResponse = await payLive(
      buildRequirements(LIVE_ENV.payTo!, "1000000", LOVELACE_ASSET, {
        confirmationPolicy: LIVE_CONFIRMATION_POLICY,
      }),
    );
    expect(
      settleResponse.success,
      `${settleResponse.errorReason}: ${settleResponse.errorMessage ?? ""}`,
    ).toBe(true);
    expect(settleResponse.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(settleResponse.extra).toMatchObject({ status: "confirmed", submissionMode: "server" });
  }, 300_000);

  it("verifies and settles a script lock carrying an inline datum", async () => {
    const { address: scriptAddr } = scriptAddressFor(MINIMAL_PLUTUS_V3);
    const settleResponse = await payLive(
      buildRequirements(scriptAddr, "2000000", LOVELACE_ASSET, {
        assetTransferMethod: "script",
        script: { type: "plutusV3", code: MINIMAL_PLUTUS_V3 },
        datum: Data.toCBORHex(Data.constr(0n, [Data.int(42n)])),
        confirmationPolicy: LIVE_CONFIRMATION_POLICY,
      }),
    );
    expect(
      settleResponse.success,
      `${settleResponse.errorReason}: ${settleResponse.errorMessage ?? ""}`,
    ).toBe(true);
    expect(settleResponse.transaction).toMatch(/^[0-9a-f]{64}$/);
  }, 300_000);

  it("verifies and settles a Masumi escrow lock", async () => {
    // A conformant issuer signs the terms; pay_by_time stays inside
    // maxTimeoutSeconds so the anchored TTL clears rule 7's upper bound.
    const maxTimeoutSeconds = 600;
    const { requirements } = await issueMasumiRequirements({
      network: NETWORK,
      asset: LOVELACE_ASSET,
      amount: "5000000",
      maxTimeoutSeconds,
      payByTimeMs: BigInt(Date.now() + maxTimeoutSeconds * 1000),
      confirmationPolicy: LIVE_CONFIRMATION_POLICY,
    });

    const settleResponse = await payLive(requirements);
    expect(
      settleResponse.success,
      `${settleResponse.errorReason}: ${settleResponse.errorMessage ?? ""}`,
    ).toBe(true);
    expect(settleResponse.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(settleResponse.extra).toMatchObject({
      status: "confirmed",
      submissionMode: "server",
      settlementLayer: "l1",
    });
  }, 300_000);
});
