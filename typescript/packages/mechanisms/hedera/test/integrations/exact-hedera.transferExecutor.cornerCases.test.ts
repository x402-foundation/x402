/**
 * Env-gated live corner cases of `transferExecutor` on Hedera testnet.
 *
 * Every case runs the real facilitator against the real Mirror Node and consensus nodes, with
 * a MockTransferExecutor whose `authorization` selects the behaviour (see
 * `mock-executor/README.md`). It covers what the unit tests, which fake the signer and the
 * mirror node, cannot: the simulation channel, real consensus records with child records and
 * logs, and the on-chain effect of a consumed authorization.
 *
 * Skipped, with no network access, unless these are set in the shell or `.env.local`:
 * `HEDERA_FACILITATOR_ACCOUNT_ID`, `HEDERA_FACILITATOR_PRIVATE_KEY`,
 * `HEDERA_RESOURCE_SERVER_ACCOUNT_ID` and `HEDERA_TE_MOCK_EXECUTOR_ID`.
 *
 * The settle cases spend testnet HBAR: the fee of each submitted call, and a few thousand
 * tinybars of the mock's balance.
 */
import { describe, expect, it } from "vitest";
import {
  createFacilitator,
  createPayment,
  DEFAULT_AMOUNT,
  MockMode,
  NETWORK,
  readLiveEnv,
} from "./mock-executor/harness";

/**
 * A live settlement waits for consensus and mirror node ingestion.
 */
const TIMEOUT_MS = 120_000;

const env = readLiveEnv();

