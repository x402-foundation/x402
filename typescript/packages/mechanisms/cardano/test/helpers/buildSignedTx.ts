/**
 * OFFLINE test fixture builder. NOT part of the shipped package.
 *
 * Produces a structurally-valid, SIGNED Cardano transaction entirely offline
 * (no network, no funds) for deterministic integration tests of the facilitator
 * scheme. It drives the Evolution SDK high-level builder with an unreachable
 * provider and explicit `BuildOptions` (availableUtxos + fullProtocolParameters)
 * so no provider call is ever made, then assembles the body with the offline
 * wallet's witness set and serialises to base64 CBOR.
 *
 * The output round-trips through `decodeCardanoTransaction`: the nonce UTXO
 * appears as an input, an output pays the requested asset/amount to `payTo`,
 * the TTL slot is set, and exactly one vkey witness is present.
 */
import {
  Address,
  Assets,
  Client,
  Credential,
  mainnet,
  InlineDatum,
  preprod,
  preview,
  PrivateKey,
  Transaction,
  TransactionHash,
  UTxO,
} from "@evolution-sdk/evolution";
import type { Chain } from "@evolution-sdk/evolution";

import {
  CARDANO_MAINNET_CAIP2,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREVIEW_CAIP2,
  LOVELACE_ASSET,
} from "../../src/constants";
import { parseAssetUnit } from "../../src/utils";
import type { CardanoUtxoSnapshot } from "../../src/signer";

/** Input snapshots registered by offline fixtures for the in-memory chain. */
const fixtureInputSnapshots = new Map<string, CardanoUtxoSnapshot>();

/**
 * Returns the latest authenticated input snapshot registered by a fixture.
 *
 * @param ref - UTXO reference.
 * @returns Snapshot, if a fixture registered it.
 */
export function getFixtureInputSnapshot(ref: string): CardanoUtxoSnapshot | undefined {
  return fixtureInputSnapshots.get(ref.toLowerCase());
}

/**
 * Converts Evolution assets into the facilitator snapshot shape.
 *
 * @param value - Evolution SDK value.
 * @returns Canonical native-asset map.
 */
function snapshotAssets(value: Assets.Assets): Record<string, bigint> {
  const result: Record<string, bigint> = {};
  if (value.multiAsset) {
    for (const [policyId, innerMap] of value.multiAsset.map) {
      const policyHex = Buffer.from(policyId.hash).toString("hex").toLowerCase();
      for (const [assetName, quantity] of innerMap) {
        const assetNameHex = Buffer.from(assetName.bytes).toString("hex").toLowerCase();
        result[`${policyHex}.${assetNameHex}`] = quantity;
      }
    }
  }
  return result;
}

/**
 * Minimal protocol parameters sufficient for an offline fee calculation. These
 * are static fixtures, NOT fetched from chain.
 */
const OFFLINE_PROTOCOL_PARAMETERS = {
  minFeeA: 44,
  minFeeB: 155381,
  maxTxSize: 16384,
  maxValSize: 5000,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  govActionDeposit: 100_000_000_000n,
  priceMem: 0.0577,
  priceStep: 0.0000721,
  maxTxExMem: 14_000_000n,
  maxTxExSteps: 10_000_000_000n,
  coinsPerUtxoByte: 4310n,
  collateralPercentage: 150,
  maxCollateralInputs: 3,
  minFeeRefScriptCostPerByte: 15,
  costModels: { PlutusV1: {}, PlutusV2: {}, PlutusV3: {} },
} as const;

/**
 * Parameters for {@link buildSignedTx}.
 */
export interface BuildSignedTxParams {
  /** Recipient bech32 address that the payment output goes to. */
  payTo: string;
  /** Asset unit (`lovelace` or `policyId.assetNameHex`). */
  asset: string;
  /** Amount in the asset's smallest unit. */
  amount: bigint;
  /** UTXO reference used as nonce (`txHashHex#index`); forced to be an input. */
  nonceUtxoRef: string;
  /** Upper validity bound (TTL) as an absolute slot. */
  ttlSlot: bigint;
  /** x402 network identifier; controls address network tag. Defaults to preprod. */
  network?: string;
  /** Lovelace funding the nonce UTXO. Must cover output + fee. Defaults to 10 ADA. */
  fundingLovelace?: bigint;
  /**
   * Optional second wallet UTXO offered to coin selection, so the built tx has
   * more than one input. Pair with a small `fundingLovelace` to force it to be
   * selected. Lovelace-only.
   */
  secondInput?: { ref: string; lovelace: bigint };
  /** Optional inline datum to attach to the payment output (e.g. a Masumi lock). */
  datum?: InlineDatum.InlineDatum;
  /**
   * Optional wallet mnemonic. Supply one when the caller needs the payer address
   * *before* building the transaction — a Masumi lock datum names the buyer, and
   * the buyer must control the nonce input.
   */
  mnemonic?: string;
  /**
   * Exact lovelace to place on the payment output, disabling the automatic
   * min-UTXO bump. A Masumi lock must carry exactly
   * `requestedLovelace + collateral`, which the bump would break.
   */
  outputLovelace?: bigint;
}

/**
 * Result of {@link buildSignedTx}.
 */
export interface BuildSignedTxResult {
  /** Base64-encoded signed CBOR transaction. */
  transaction: string;
  /** The nonce UTXO reference, echoed for convenience. */
  nonce: string;
  /** The payer bech32 address that controls the nonce UTXO. */
  payer: string;
  /** Authenticated snapshot registered for the nonce input. */
  nonceSnapshot: CardanoUtxoSnapshot;
}

/**
 * Resolves an x402 network identifier to an Evolution SDK chain preset.
 *
 * @param network - The x402 network identifier.
 * @returns The matching chain preset.
 */
