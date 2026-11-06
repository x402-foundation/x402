import { describe, expect, it } from "vitest";

import { checkMinimumFee, checkValueConservation } from "../../src/exact/facilitator/phase1";
import type { CardanoUtxoSnapshot } from "../../src/signer";
import type { DecodedCardanoTransaction } from "../../src/types";

const USDM = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d";
const PAYEE = "addr_test1vpayee";
const CHANGE = "addr_test1vpayer";

/** A plain two-output payment: 2 ADA to the payee, change back, 0.2 ADA fee. */
const decoded = (
  overrides: Partial<DecodedCardanoTransaction> = {},
): DecodedCardanoTransaction => ({
  txHash: "a".repeat(64),
  networkId: 0,
  inputs: [`${"b".repeat(64)}#0`, `${"c".repeat(64)}#1`],
  fee: 200_000n,
  sizeBytes: 300,
  balanceChangingOperations: [],
  outputs: [
    { address: PAYEE, coin: 2_000_000n, assets: {} },
    { address: CHANGE, coin: 7_800_000n, assets: {} },
  ],
  vkeyWitnessCount: 1,
  vkeyHashes: [],
  scriptWitnessCount: 0,
  redeemerCount: 0,
  signaturesValid: true,
  isValid: true,
  ...overrides,
});

const inputs = (...coins: bigint[]): CardanoUtxoSnapshot[] =>
  coins.map(coin => ({ exists: true, address: CHANGE, coin, assets: {} }));

const PARAMETERS = { coinsPerUtxoByte: 4310n, minFeeCoefficient: 44n, minFeeConstant: 155_381n };

describe("checkValueConservation", () => {
  it("accepts a payment whose inputs equal outputs plus fee", () => {
    expect(checkValueConservation(decoded(), inputs(4_000_000n, 6_000_000n))).toEqual({ ok: true });
  });

  it("rejects inputs that fall short of outputs plus fee", () => {
    const result = checkValueConservation(decoded(), inputs(4_000_000n, 5_999_999n));
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_value_not_conserved",
    });
    expect((result as { detail: string }).detail).toContain("9999999 lovelace");
  });

  it("rejects inputs that exceed outputs plus fee (value must not vanish either)", () => {
    expect(checkValueConservation(decoded(), inputs(4_000_000n, 6_000_001n))).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_value_not_conserved",
    });
  });

  it("requires every native asset to reappear in the outputs", () => {
    const withToken = decoded({
      outputs: [
        { address: PAYEE, coin: 2_000_000n, assets: { [USDM]: 500_000n } },
        { address: CHANGE, coin: 7_800_000n, assets: {} },
      ],
    });
    const funded: CardanoUtxoSnapshot[] = [
      { exists: true, address: CHANGE, coin: 4_000_000n, assets: { [USDM]: 500_000n } },
      { exists: true, address: CHANGE, coin: 6_000_000n, assets: {} },
    ];
    expect(checkValueConservation(withToken, funded)).toEqual({ ok: true });

    // An output token the inputs never held would be minted from nothing.
    expect(checkValueConservation(withToken, inputs(4_000_000n, 6_000_000n))).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_value_not_conserved",
    });
    // A token the inputs held but no output carries would be burned.
    expect(checkValueConservation(decoded(), funded)).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_value_not_conserved",
    });
  });

  it("treats an explicit zero quantity as absent", () => {
    const zeroed: CardanoUtxoSnapshot[] = [
      { exists: true, address: CHANGE, coin: 4_000_000n, assets: { [USDM]: 0n } },
      { exists: true, address: CHANGE, coin: 6_000_000n, assets: {} },
    ];
    expect(checkValueConservation(decoded(), zeroed)).toEqual({ ok: true });
  });

  it("refuses to guess when an input carries no value", () => {
    const partial: CardanoUtxoSnapshot[] = [
      { exists: true, address: CHANGE, coin: 4_000_000n, assets: {} },
      { exists: true, address: CHANGE },
    ];
    expect(checkValueConservation(decoded(), partial)).toMatchObject({
      ok: false,
      reason: "exact_cardano_facilitator_input_value_unavailable",
      detail: expect.stringContaining(`${"c".repeat(64)}#1`),
    });
  });
});

describe("checkMinimumFee", () => {
  it("accepts a fee exactly at the protocol floor", () => {
    // 155381 + 44 * 300 = 168581
    expect(checkMinimumFee(decoded({ fee: 168_581n }), PARAMETERS)).toEqual({ ok: true });
  });

  it("rejects a fee one lovelace below the floor", () => {
    expect(checkMinimumFee(decoded({ fee: 168_580n }), PARAMETERS)).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_fee_below_minimum",
      detail: expect.stringContaining("168581"),
    });
  });

  it("scales the floor with the serialized transaction size", () => {
    expect(checkMinimumFee(decoded({ fee: 168_581n, sizeBytes: 301 }), PARAMETERS)).toMatchObject({
      ok: false,
      reason: "invalid_exact_cardano_payload_fee_below_minimum",
    });
  });
});
