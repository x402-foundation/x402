import { Address, Bytes, type Transaction, TxOut } from "@evolution-sdk/evolution";

import { LOVELACE_ASSET } from "../constants";
import { minUtxoLovelace } from "../utils";
import { Cip30SignerError } from "./errors";
import { type Cip30TxOutput, inputRef, outputCarriesScriptData } from "./utxo";

/**
 * Protocol parameters in the shape the Evolution SDK builder accepts as
 * `fullProtocolParameters`. Declared structurally so callers never need an
 * Evolution-internal import.
 */
export interface Cip30ProtocolParameters {
  readonly minFeeA: number;
  readonly minFeeB: number;
  readonly maxTxSize: number;
  readonly maxValSize: number;
  readonly keyDeposit: bigint;
  readonly poolDeposit: bigint;
  readonly drepDeposit: bigint;
  readonly govActionDeposit: bigint;
  readonly priceMem: number;
  readonly priceStep: number;
  readonly maxTxExMem: bigint;
  readonly maxTxExSteps: bigint;
  readonly coinsPerUtxoByte: bigint;
  readonly collateralPercentage: number;
  readonly maxCollateralInputs: number;
  readonly minFeeRefScriptCostPerByte: number;
  readonly costModels: {
    readonly PlutusV1: Record<string, number>;
    readonly PlutusV2: Record<string, number>;
    readonly PlutusV3: Record<string, number>;
  };
}

/** Inclusive numeric range. */
interface Bound {
  readonly min: number;
  readonly max: number;
}

/**
 * Sanity bounds for protocol parameters a CIP-30 payer accepts from an
 * untrusted source (e.g. the payee's own server). Roughly half to twice the
 * Conway values for every parameter that moves the payer's funds; a governance
 * change beyond these needs a release. Low values cannot cost the payer money
 * (the facilitator's fee and min-UTxO floors reject them before broadcast), so
 * the lower bounds only catch mapping bugs.
 */
export const CIP30_PROTOCOL_PARAMETER_BOUNDS = {
  minFeeA: { min: 22, max: 88 },
  minFeeB: { min: 77_690, max: 310_762 },
  coinsPerUtxoByte: { min: 2_155, max: 8_620 },
  maxTxSize: { min: 8_192, max: 65_536 },
  maxValSize: { min: 4_000, max: 20_000 },
  minFeeRefScriptCostPerByte: { min: 0, max: 1_000 },
  priceMem: { min: 0, max: 1 },
  priceStep: { min: 0, max: 1 },
} as const satisfies Record<string, Bound>;

/** Absolute fee ceiling (lovelace) for a CIP-30 default-method payment. */
export const CIP30_MAX_FEE_LOVELACE = 1_000_000n;

/**
 * Slack (lovelace) above the linear fee for the actual transaction size. Bounds
 * how much sub-min-UTxO change the builder may fold into the fee.
 */
export const CIP30_FEE_DRAIN_SLACK_LOVELACE = 300_000n;

/** Ceiling on the lovelace riding with a native-asset payment to the payee. */
export const CIP30_MAX_TOKEN_OUTPUT_LOVELACE = 3_000_000n;

/**
 * Refuses protocol parameters outside {@link CIP30_PROTOCOL_PARAMETER_BOUNDS}.
 * Must run before any wallet access.
 *
 * @param params - Candidate protocol parameters.
 */
export function assertCip30ProtocolParametersInBounds(params: Cip30ProtocolParameters): void {
  for (const [field, bound] of Object.entries(CIP30_PROTOCOL_PARAMETER_BOUNDS)) {
    const raw = (params as unknown as Record<string, unknown>)[field];
    const value = typeof raw === "bigint" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Cip30SignerError(
        "protocol_parameters_invalid",
        `Network parameter ${field} is missing or not a number`,
      );
    }
    if (value < bound.min || value > bound.max) {
      throw new Cip30SignerError(
        "protocol_parameters_out_of_bounds",
        `Network parameter ${field}=${value} is outside the range this version of @x402/cardano accepts (${bound.min}–${bound.max})`,
      );
    }
  }
}

