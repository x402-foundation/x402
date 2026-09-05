import { Address, Client, Data, PrivateKey, preprod } from "@evolution-sdk/evolution";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import { CARDANO_PREPROD_CAIP2, LOVELACE_ASSET, USDM_PREPROD_ASSET } from "../../src/constants";
import { MASUMI_DEFAULT_DEPLOYMENT, masumiEscrowAddress } from "../../src/exact/masumi/blueprint";
import { buildMasumiLockDatum, inlineDatum } from "../../src/exact/masumi/datum";
import { buildMasumiLock, type MasumiLock } from "../../src/exact/masumi/lock";
import {
  verifyMasumiLock,
  type MasumiDeploymentValidator,
  type MasumiRegistryValidator,
} from "../../src/exact/masumi/verify";
import type { CardanoExtraMasumi, ExactCardanoPayload } from "../../src/types";
import { decodeCardanoTransaction, slotToPosixMs } from "../../src/utils";
import { buildSignedTx } from "../helpers/buildSignedTx";
import {
  freshKeyAddress,
  issueMasumiRequirements,
  type IssueMasumiOptions,
} from "../helpers/masumi";
import { NONCE_REF, STUB_COINS_PER_UTXO_BYTE, TTL_SLOT } from "../helpers/stubs";

const NETWORK = CARDANO_PREPROD_CAIP2;
/** `pay_by_time` must be on/after the fixture TTL's wall-clock time. */
const PAY_BY_TIME = BigInt(slotToPosixMs(NETWORK, TTL_SLOT));

/** A built Masumi payment: requirements, decoded transaction and payload. */
interface Fixture {
  requirements: PaymentRequirements;
  extra: CardanoExtraMasumi;
  decoded: ReturnType<typeof decodeCardanoTransaction>;
  payload: ExactCardanoPayload;
  buyer: string;
}

type FixtureOptions = Partial<IssueMasumiOptions> & {
  mutateLock?: (extra: CardanoExtraMasumi, buyer: string) => MasumiLock;
};

/**
 * Issues a Masumi 402 and builds the matching signed lock transaction.
 *
 * @param options - Overrides forwarded to the issuer, plus an optional lock override.
 * @returns The complete fixture.
 */
async function buildFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const asset = options.asset ?? LOVELACE_ASSET;
  const amount = options.amount ?? "50000000";
  const { requirements, extra } = await issueMasumiRequirements({
    payByTimeMs: PAY_BY_TIME,
    ...options,
    network: NETWORK,
    asset,
    amount,
  });

  const mnemonic = PrivateKey.generateMnemonic();
  const buyer = Address.toBech32(await Client.make(preprod).withSeed({ mnemonic }).address());
  const lock =
    options.mutateLock?.(extra, buyer) ??
    buildMasumiLock(extra, buyer, asset, BigInt(amount), STUB_COINS_PER_UTXO_BYTE);

  const built = await buildSignedTx({
    payTo: requirements.payTo,
    asset,
    amount: BigInt(amount),
    nonceUtxoRef: NONCE_REF,
    ttlSlot: TTL_SLOT,
    network: NETWORK,
    datum: lock.datum,
    outputLovelace: lock.lockedLovelace,
    mnemonic,
    fundingLovelace: lock.lockedLovelace + 10_000_000n,
  });

  return {
    requirements,
    extra,
    decoded: decodeCardanoTransaction(built.transaction),
    payload: { transaction: built.transaction, nonce: built.nonce, settlementLayer: "l1" },
    buyer,
  };
}

/**
 * Runs the Masumi lock check against a fixture.
 *
 * @param fixture - The fixture under test.
 * @param overrides - Optional replacements for `extra`, requirements or payload.
 * @returns The check result.
 */
function check(
  fixture: Fixture,
  overrides: {
    extra?: unknown;
    requirements?: PaymentRequirements;
    payload?: ExactCardanoPayload;
    validateRegistryClaim?: MasumiRegistryValidator;
    validateCustomDeployment?: MasumiDeploymentValidator;
  } = {},
) {
  const requirements = overrides.requirements ?? fixture.requirements;
  return verifyMasumiLock(overrides.extra ?? requirements.extra, requirements, fixture.decoded, {
    payload: overrides.payload ?? fixture.payload,
    payer: fixture.buyer,
    resource: { url: "https://agent.example.com/weather" },
    coinsPerUtxoByte: STUB_COINS_PER_UTXO_BYTE,
    ...(overrides.validateRegistryClaim
      ? { validateRegistryClaim: overrides.validateRegistryClaim }
      : {}),
    ...(overrides.validateCustomDeployment
      ? { validateCustomDeployment: overrides.validateCustomDeployment }
      : {}),
  });
}

