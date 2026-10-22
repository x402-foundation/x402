import {
  Address,
  Assets,
  Client,
  PrivateKey,
  Transaction,
  TransactionHash,
  TxOut,
  UTxO,
  preprod,
} from "@evolution-sdk/evolution";
import { beforeAll, describe, expect, it } from "vitest";

import { Cip30SignerError } from "../../src/cip30/errors";
import {
  assertBuiltPaymentAllowed,
  assertCip30ProtocolParametersInBounds,
  assertVkeyOnlyWitnessSet,
  type BuiltPaymentContext,
  CIP30_PROTOCOL_PARAMETER_BOUNDS,
  type Cip30ProtocolParameters,
} from "../../src/cip30/guards";
import {
  buildCip30Pool,
  chooseCip30Nonce,
  decodeCip30PoolUtxo,
  inputRef,
} from "../../src/cip30/utxo";
import { LOVELACE_ASSET, USDM_PREPROD_ASSET } from "../../src/constants";
import { minUtxoLovelace, parseAssetUnit } from "../../src/utils";
import { encodeCip30Utxo, encodeRawCip30Utxo } from "../helpers/cip30Shim";
import { OFFLINE_PROTOCOL_PARAMETERS } from "../helpers/buildSignedTx";
import { freshPreprodAddress, hex64 } from "../helpers/stubs";

const PARAMS: Cip30ProtocolParameters = OFFLINE_PROTOCOL_PARAMETERS;
const hash = hex64;

/** A built plain payment plus the context that makes it pass. */
interface Fixture {
  tx: Transaction.Transaction;
  ctx: BuiltPaymentContext;
  changeAddress: string;
  payTo: string;
  payToAddress: Address.Address;
}

/**
 * Builds a real unsigned plain payment with the Evolution builder.
 *
 * @param asset - Asset to pay.
 * @param amount - Amount to pay.
 * @returns Transaction and matching guard context.
 */
async function buildFixture(asset: string, amount: bigint): Promise<Fixture> {
  const client = Client.make(preprod)
    .withKoios({ baseUrl: "https://unused.invalid" })
    .withSeed({ mnemonic: PrivateKey.generateMnemonic() });
  const change = await client.address();
  const payTo = await freshPreprodAddress();
  const isLovelace = asset === LOVELACE_ASSET;
  let funding = Assets.fromLovelace(10_000_000n);
  let pay = Assets.fromLovelace(amount);
  if (!isLovelace) {
    const { policyId, assetNameHex } = parseAssetUnit(asset);
    funding = Assets.addByHex(funding, policyId, assetNameHex, amount * 2n);
    pay = Assets.addByHex(Assets.zero, policyId, assetNameHex, amount);
  }
  const nonce = new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(hash("1")),
    index: 0n,
    address: change,
    assets: funding,
    datumOption: undefined,
    scriptRef: undefined,
  });
  const builder = await client
    .newTx()
    .collectFrom({ inputs: [nonce] })
    .payToAddress({ address: Address.fromBech32(payTo), assets: pay })
    .setValidity({ to: BigInt(Date.now() + 300_000) })
    .build({
      changeAddress: change,
      availableUtxos: [nonce],
      fullProtocolParameters: PARAMS,
      autoMinUtxo: !isLovelace,
    });
  const tx = await builder.toTransaction();
  const fake = await builder.toTransactionWithFakeWitnesses();
  return {
    tx,
    payTo,
    payToAddress: Address.fromBech32(payTo),
    changeAddress: Address.toBech32(change),
    ctx: {
      networkId: 0,
      poolRefs: new Set([`${hash("1")}#0`]),
      nonceRef: `${hash("1")}#0`,
      payTo,
      changeAddress: Address.toBech32(change),
      asset,
      amount,
      params: PARAMS,
      signedSizeBytes: Transaction.toCBORBytes(fake).length,
    },
  };
}

/**
 * Returns a structural copy of the transaction with body fields overridden.
 *
 * @param tx - Original transaction.
 * @param patch - Body fields to set.
 * @returns Patched transaction (only for guard inspection).
 */
function withBody(
  tx: Transaction.Transaction,
  patch: Record<string, unknown>,
): Transaction.Transaction {
  return { ...tx, body: { ...tx.body, ...patch } } as unknown as Transaction.Transaction;
}

/**
 * Expects the guard to refuse with a given code.
 *
 * @param fn - Guard invocation.
 * @param code - Expected error code.
 */