describe.skipIf(!env)("Hedera transferExecutor live corner cases (MockTransferExecutor)", () => {
  describe("verify", () => {
    it(
      "accepts a valid authorization",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.OK });

        const verified = await facilitator.verify(payload, requirements);

        expect(verified, JSON.stringify(verified)).toMatchObject({ isValid: true });
      },
      TIMEOUT_MS,
    );

    it(
      "rejects an executor the facilitator does not admit",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, {
          mode: MockMode.OK,
          payloadExecutor: "0.0.7000",
        });

        const verified = await facilitator.verify(payload, requirements);

        expect(verified).toMatchObject({
          isValid: false,
          invalidReason: "invalid_exact_hedera_executor_not_admitted",
        });
      },
      TIMEOUT_MS,
    );

    it(
      "rejects an authorization the executor reverts on",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.REVERT });

        const verified = await facilitator.verify(payload, requirements);

        expect(verified).toMatchObject({
          isValid: false,
          invalidReason: "simulation_reverted",
          invalidMessage: expect.stringContaining("forced revert"),
        });
      },
      TIMEOUT_MS,
    );

    it(
      "rejects an authorization bound to a different amount",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, {
          mode: MockMode.OK,
          boundAmount: DEFAULT_AMOUNT + 1n,
        });

        const verified = await facilitator.verify(payload, requirements);

        expect(verified).toMatchObject({
          isValid: false,
          invalidReason: "simulation_reverted",
          invalidMessage: expect.stringContaining("does not match transfer"),
        });
      },
      TIMEOUT_MS,
    );

    it(
      "rejects an expired authorization",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, {
          mode: MockMode.OK,
          validBefore: BigInt(Math.floor(Date.now() / 1000) - 60),
        });

        const verified = await facilitator.verify(payload, requirements);

        expect(verified).toMatchObject({
          isValid: false,
          invalidReason: "simulation_reverted",
          invalidMessage: expect.stringContaining("authorization expired"),
        });
      },
      TIMEOUT_MS,
    );

    it(
      "rejects an executor that spends all its gas, within the facilitator's gas limit",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.BURN_GAS });

        const verified = await facilitator.verify(payload, requirements);

        expect(verified).toMatchObject({ isValid: false, invalidReason: "simulation_reverted" });
      },
      TIMEOUT_MS,
    );

    it(
      "rejects a call whose estimated gas is above the configured ceiling",
      async () => {
        const facilitator = createFacilitator(env!, { simulationGasCeiling: 30_000 });
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.OK });

        const verified = await facilitator.verify(payload, requirements);

        expect(verified).toMatchObject({
          isValid: false,
          invalidReason: "simulation_gas_exceeded",
        });
      },
      TIMEOUT_MS,
    );
  });

  describe("settle", () => {
    it(
      "settles a valid authorization, once",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.OK });

        const settled = await facilitator.settle(payload, requirements);
        console.log(`settled: https://hashscan.io/testnet/transaction/${settled.transaction}`);

        expect(settled, JSON.stringify(settled)).toMatchObject({
          success: true,
          network: NETWORK,
          payer: env!.executor,
        });
        expect(settled.transaction.length).toBeGreaterThan(0);

        // A consumed authorization can no longer simulate, so a replay is rejected on chain
        // state alone, with nothing remembered by the facilitator.
        const replayVerify = await facilitator.verify(payload, requirements);
        expect(replayVerify).toMatchObject({
          isValid: false,
          invalidReason: "simulation_reverted",
          invalidMessage: expect.stringContaining("authorization consumed"),
        });

        const replaySettle = await facilitator.settle(payload, requirements);
        expect(replaySettle).toMatchObject({ success: false, errorReason: "simulation_reverted" });
      },
      TIMEOUT_MS,
    );

    it(
      "submits one call for two concurrent identical settles",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.OK });

        const [first, second] = await Promise.all([
          facilitator.settle(payload, requirements),
          facilitator.settle(payload, requirements),
        ]);

        const outcomes = [first, second];
        expect(outcomes.filter(outcome => outcome.success)).toHaveLength(1);
        expect(outcomes.find(outcome => !outcome.success)).toMatchObject({
          errorReason: "invalid_payload",
        });
      },
      TIMEOUT_MS,
    );

    it(
      "fails a SUCCESS receipt whose record moves nothing",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.NOOP });

        const settled = await facilitator.settle(payload, requirements);

        expect(settled).toMatchObject({
          success: false,
          errorReason: "settlement_payee_credit_mismatch",
        });
        expect(settled.transaction.length).toBeGreaterThan(0);
      },
      TIMEOUT_MS,
    );

    it(
      "fails a payee credited more than the amount",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.OVERPAY });

        const settled = await facilitator.settle(payload, requirements);

        expect(settled).toMatchObject({
          success: false,
          errorReason: "settlement_payee_credit_mismatch",
        });
      },
      TIMEOUT_MS,
    );

    it(
      "fails a payee credited less than the amount",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, { mode: MockMode.UNDERPAY });

        const settled = await facilitator.settle(payload, requirements);

        expect(settled).toMatchObject({
          success: false,
          errorReason: "settlement_payee_credit_mismatch",
        });
      },
      TIMEOUT_MS,
    );

    it(
      "fails a payer debited beyond the amount by an extra credit",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, {
          mode: MockMode.EXTRA_CREDIT,
        });

        const settled = await facilitator.settle(payload, requirements);

        expect(settled).toMatchObject({
          success: false,
          errorReason: "settlement_payer_debit_mismatch",
        });
      },
      TIMEOUT_MS,
    );

    it(
      "fails a log recording a transfer out of the facilitator's account",
      async () => {
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, {
          mode: MockMode.LOG_CALLER_TRANSFER,
        });

        const settled = await facilitator.settle(payload, requirements);

        expect(settled).toMatchObject({
          success: false,
          errorReason: "settlement_unexpected_transfer",
        });
      },
      TIMEOUT_MS,
    );

    it(
      "cannot tell that an executor that never consumes its authorization is replayable",
      async () => {
        // Documents a limit of the model: the facilitator verifies what one call did, not that
        // the executor honours single use. Admission is the control for this.
        const facilitator = createFacilitator(env!);
        const { payload, requirements } = await createPayment(env!, {
          mode: MockMode.OK_NO_CONSUME,
        });

        const first = await facilitator.settle(payload, requirements);
        expect(first, JSON.stringify(first)).toMatchObject({ success: true });

        const replayVerify = await facilitator.verify(payload, requirements);
        expect(replayVerify).toMatchObject({ isValid: true });
        const second = await facilitator.settle(payload, requirements);
        expect(second, JSON.stringify(second)).toMatchObject({ success: true });
        expect(second.transaction).not.toBe(first.transaction);
      },
      TIMEOUT_MS,
    );
  });
});