function resolveChain(network: string): Chain {
  switch (network) {
    case CARDANO_MAINNET_CAIP2:
      return mainnet;
    case CARDANO_PREVIEW_CAIP2:
      return preview;
    case CARDANO_PREPROD_CAIP2:
    default:
      return preprod;
  }
}

/**
 * Builds an offline SIGNED Cardano transaction fixture.
 *
 * @param params - The fixture parameters.
 * @returns The base64 signed transaction plus nonce and payer address.
 */
export async function buildSignedTx(params: BuildSignedTxParams): Promise<BuildSignedTxResult> {
  const network = params.network ?? CARDANO_PREPROD_CAIP2;
  const chain = resolveChain(network);

  // Deterministic-enough offline wallet; a fresh key per call is fine for tests.
  const mnemonic = params.mnemonic ?? PrivateKey.generateMnemonic();
  const client = Client.make(chain)
    .withBlockfrost({ baseUrl: "http://offline.invalid" })
    .withSeed({ mnemonic });

  const address = await client.address();
  const payer = Address.toBech32(address);

  const isLovelace = params.asset.toLowerCase() === LOVELACE_ASSET;
  const fundingLovelace = params.fundingLovelace ?? 10_000_000n;

  // The nonce UTXO must hold enough of the paid asset to cover the output. For
  // native assets fund it with both lovelace (for fee + min-UTXO) and the asset.
  const fundingAssets = isLovelace
    ? Assets.fromLovelace(fundingLovelace)
    : (() => {
        const { policyId, assetNameHex } = parseAssetUnit(params.asset);
        return Assets.addByHex(
          Assets.fromLovelace(fundingLovelace),
          policyId,
          assetNameHex,
          params.amount,
        );
      })();

  const [nonceHash, nonceIndexStr] = params.nonceUtxoRef.split("#");
  const nonceUtxo = new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(nonceHash),
    index: BigInt(nonceIndexStr),
    address,
    assets: fundingAssets,
    datumOption: undefined,
    scriptRef: undefined,
  });
  const paymentCredential = Address.getPaymentCredential(Address.toHex(address));
  if (paymentCredential?._tag !== "KeyHash") {
    throw new Error("offline fixture wallet must use a payment-key address");
  }
  const paymentKeyHash = Credential.toHex(paymentCredential).toLowerCase();
  const nonceSnapshot: CardanoUtxoSnapshot = {
    exists: true,
    address: payer,
    coin: fundingAssets.lovelace,
    assets: snapshotAssets(fundingAssets),
    paymentKeyHash,
  };
  fixtureInputSnapshots.set(params.nonceUtxoRef.toLowerCase(), nonceSnapshot);

  // Optional second wallet UTXO so coin selection can produce a multi-input tx.
  const availableUtxos = [nonceUtxo];
  if (params.secondInput) {
    const [secondHash, secondIndexStr] = params.secondInput.ref.split("#");
    availableUtxos.push(
      new UTxO.UTxO({
        transactionId: TransactionHash.fromHex(secondHash),
        index: BigInt(secondIndexStr),
        address,
        assets: Assets.fromLovelace(params.secondInput.lovelace),
        datumOption: undefined,
        scriptRef: undefined,
      }),
    );
    fixtureInputSnapshots.set(params.secondInput.ref.toLowerCase(), {
      exists: true,
      address: payer,
      coin: params.secondInput.lovelace,
      assets: {},
      paymentKeyHash,
    });
  }

  const outputAssets = isLovelace
    ? Assets.fromLovelace(params.outputLovelace ?? params.amount)
    : (() => {
        const { policyId, assetNameHex } = parseAssetUnit(params.asset);
        return Assets.addByHex(
          params.outputLovelace !== undefined
            ? Assets.fromLovelace(params.outputLovelace)
            : Assets.zero,
          policyId,
          assetNameHex,
          params.amount,
        );
      })();

  const signBuilder = await client
    .newTx()
    .collectFrom({ inputs: [nonceUtxo] })
    .payToAddress({
      address: Address.fromBech32(params.payTo),
      assets: outputAssets,
      ...(params.datum ? { datum: params.datum } : {}),
    })
    .setValidity({ to: slotToValidityMs(params.ttlSlot, chain) })
    .build({
      availableUtxos,
      changeAddress: address,
      fullProtocolParameters: OFFLINE_PROTOCOL_PARAMETERS,
      autoMinUtxo: params.outputLovelace === undefined && !isLovelace,
    });

  const submitBuilder = await signBuilder.sign();
  const unsigned = await signBuilder.toTransaction();
  const signed = new Transaction.Transaction({
    body: unsigned.body,
    witnessSet: submitBuilder.witnessSet,
    isValid: true,
    auxiliaryData: null,
  });

  return {
    transaction: Buffer.from(Transaction.toCBORBytes(signed)).toString("base64"),
    nonce: params.nonceUtxoRef,
    payer,
    nonceSnapshot: { ...nonceSnapshot, assets: { ...nonceSnapshot.assets } },
  };
}

/**
 * Converts an absolute target slot into the unix-millisecond validity bound the
 * builder expects, using the chain's slot config so the resulting TTL slot
 * matches `ttlSlot`.
 *
 * @param slot - The desired absolute TTL slot.
 * @param chain - The chain whose slot config governs the conversion.
 * @returns The unix-millisecond validity upper bound.
 */
function slotToValidityMs(slot: bigint, chain: Chain): bigint {
  // SlotConfig.zeroTime and slotLength are both in milliseconds for the
  // Evolution presets, so unixMs = zeroTime + (slot - zeroSlot) * slotLength.
  const sc = chain.slotConfig;
  return sc.zeroTime + (slot - sc.zeroSlot) * BigInt(sc.slotLength);
}