/** Expected values computed before the build, independent of the built transaction. */
export interface BuiltPaymentContext {
  /** Expected network id (0 testnets, 1 mainnet). */
  readonly networkId: number;
  /** `txHash#index` refs the builder was allowed to spend. */
  readonly poolRefs: ReadonlySet<string>;
  /** `txHash#index` of the chosen nonce UTXO; must be an input. */
  readonly nonceRef: string;
  /** Payee bech32 address from the selected requirement. */
  readonly payTo: string;
  /** Bech32 change address taken from the wallet. */
  readonly changeAddress: string;
  /** `lovelace` or `policyId.assetNameHex`. */
  readonly asset: string;
  /** Amount in the asset's smallest unit. */
  readonly amount: bigint;
  /** Bounded protocol parameters used for the build. */
  readonly params: Cip30ProtocolParameters;
  /** Serialized size of the transaction with fake witnesses (bytes). */
  readonly signedSizeBytes: number;
}

/**
 * The only transaction body fields a plain payment may set. Every other field,
 * including ones a future SDK or era adds, must be absent or empty.
 */
const ALLOWED_BODY_FIELDS: ReadonlySet<string> = new Set([
  // Evolution's schema tag, not a ledger field.
  "_tag",
  "inputs",
  "outputs",
  "fee",
  "ttl",
  "networkId",
]);

/** The only witness-set field (besides Evolution's `_tag`) a CIP-30 wallet may fill for a plain payment. */
const ALLOWED_WITNESS_FIELDS: ReadonlySet<string> = new Set(["_tag", "vkeyWitnesses"]);

/**
 * Whether a field value counts as "not set".
 *
 * @param value - Field value.
 * @returns True for undefined, null and empty arrays, maps and sets.
 */
function isUnset(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  return false;
}

/**
 * Lists the native assets of an Evolution output as `policy.name → quantity`.
 *
 * @param output - Transaction output.
 * @returns Asset map (empty for ADA-only outputs).
 */
function outputAssets(output: Cip30TxOutput): Map<string, bigint> {
  const assets = new Map<string, bigint>();
  const multiAsset = output.assets.multiAsset;
  if (multiAsset) {
    for (const [policyId, inner] of multiAsset.map) {
      for (const [assetName, quantity] of inner) {
        assets.set(`${Bytes.toHex(policyId.hash)}.${Bytes.toHex(assetName.bytes)}`, quantity);
      }
    }
  }
  return assets;
}

/**
 * Refuses any built transaction that is not exactly a plain payment of the
 * requested value to `payTo` plus change back to the wallet. Runs after the
 * build and before the wallet is asked to sign.
 *
 * @param tx - The built, unsigned transaction.
 * @param ctx - Values expected before the build.
 */