function expectRefusal(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Cip30SignerError);
    expect((error as Cip30SignerError).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
}

describe("assertCip30ProtocolParametersInBounds", () => {
  it("accepts today's parameters", () => {
    expect(() => assertCip30ProtocolParametersInBounds(PARAMS)).not.toThrow();
  });

  const cases = Object.entries(CIP30_PROTOCOL_PARAMETER_BOUNDS).flatMap(([field, bound]) => {
    const isBig = field === "coinsPerUtxoByte";
    const below = bound.min === 0 ? -1 : bound.min - (field.startsWith("price") ? 0.001 : 1);
    const above = bound.max + (field.startsWith("price") ? 0.001 : 1);
    return [
      [field, "below", isBig ? BigInt(Math.floor(below)) : below],
      [field, "above", isBig ? BigInt(above) : above],
    ] as const;
  });
  it.each(cases)("refuses %s %s its range", (field, _dir, value) => {
    expectRefusal(
      () => assertCip30ProtocolParametersInBounds({ ...PARAMS, [field]: value }),
      "protocol_parameters_out_of_bounds",
    );
  });

  it("refuses a missing or non-numeric parameter", () => {
    expectRefusal(
      () => assertCip30ProtocolParametersInBounds({ ...PARAMS, minFeeA: Number.NaN }),
      "protocol_parameters_invalid",
    );
    expectRefusal(
      () =>
        assertCip30ProtocolParametersInBounds({
          ...PARAMS,
          maxValSize: undefined,
        } as unknown as Cip30ProtocolParameters),
      "protocol_parameters_invalid",
    );
  });
});