/**
 * Rebuilds a lock datum from the signed terms with selected fields overridden,
 * so a fixture can violate exactly one invariant at a time.
 *
 * @param extra - The issued masumi extra.
 * @param buyer - The buyer address controlling the nonce input.
 * @param patch - Datum fields to override.
 * @param lockedLovelace - Optional exact escrow lovelace.
 * @returns The mutated lock.
 */
function lockWithDatum(
  extra: CardanoExtraMasumi,
  buyer: string,
  patch: Record<string, unknown> = {},
  lockedLovelace?: bigint,
): MasumiLock {
  const base = buildMasumiLock(extra, buyer, LOVELACE_ASSET, 50_000_000n, STUB_COINS_PER_UTXO_BYTE);
  const datum = buildMasumiLockDatum({
    buyerAddress: buyer,
    sellerAddress: extra.terms.sellerAddress,
    sellerReturnAddress: extra.terms.sellerReturnAddress,
    referenceKey: extra.referenceKey,
    referenceSignature: extra.referenceSignature,
    sellerNonce: extra.terms.sellerNonce,
    buyerNonce: extra.terms.buyerNonce,
    agentIdentifier:
      typeof extra.terms.agentIdentifier === "string" ? extra.terms.agentIdentifier : "",
    collateralReturnLovelace: base.collateralLovelace,
    inputHash: extra.terms.inputHash,
    payByTime: BigInt(extra.terms.payByTime),
    submitResultTime: BigInt(extra.terms.submitResultTime),
    unlockTime: BigInt(extra.terms.unlockTime),
    externalDisputeUnlockTime: BigInt(extra.terms.externalDisputeUnlockTime),
    ...patch,
  });
  return {
    datum: inlineDatum(datum),
    collateralLovelace: base.collateralLovelace,
    lockedLovelace: lockedLovelace ?? base.lockedLovelace,
  };
}