export function assertBuiltPaymentAllowed(
  tx: Transaction.Transaction,
  ctx: BuiltPaymentContext,
): void {
  const body = tx.body as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(body)) {
    if (!ALLOWED_BODY_FIELDS.has(field) && !isUnset(value)) {
      throw new Cip30SignerError(
        "body_field_forbidden",
        `Built transaction unexpectedly sets ${field}`,
      );
    }
  }
  if (tx.body.networkId !== undefined && Number(tx.body.networkId) !== ctx.networkId) {
    throw new Cip30SignerError("network_id_mismatch", "Built transaction targets another network");
  }
  if (tx.auxiliaryData !== null && tx.auxiliaryData !== undefined) {
    throw new Cip30SignerError(
      "body_field_forbidden",
      "Built transaction unexpectedly carries metadata",
    );
  }
  if (tx.body.ttl === undefined) {
    throw new Cip30SignerError("ttl_missing", "Built transaction has no validity upper bound");
  }

  const inputRefs = tx.body.inputs.map(inputRef);
  for (const ref of inputRefs) {
    if (!ctx.poolRefs.has(ref)) {
      throw new Cip30SignerError(
        "input_outside_pool",
        `Built transaction spends ${ref}, which was not offered`,
      );
    }
  }
  if (!inputRefs.includes(ctx.nonceRef.toLowerCase())) {
    throw new Cip30SignerError(
      "nonce_not_in_inputs",
      "Built transaction does not spend the chosen nonce UTXO",
    );
  }

  if (ctx.payTo === ctx.changeAddress) {
    throw new Cip30SignerError(
      "pay_to_is_change",
      "The payee address is the payer's own change address",
    );
  }
  let recipientCount = 0;
  for (const output of tx.body.outputs) {
    if (outputCarriesScriptData(output)) {
      throw new Cip30SignerError(
        "output_script_data",
        "Built transaction output carries a datum or script",
      );
    }
    const address = Address.toBech32(output.address);
    if (address === ctx.payTo) {
      recipientCount += 1;
      assertRecipientOutput(output, ctx);
    } else if (address !== ctx.changeAddress) {
      throw new Cip30SignerError(
        "unexpected_output",
        `Built transaction pays an unexpected address ${address}`,
      );
    }
  }
  if (recipientCount !== 1) {
    throw new Cip30SignerError(
      "recipient_output_count",
      `Expected exactly one payee output, found ${recipientCount}`,
    );
  }

  const fee = tx.body.fee;
  if (fee > CIP30_MAX_FEE_LOVELACE) {
    throw new Cip30SignerError(
      "fee_too_high",
      `Network fee ${fee} lovelace exceeds the ${CIP30_MAX_FEE_LOVELACE} cap`,
    );
  }
  const linearFee =
    BigInt(ctx.params.minFeeB) + BigInt(ctx.params.minFeeA) * BigInt(ctx.signedSizeBytes);
  if (fee > linearFee + CIP30_FEE_DRAIN_SLACK_LOVELACE) {
    throw new Cip30SignerError(
      "fee_drain",
      "This payment would burn leftover ADA as fee; consolidate your wallet and try again",
    );
  }
}

/**
 * Checks the single payee output carries exactly the requested value, and for
 * ADA that the amount clears the output's min-UTxO (the facilitator's rule 8).
 *
 * @param output - The output paying `payTo`.
 * @param ctx - Values expected before the build.
 */
function assertRecipientOutput(output: Cip30TxOutput, ctx: BuiltPaymentContext): void {
  const assets = outputAssets(output);
  const coin = output.assets.lovelace;
  if (ctx.asset.toLowerCase() === LOVELACE_ASSET) {
    if (coin !== ctx.amount || assets.size !== 0) {
      throw new Cip30SignerError(
        "recipient_value_mismatch",
        "Payee output does not carry exactly the requested ADA",
      );
    }
    const minUtxo = minUtxoLovelace(TxOut.toCBORBytes(output).length, ctx.params.coinsPerUtxoByte);
    if (coin < minUtxo) {
      throw new Cip30SignerError(
        "amount_below_min_utxo",
        `Payee output carries ${coin} lovelace, below its ${minUtxo} lovelace min-UTxO`,
      );
    }
    return;
  }
  const expectedUnit = ctx.asset.toLowerCase();
  if (assets.size !== 1 || assets.get(expectedUnit) !== ctx.amount) {
    throw new Cip30SignerError(
      "recipient_value_mismatch",
      "Payee output does not carry exactly the requested token",
    );
  }
  if (coin > CIP30_MAX_TOKEN_OUTPUT_LOVELACE) {
    throw new Cip30SignerError(
      "recipient_lovelace_too_high",
      `Payee output carries ${coin} lovelace with the token, above the ${CIP30_MAX_TOKEN_OUTPUT_LOVELACE} cap`,
    );
  }
}

/**
 * Refuses a wallet witness set that contains anything but vkey witnesses.
 *
 * @param witnessSet - Witness set returned by the wallet.
 */
export function assertVkeyOnlyWitnessSet(witnessSet: Transaction.Transaction["witnessSet"]): void {
  const ws = witnessSet as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(ws)) {
    if (!ALLOWED_WITNESS_FIELDS.has(field) && !isUnset(value)) {
      throw new Cip30SignerError("witness_set_forbidden", `Wallet returned unexpected ${field}`);
    }
  }
  if (!witnessSet.vkeyWitnesses || witnessSet.vkeyWitnesses.length === 0) {
    throw new Cip30SignerError("witness_set_empty", "Wallet returned no signatures");
  }
}