describe("assertBuiltPaymentAllowed", () => {
  let ada: Fixture;
  let token: Fixture;
  beforeAll(async () => {
    ada = await buildFixture(LOVELACE_ASSET, 2_000_000n);
    token = await buildFixture(USDM_PREPROD_ASSET, 1_500_000n);
  });

  it("accepts a plain ADA payment and a plain token payment", () => {
    expect(() => assertBuiltPaymentAllowed(ada.tx, ada.ctx)).not.toThrow();
    expect(() => assertBuiltPaymentAllowed(token.tx, token.ctx)).not.toThrow();
  });

  it.each([
    "certificates",
    "withdrawals",
    "auxiliaryDataHash",
    "validityIntervalStart",
    "mint",
    "scriptDataHash",
    "collateralInputs",
    "requiredSigners",
    "collateralReturn",
    "totalCollateral",
    "referenceInputs",
    "votingProcedures",
    "proposalProcedures",
    "currentTreasuryValue",
    "donation",
    // Not an Evolution field today: proves the check is an allowlist.
    "futureLedgerField",
  ])("refuses a body that sets %s", field => {
    expectRefusal(
      () => assertBuiltPaymentAllowed(withBody(ada.tx, { [field]: [1n] }), ada.ctx),
      "body_field_forbidden",
    );
    expectRefusal(
      () => assertBuiltPaymentAllowed(withBody(ada.tx, { [field]: 1n }), ada.ctx),
      "body_field_forbidden",
    );
  });

  it("refuses metadata, another network id and a missing TTL", () => {
    expectRefusal(
      () =>
        assertBuiltPaymentAllowed(
          { ...ada.tx, auxiliaryData: {} } as unknown as Transaction.Transaction,
          ada.ctx,
        ),
      "body_field_forbidden",
    );
    expectRefusal(
      () => assertBuiltPaymentAllowed(withBody(ada.tx, { networkId: 1 }), ada.ctx),
      "network_id_mismatch",
    );
    expectRefusal(
      () => assertBuiltPaymentAllowed(withBody(ada.tx, { ttl: undefined }), ada.ctx),
      "ttl_missing",
    );
  });

  it("refuses an input outside the offered pool and a missing nonce", () => {
    expectRefusal(
      () => assertBuiltPaymentAllowed(ada.tx, { ...ada.ctx, poolRefs: new Set() }),
      "input_outside_pool",
    );
    expectRefusal(
      () => assertBuiltPaymentAllowed(ada.tx, { ...ada.ctx, nonceRef: `${hash("2")}#0` }),
      "nonce_not_in_inputs",
    );
  });

  it("refuses when the payee is the payer's change address", () => {
    expectRefusal(
      () => assertBuiltPaymentAllowed(ada.tx, { ...ada.ctx, payTo: ada.changeAddress }),
      "pay_to_is_change",
    );
  });

  it("refuses an extra output to a third party", async () => {
    const stranger = Address.fromBech32(await freshPreprodAddress());
    const extra = new TxOut.TransactionOutput({
      address: stranger,
      assets: Assets.fromLovelace(1_000_000n),
    });
    expectRefusal(
      () =>
        assertBuiltPaymentAllowed(
          withBody(ada.tx, { outputs: [...ada.tx.body.outputs, extra] }),
          ada.ctx,
        ),
      "unexpected_output",
    );
  });

  it("refuses change sent to an address other than the wallet's change address", async () => {
    const otherOwnAddress = await freshPreprodAddress();
    expectRefusal(
      () => assertBuiltPaymentAllowed(ada.tx, { ...ada.ctx, changeAddress: otherOwnAddress }),
      "unexpected_output",
    );
  });

  it("refuses a second payee output and a missing payee output", () => {
    const payee = ada.tx.body.outputs.find(o => Address.toBech32(o.address) === ada.payTo)!;
    expectRefusal(
      () =>
        assertBuiltPaymentAllowed(
          withBody(ada.tx, { outputs: [...ada.tx.body.outputs, payee] }),
          ada.ctx,
        ),
      "recipient_output_count",
    );
    const others = ada.tx.body.outputs.filter(o => o !== payee);
    expectRefusal(
      () => assertBuiltPaymentAllowed(withBody(ada.tx, { outputs: others }), ada.ctx),
      "recipient_output_count",
    );
  });

  it("refuses an output carrying a datum or reference script", () => {
    const [first, ...rest] = ada.tx.body.outputs;
    for (const field of ["datumOption", "scriptRef"]) {
      const tainted = { ...first, [field]: {} };
      expectRefusal(
        () => assertBuiltPaymentAllowed(withBody(ada.tx, { outputs: [tainted, ...rest] }), ada.ctx),
        "output_script_data",
      );
    }
  });

  it("refuses an ADA payee output that differs from the amount by one lovelace", () => {
    expectRefusal(
      () => assertBuiltPaymentAllowed(ada.tx, { ...ada.ctx, amount: ada.ctx.amount - 1n }),
      "recipient_value_mismatch",
    );
  });

  it("refuses an ADA amount one lovelace below the payee output's min-UTxO", async () => {
    const payee = ada.tx.body.outputs.find(o => Address.toBech32(o.address) === ada.payTo)!;
    const min = minUtxoLovelace(TxOut.toCBORBytes(payee).length, PARAMS.coinsPerUtxoByte);
    const atMin = await buildFixture(LOVELACE_ASSET, min);
    expect(() => assertBuiltPaymentAllowed(atMin.tx, atMin.ctx)).not.toThrow();
    const below = await buildFixture(LOVELACE_ASSET, min - 1n);
    expectRefusal(() => assertBuiltPaymentAllowed(below.tx, below.ctx), "amount_below_min_utxo");
  });

  /**
   * Replaces the payee output of the token fixture.
   *
   * @param assets - New payee value.
   * @returns Patched transaction.
   */
  function tokenWithPayee(assets: Assets.Assets): Transaction.Transaction {
    const outputs = token.tx.body.outputs.map(o =>
      Address.toBech32(o.address) === token.payTo
        ? new TxOut.TransactionOutput({ address: token.payToAddress, assets })
        : o,
    );
    return withBody(token.tx, { outputs });
  }

  it("refuses a token payee output with a second asset or extra lovelace beyond the cap", () => {
    const { policyId, assetNameHex } = parseAssetUnit(USDM_PREPROD_ASSET);
    const base = Assets.addByHex(
      Assets.fromLovelace(1_500_000n),
      policyId,
      assetNameHex,
      1_500_000n,
    );
    expectRefusal(
      () =>
        assertBuiltPaymentAllowed(
          tokenWithPayee(Assets.addByHex(base, "ab".repeat(28), "", 1n)),
          token.ctx,
        ),
      "recipient_value_mismatch",
    );
    expectRefusal(
      () =>
        assertBuiltPaymentAllowed(
          tokenWithPayee(
            Assets.addByHex(Assets.fromLovelace(3_000_001n), policyId, assetNameHex, 1_500_000n),
          ),
          token.ctx,
        ),
      "recipient_lovelace_too_high",
    );
    expect(() =>
      assertBuiltPaymentAllowed(
        tokenWithPayee(
          Assets.addByHex(Assets.fromLovelace(3_000_000n), policyId, assetNameHex, 1_500_000n),
        ),
        token.ctx,
      ),
    ).not.toThrow();
  });

  it("refuses a fee above 1 ADA and a fee that drains leftover change", () => {
    expectRefusal(
      () => assertBuiltPaymentAllowed(withBody(ada.tx, { fee: 1_000_001n }), ada.ctx),
      "fee_too_high",
    );
    const linear =
      BigInt(PARAMS.minFeeB) + BigInt(PARAMS.minFeeA) * BigInt(ada.ctx.signedSizeBytes);
    expectRefusal(
      () => assertBuiltPaymentAllowed(withBody(ada.tx, { fee: linear + 300_001n }), ada.ctx),
      "fee_drain",
    );
    expect(() =>
      assertBuiltPaymentAllowed(withBody(ada.tx, { fee: linear + 300_000n }), ada.ctx),
    ).not.toThrow();
  });
});