describe("masumi lock verification", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await buildFixture();
  }, 60_000);

  it("accepts a well-formed lovelace lock", async () => {
    expect(await check(fixture)).toEqual({ ok: true });
  });

  it("accepts a native-token lock whose lovelace is purely structural", async () => {
    const tokenFixture = await buildFixture({ asset: USDM_PREPROD_ASSET, amount: "1500000" });
    expect(await check(tokenFixture)).toEqual({ ok: true });
  });

  it("accepts a registered seller once an independent validator confirms the claim", async () => {
    const registered = await buildFixture({
      agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"01".repeat(8)}`,
    });
    expect(await check(registered, { validateRegistryClaim: () => true })).toEqual({ ok: true });
  });

  it("awaits registry validation and supplies protected-resource context", async () => {
    const registered = await buildFixture({
      agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"01".repeat(8)}`,
    });
    expect(
      await check(registered, {
        validateRegistryClaim: async claim =>
          claim.resource.url === "https://agent.example.com/weather",
      }),
    ).toEqual({ ok: true });
  });

  // The policy prefix proves nothing: anyone can copy a registered agent's
  // identifier into their own terms and sign with their own key.
  it("refuses a registry claim it cannot independently validate", async () => {
    const registered = await buildFixture({
      agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"01".repeat(8)}`,
    });
    expect(await check(registered)).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_requirements_masumi_agent_identifier",
    });
  });

  it("refuses a registry claim the validator rejects", async () => {
    const registered = await buildFixture({
      agentIdentifier: `67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b${"01".repeat(8)}`,
    });
    expect(await check(registered, { validateRegistryClaim: () => false })).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_requirements_masumi_agent_identifier",
    });
  });

  it("accepts a signed buyer nonce and a declared seller return address", async () => {
    const seller = freshKeyAddress(NETWORK);
    const withReturn = await buildFixture({
      buyerNonce: "0102030405060708090a0b0c0d",
      sellerReturnAddress: seller.address,
    });
    expect(await check(withReturn)).toEqual({ ok: true });
  });

  describe("closed-object schema", () => {
    /**
     * Asserts that an `extra` override is rejected by the wire schema.
     *
     * @param extra - The malformed extra.
     * @returns Nothing.
     */
    const expectSchemaRejection = async (extra: unknown): Promise<void> => {
      expect(await check(fixture, { extra })).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_schema",
      });
    };

    it("rejects an unknown field in extra", async () => {
      await expectSchemaRejection({
        ...fixture.extra,
        contractAddress: fixture.requirements.payTo,
      });
    });

    it("rejects a terms field that duplicates a projected top-level field", async () => {
      await expectSchemaRejection({
        ...fixture.extra,
        terms: { ...fixture.extra.terms, amount: "50000000" },
      });
    });

    it("rejects a paymentType other than Web3CardanoV2", async () => {
      await expectSchemaRejection({
        ...fixture.extra,
        terms: { ...fixture.extra.terms, paymentType: "Web3CardanoV1" },
      });
    });

    it("rejects a JSON null sellerReturnAddress", async () => {
      await expectSchemaRejection({
        ...fixture.extra,
        terms: { ...fixture.extra.terms, sellerReturnAddress: null },
      });
    });

    it("rejects a buyerNonce outside 14-26 hex characters", async () => {
      await expectSchemaRejection({
        ...fixture.extra,
        terms: { ...fixture.extra.terms, buyerNonce: "0102" },
      });
    });

    it("rejects a confirmationPolicy outside -1..20", async () => {
      await expectSchemaRejection({
        ...fixture.extra,
        confirmationPolicy: { l1Confirmations: 21 },
      });
    });

    it("rejects an inputHash that is not the commitment digest", async () => {
      await expectSchemaRejection({
        ...fixture.extra,
        terms: { ...fixture.extra.terms, inputHash: "0".repeat(64) },
      });
    });
  });

  describe("commitment and seller authorization", () => {
    it("rejects a tampered part digest", async () => {
      const parts = fixture.extra.inputCommitment.parts.map(part => ({
        ...part,
        digest: "0".repeat(64),
      }));
      expect(
        await check(fixture, {
          extra: {
            ...fixture.extra,
            inputCommitment: { ...fixture.extra.inputCommitment, parts },
          },
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_commitment",
      });
    });

    it("rejects content that does not hash to its declared digest", async () => {
      const parts = fixture.extra.inputCommitment.parts.map(part => ({
        ...part,
        content: { days: 4, units: "metric" },
      }));
      expect(
        await check(fixture, {
          extra: {
            ...fixture.extra,
            inputCommitment: { ...fixture.extra.inputCommitment, parts },
          },
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_commitment",
      });
    });

    it("rejects terms whose digest the seller never signed", async () => {
      expect(
        await check(fixture, {
          extra: { ...fixture.extra, terms: { ...fixture.extra.terms, settlementPolicy: "auto" } },
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_seller_signature",
      });
    });

    it("rejects a top-level amount the seller did not sign", async () => {
      expect(
        await check(fixture, {
          requirements: { ...fixture.requirements, amount: "49999999" },
          extra: fixture.extra,
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_seller_signature",
      });
    });

    it("rejects an agentIdentifier from another policy id", async () => {
      const other = await buildFixture({ agentIdentifier: `${"ff".repeat(28)}01` });
      expect(await check(other)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_agent_identifier",
      });
    });

    it("rejects a blockchainIdentifier that decodes to different values", async () => {
      expect(
        await check(fixture, {
          extra: {
            ...fixture.extra,
            blockchainIdentifier:
              "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80",
          },
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_identifier",
      });
    });
  });

  describe("deployment and escrow address", () => {
    it("rejects a payTo that is not the derived escrow address", async () => {
      expect(
        await check(fixture, {
          requirements: { ...fixture.requirements, payTo: freshKeyAddress(NETWORK).address },
          extra: fixture.extra,
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_deployment",
      });
    });

    it("rejects a custom deployment whose parameters change the address", async () => {
      expect(
        await check(fixture, {
          extra: {
            ...fixture.extra,
            deployment: { ...MASUMI_DEFAULT_DEPLOYMENT, cooldownPeriod: "999999" },
          },
        }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_deployment",
      });
    });

    it("requires facilitator approval for the exact custom deployment", async () => {
      const custom = await buildFixture({
        deployment: { ...MASUMI_DEFAULT_DEPLOYMENT, cooldownPeriod: "999999" },
      });
      expect(await check(custom)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_requirements_masumi_deployment",
      });
      expect(
        await check(custom, {
          validateCustomDeployment: claim => claim.payTo === custom.requirements.payTo,
        }),
      ).toEqual({ ok: true });
    });
  });

  describe("settlement layer", () => {
    it("requires a settlementLayer on the payload", async () => {
      expect(
        await check(fixture, { payload: { ...fixture.payload, settlementLayer: undefined } }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_settlement_layer_mismatch",
      });
    });

    it("rejects a layer the signed settlementPolicy forbids", async () => {
      expect(
        await check(fixture, { payload: { ...fixture.payload, settlementLayer: "hydra" } }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_settlement_layer_mismatch",
      });
    });

    // Hydra needs verified Init state, head parameters, a seller-participant
    // binding and SnapshotConfirmed evidence. None of that exists here, and
    // authenticating a Hydra payment against L1 evidence would be a lie.
    it("rejects hydra outright, even when the terms allow it", async () => {
      const hydra = await buildFixture({ settlementPolicy: "hydra" });
      expect(
        await check(hydra, { payload: { ...hydra.payload, settlementLayer: "hydra" } }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_settlement_layer_unsupported",
      });
    });

    it("rejects an auto policy resolved to hydra", async () => {
      const auto = await buildFixture({ settlementPolicy: "auto" });
      expect(
        await check(auto, { payload: { ...auto.payload, settlementLayer: "hydra" } }),
      ).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_settlement_layer_unsupported",
      });
    });
  });

  describe("lock invariants", () => {
    it("rejects a datum whose seller_nonce differs from the signed terms", async () => {
      const mutated = await buildFixture({
        mutateLock: (extra, buyer) => lockWithDatum(extra, buyer, { sellerNonce: "cd".repeat(32) }),
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_datum_mismatch",
      });
    });

    it("rejects a datum whose buyer does not control the nonce input", async () => {
      const mutated = await buildFixture({
        mutateLock: (extra, buyer) =>
          lockWithDatum(extra, buyer, { buyerAddress: freshKeyAddress(NETWORK).address }),
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_datum_mismatch",
      });
    });

    it("rejects a non-zero cooldown on a fresh lock", async () => {
      const mutated = await buildFixture({
        mutateLock: (extra, buyer) => {
          const base = lockWithDatum(extra, buyer);
          const tree = base.datum.data as unknown as { index: bigint; fields: Data.Data[] };
          const fields = [...tree.fields];
          fields[16] = Data.int(1n);
          return { ...base, datum: inlineDatum(Data.constr(0n, fields)) };
        },
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_datum_invalid",
        detail: "cooldown",
      });
    });

    it("rejects aggregated payouts (buyer target equals seller target)", async () => {
      const mutated = await buildFixture({
        mutateLock: (extra, buyer) =>
          lockWithDatum(extra, buyer, { buyerReturnAddress: extra.terms.sellerAddress }),
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_datum_invalid",
      });
    });

    it("rejects a script-credential buyer return address", async () => {
      const mutated = await buildFixture({
        mutateLock: (extra, buyer) =>
          lockWithDatum(extra, buyer, {
            buyerReturnAddress: masumiEscrowAddress(NETWORK, MASUMI_DEFAULT_DEPLOYMENT),
          }),
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_datum_invalid",
        detail: "buyer_return_address is a script payment credential",
      });
    });

    it("rejects a lock whose value is not requested + collateral", async () => {
      const mutated = await buildFixture({
        mutateLock: (extra, buyer) => lockWithDatum(extra, buyer, {}, 50_000_001n),
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_collateral",
      });
    });

    it("rejects a collateral below the Masumi floor", async () => {
      const mutated = await buildFixture({
        amount: "1000000",
        mutateLock: (extra, buyer) => {
          const base = buildMasumiLock(
            extra,
            buyer,
            LOVELACE_ASSET,
            1_000_000n,
            STUB_COINS_PER_UTXO_BYTE,
          );
          const tree = base.datum.data as unknown as { fields: Data.Data[] };
          const fields = [...tree.fields];
          fields[9] = Data.int(1n);
          return {
            datum: inlineDatum(Data.constr(0n, fields)),
            collateralLovelace: 1n,
            lockedLovelace: 1_000_001n,
          };
        },
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_collateral",
      });
    });

    it("rejects a datum that is not the 19-field vested_pay schema", async () => {
      const mutated = await buildFixture({
        mutateLock: () => ({
          datum: inlineDatum(Data.constr(0n, [Data.int(1n)])),
          collateralLovelace: 0n,
          lockedLovelace: 50_000_000n,
        }),
      });
      expect(await check(mutated)).toMatchObject({
        ok: false,
        reason: "invalid_exact_cardano_payload_masumi_datum_invalid",
      });
    });
  });

  it("rejects a lock whose TTL is after pay_by_time", async () => {
    const late = await buildFixture({
      payByTimeMs: BigInt(slotToPosixMs(NETWORK, TTL_SLOT)) - 1000n,
    });
    expect(await check(late)).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_masumi_deadline",
    });
  });

  it("rejects deadlines that do not clear the minimum intervals", async () => {
    // The seller signs these short intervals, so the signature verifies — the
    // minimums are a lock invariant the facilitator enforces regardless.
    const short = await buildFixture({ submitResultTimeMs: PAY_BY_TIME + 1000n });
    expect(await check(short)).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_masumi_deadline",
    });
  });
});
