/**
 * Env-gated live tests of `transferExecutor` paying an HTS fungible token on Hedera testnet.
 *
 * The other live suites pay HBAR. A token payment differs where it matters to the facilitator:
 * the asset is an HTS token, whose custom fees it must read from the Mirror Node, and the
 * settlement judges the token transfer lists of the consensus record, not the HBAR ones.
 *
 * Each run creates its own token (and a payee that accepts it), funds the MockTransferExecutor
 * with it and the facilitator pays for all of it. Skipped unless the variables named in
 * `exact-hedera.transferExecutor.cornerCases.test.ts` are set.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  createFacilitator,
  createPayment,
  createTokenFixture,
  MockMode,
  readLiveEnv,
  type TokenFixture,
} from "./mock-executor/harness";

/**
 * Token creation, association and a settlement each wait for consensus.
 */
const TIMEOUT_MS = 180_000;

const env = readLiveEnv();

describe.skipIf(!env)("Hedera transferExecutor live HTS token payments", () => {
  let token: TokenFixture;
  let feeToken: TokenFixture;

  beforeAll(async () => {
    token = await createTokenFixture(env!);
    feeToken = await createTokenFixture(env!, { customFee: true });
  }, TIMEOUT_MS);

  it(
    "settles a token payment once and rejects its replay",
    async () => {
      const facilitator = createFacilitator(env!);
      const { payload, requirements } = await createPayment(env!, {
        mode: MockMode.OK,
        asset: token.tokenId,
        payTo: token.payTo,
      });

      const verified = await facilitator.verify(payload, requirements);
      expect(verified, JSON.stringify(verified)).toMatchObject({ isValid: true });

      const settled = await facilitator.settle(payload, requirements);
      console.log(`settled: https://hashscan.io/testnet/transaction/${settled.transaction}`);
      expect(settled, JSON.stringify(settled)).toMatchObject({ success: true });

      const replay = await facilitator.verify(payload, requirements);
      expect(replay).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        invalidMessage: expect.stringContaining("authorization consumed"),
      });
    },
    TIMEOUT_MS,
  );

  it(
    "fails a token payee credited less than the amount",
    async () => {
      const facilitator = createFacilitator(env!);
      const { payload, requirements } = await createPayment(env!, {
        mode: MockMode.UNDERPAY,
        asset: token.tokenId,
        payTo: token.payTo,
      });

      const settled = await facilitator.settle(payload, requirements);

      expect(settled).toMatchObject({
        success: false,
        errorReason: "settlement_payee_credit_mismatch",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "fails a token payee credited more than the amount",
    async () => {
      const facilitator = createFacilitator(env!);
      const { payload, requirements } = await createPayment(env!, {
        mode: MockMode.OVERPAY,
        asset: token.tokenId,
        payTo: token.payTo,
      });

      const settled = await facilitator.settle(payload, requirements);

      expect(settled).toMatchObject({
        success: false,
        errorReason: "settlement_payee_credit_mismatch",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a token with a custom fee",
    async () => {
      const facilitator = createFacilitator(env!);
      const { payload, requirements } = await createPayment(env!, {
        mode: MockMode.OK,
        asset: feeToken.tokenId,
        payTo: feeToken.payTo,
      });

      const verified = await facilitator.verify(payload, requirements);

      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_hedera_custom_fee_asset",
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects an asset that is not a fungible token",
    async () => {
      const facilitator = createFacilitator(env!);
      // An account id, so the Mirror Node has no token under it.
      const { payload, requirements } = await createPayment(env!, {
        mode: MockMode.OK,
        asset: env!.payTo,
        payTo: token.payTo,
      });

      const verified = await facilitator.verify(payload, requirements);

      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "invalid_payment_requirements",
        invalidMessage: expect.stringContaining("is not a fungible token"),
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a token payment of more than the payer holds",
    async () => {
      const facilitator = createFacilitator(env!);
      const { payload, requirements } = await createPayment(env!, {
        mode: MockMode.OK,
        asset: token.tokenId,
        payTo: token.payTo,
        amount: 10_000_000n, // more than the mock holds
      });

      const verified = await facilitator.verify(payload, requirements);

      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        // The HTS facade reverts without a reason, so the Mirror Node reports only the status.
        invalidMessage: "CONTRACT_REVERT_EXECUTED",
      });
    },
    TIMEOUT_MS,
  );
});