describe("assertVkeyOnlyWitnessSet", () => {
  const vkey = { vkey: {}, signature: {} };
  it("accepts vkey witnesses only", () => {
    expect(() => assertVkeyOnlyWitnessSet({ vkeyWitnesses: [vkey] } as never)).not.toThrow();
  });
  it.each([
    "bootstrapWitnesses",
    "nativeScripts",
    "plutusV1Scripts",
    "plutusV2Scripts",
    "plutusV3Scripts",
    "plutusData",
  ])("refuses a wallet witness set containing %s", field => {
    expectRefusal(
      () => assertVkeyOnlyWitnessSet({ vkeyWitnesses: [vkey], [field]: [{}] } as never),
      "witness_set_forbidden",
    );
  });
  it("refuses a witness field it does not know (allowlist, not blocklist)", () => {
    expectRefusal(
      () => assertVkeyOnlyWitnessSet({ vkeyWitnesses: [vkey], futureWitnessKind: [{}] } as never),
      "witness_set_forbidden",
    );
    expect(() =>
      assertVkeyOnlyWitnessSet({ vkeyWitnesses: [vkey], futureWitnessKind: [] } as never),
    ).not.toThrow();
  });

  it("refuses redeemers and an empty witness set", () => {
    expectRefusal(
      () =>
        assertVkeyOnlyWitnessSet({ vkeyWitnesses: [vkey], redeemers: new Map([[1, 1]]) } as never),
      "witness_set_forbidden",
    );
    expectRefusal(() => assertVkeyOnlyWitnessSet({} as never), "witness_set_empty");
  });
});

describe("CIP-30 UTxO pool", () => {
  it("decodes a key-address UTxO and round-trips its reference", async () => {
    const owner = Address.fromBech32(await freshPreprodAddress());
    const utxo = new UTxO.UTxO({
      transactionId: TransactionHash.fromHex(hash("3")),
      index: 7n,
      address: owner,
      assets: Assets.fromLovelace(5_000_000n),
      datumOption: undefined,
      scriptRef: undefined,
    });
    const decoded = decodeCip30PoolUtxo(encodeCip30Utxo(utxo), 0);
    expect(decoded && inputRef(decoded)).toBe(`${hash("3")}#7`);
    expect(decodeCip30PoolUtxo(encodeCip30Utxo(utxo), 1)).toBeUndefined();
  });

  it("drops script-credential, datum-bearing, malformed and duplicate entries", async () => {
    const owner = Address.fromBech32(await freshPreprodAddress());
    const keyBytes = Address.toBytes(owner);
    const good = encodeRawCip30Utxo(hash("4"), 0n, keyBytes, 3_000_000n);
    const pool = buildCip30Pool(
      [
        good,
        good,
        encodeRawCip30Utxo(
          hash("5"),
          0n,
          new Uint8Array([0x70, ...new Uint8Array(28)]),
          3_000_000n,
        ),
        encodeRawCip30Utxo(hash("6"), 0n, keyBytes, 3_000_000n, new Uint8Array(32)),
        "82",
        "zz",
      ],
      0,
    );
    expect(pool.map(inputRef)).toEqual([`${hash("4")}#0`]);
  });

  it("refuses to choose from an empty pool", () => {
    expectRefusal(() => chooseCip30Nonce([]), "no_spendable_utxo");
  });
});
