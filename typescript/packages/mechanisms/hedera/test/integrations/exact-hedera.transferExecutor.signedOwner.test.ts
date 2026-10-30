/**
 * Env-gated live tests of `transferExecutor` against SignedOwnerExecutor on Hedera testnet.
 *
 * The behavioural MockTransferExecutor cannot show these, because it checks no signature and
 * spends its own balance:
 * - an owner signature validated on chain through HAS `isAuthorized`, which only the
 *   facilitator's simulation (the Mirror Node `contracts/call`) stands between and a
 *   wrongly accepted or wrongly rejected payment;
 * - funds that move through a HIP-336 allowance, so a real consensus record shows a payer other
 *   than the executor, debited by an approved transfer;
 * - a key rotation, after which a signature made with the old key must stop working although
 *   the account's EVM alias still names it.
 *
 * Each test creates its own owner account (so no key is stored) and the facilitator pays for it.
 * Skipped unless `HEDERA_TE_SIGNED_EXECUTOR_ID` and the variables named in
 * `exact-hedera.transferExecutor.cornerCases.test.ts` are set.
 */
import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import {
  createFacilitator,
  createOwner,
  createSignedPayment,
  readSignedEnv,
  rotateOwnerKey,
} from "./mock-executor/harness";

/**
 * Account creation, an allowance and a settlement each wait for consensus.
 */
const TIMEOUT_MS = 180_000;
/**
 * `isAuthorized` costs about one ecrecover per key; the default 400k is tight for it.
 */
const GAS_LIMIT = 1_000_000;

const NOT_AUTHORIZED = "not authorized by the account's current key";

const env = readSignedEnv();

describe.skipIf(!env)("Hedera transferExecutor live signed-owner executor", () => {
  const facilitator = () =>
    createFacilitator(env!, { executors: [env!.signedExecutor], gasLimit: GAS_LIMIT });

  it(
    "settles a payment the owner signed, from the owner's allowance, and rejects its replay",
    async () => {
      const owner = await createOwner(env!);
      const { payload, requirements } = await createSignedPayment(env!, owner);
      const scheme = facilitator();

      const verified = await scheme.verify(payload, requirements);
      expect(verified, JSON.stringify(verified)).toMatchObject({
        isValid: true,
        payer: owner.accountId,
      });

      const settled = await scheme.settle(payload, requirements);
      console.log(`settled: https://hashscan.io/testnet/transaction/${settled.transaction}`);
      expect(settled, JSON.stringify(settled)).toMatchObject({
        success: true,
        payer: owner.accountId,
      });

      const replay = await scheme.verify(payload, requirements);
      expect(replay).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        invalidMessage: expect.stringContaining("authorization consumed"),
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a signature made by a key that is not the owner's",
    async () => {
      const owner = await createOwner(env!);
      const { payload, requirements } = await createSignedPayment(env!, owner, {
        signer: PrivateKey.generateECDSA(),
      });

      const verified = await facilitator().verify(payload, requirements);

      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        invalidMessage: expect.stringContaining(NOT_AUTHORIZED),
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a signature over a different amount",
    async () => {
      const owner = await createOwner(env!);
      const { payload, requirements } = await createSignedPayment(env!, owner, {
        signedAmount: 1n,
      });

      const verified = await facilitator().verify(payload, requirements);

      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        invalidMessage: expect.stringContaining(NOT_AUTHORIZED),
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects an expired authorization",
    async () => {
      const owner = await createOwner(env!);
      const { payload, requirements } = await createSignedPayment(env!, owner, {
        validBefore: BigInt(Math.floor(Date.now() / 1000) - 60),
      });

      const verified = await facilitator().verify(payload, requirements);

      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        invalidMessage: expect.stringContaining("authorization expired"),
      });
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a valid signature when the owner granted no allowance",
    async () => {
      const owner = await createOwner(env!, { allowance: 0 });
      const { payload, requirements } = await createSignedPayment(env!, owner);

      const verified = await facilitator().verify(payload, requirements);

      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        invalidMessage: expect.stringContaining("allowance transfer failed"),
      });
    },
    TIMEOUT_MS,
  );

  it(
    "follows a key rotation: the old key stops working and the new key works",
    async () => {
      const original = await createOwner(env!);
      const oldKey = original.key;
      const rotated = await rotateOwnerKey(env!, original);
      const scheme = facilitator();

      // The alias still names the old key, which is what a naive ecrecover check would accept.
      const withOldKey = await createSignedPayment(env!, rotated, { signer: oldKey });
      const rejected = await scheme.verify(withOldKey.payload, withOldKey.requirements);
      expect(rejected).toMatchObject({
        isValid: false,
        invalidReason: "simulation_reverted",
        invalidMessage: expect.stringContaining(NOT_AUTHORIZED),
      });

      const withNewKey = await createSignedPayment(env!, rotated);
      const accepted = await scheme.verify(withNewKey.payload, withNewKey.requirements);
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ isValid: true });
      const settled = await scheme.settle(withNewKey.payload, withNewKey.requirements);
      expect(settled, JSON.stringify(settled)).toMatchObject({
        success: true,
        payer: rotated.accountId,
      });
    },
    TIMEOUT_MS * 2,
  );
});
