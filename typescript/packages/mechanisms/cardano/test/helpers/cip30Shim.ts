/**
 * OFFLINE CIP-30 wallet shim for tests. NOT part of the shipped package.
 *
 * Behaves like a browser wallet with two payment addresses (payment index 0 and
 * 1 of one mnemonic): `getUtxos()` returns CBOR `[input, output]` hex, and
 * `signTx(cbor, partial)` signs the body of the CBOR it receives with whichever
 * of its keys own the spent inputs, returning only a vkey witness set.
 */
import {
  Address,
  Assets,
  CBOR,
  type Chain,
  Client,
  Credential,
  PrivateKey,
  Transaction,
  TransactionHash,
  TransactionWitnessSet,
  UTxO,
  preprod,
} from "@evolution-sdk/evolution";

import type { CardanoUtxoSnapshot } from "../../src/signer";
import type { Cip30WalletApi } from "../../src/cip30";
import { snapshotAssets } from "./buildSignedTx";

/** One wallet UTxO the shim should hold. */
export interface ShimUtxoSpec {
  /** `txHash#index`. */
  ref: string;
  /** Which of the two wallet addresses owns it. */
  owner: 0 | 1;
  /** Lovelace held. */
  lovelace: bigint;
  /** Native assets as `policy.nameHex → quantity`. */
  assets?: Record<string, bigint>;
}

/** Options for {@link createCip30Shim}. */
export interface Cip30ShimOptions {
  utxos: ShimUtxoSpec[];
  /** Additional raw `getUtxos()` entries (e.g. undecodable or script-locked). */
  rawUtxoHexes?: string[];
  /** Chain the wallet lives on. Defaults to preprod. */
  chain?: Chain;
  /** Called with the CBOR hex just before signing (e.g. to advance a clock). */
  beforeSign?: (txCborHex: string) => void | Promise<void>;
}

/** Recorded calls for assertions. */
export interface Cip30ShimCalls {
  getUsedAddresses: number;
  getUtxos: number;
  signTx: Array<{ cbor: string; partial: boolean }>;
  submitTx: number;
  signData: number;
}

/** The shim plus helpers for building facilitator snapshots. */
export interface Cip30Shim {
  api: Cip30WalletApi;
  calls: Cip30ShimCalls;
  addresses: [string, string];
  paymentKeyHashes: [string, string];
  /** Facilitator-style snapshot for a shim UTxO, or undefined if unknown. */
  snapshot(ref: string): CardanoUtxoSnapshot | undefined;
}

/**
 * Encodes a shim UTxO as CIP-30 `[input, output]` CBOR hex (Shelley output).
 *
 * @param utxo - The UTxO.
 * @returns CBOR hex.
 */
export function encodeCip30Utxo(utxo: UTxO.UTxO): string {
  const multiAsset = utxo.assets.multiAsset;
  let amount: CBOR.CBOR = utxo.assets.lovelace;
  if (multiAsset) {
    const outer = new Map<CBOR.CBOR, CBOR.CBOR>();
    for (const [policyId, inner] of multiAsset.map) {
      const names = new Map<CBOR.CBOR, CBOR.CBOR>();
      for (const [assetName, qty] of inner) names.set(assetName.bytes, qty);
      outer.set(policyId.hash, names);
    }
    amount = [utxo.assets.lovelace, outer];
  }
  const bytes = CBOR.toCBORBytes([
    [utxo.transactionId.hash, utxo.index],
    [Address.toBytes(utxo.address), amount],
  ]);
  return Buffer.from(bytes).toString("hex");
}

/**
 * Encodes an arbitrary output (raw address bytes, coin, optional datum hash).
 *
 * @param txHashHex - Input transaction hash.
 * @param index - Input index.
 * @param addressBytes - Raw address bytes.
 * @param lovelace - Coin.
 * @param datumHash - Optional 32-byte datum hash.
 * @returns CBOR hex.
 */
export function encodeRawCip30Utxo(
  txHashHex: string,
  index: bigint,
  addressBytes: Uint8Array,
  lovelace: bigint,
  datumHash?: Uint8Array,
): string {
  const output: CBOR.CBOR[] = [addressBytes, lovelace];
  if (datumHash) output.push(datumHash);
  return Buffer.from(CBOR.toCBORBytes([[Buffer.from(txHashHex, "hex"), index], output])).toString(
    "hex",
  );
}

/**
 * Creates an offline two-address CIP-30 wallet.
 *
 * @param options - UTxOs and hooks.
 * @returns The shim.
 */
export async function createCip30Shim(options: Cip30ShimOptions): Promise<Cip30Shim> {
  const chain = options.chain ?? preprod;
  const mnemonic = PrivateKey.generateMnemonic();
  const wallets = [0, 1].map(paymentIndex =>
    Client.make(chain).withSeed({ mnemonic, paymentIndex }),
  );
  const addressObjects = await Promise.all(wallets.map(w => w.address()));
  const addresses = addressObjects.map(a => Address.toBech32(a)) as [string, string];
  const paymentKeyHashes = addressObjects.map(a => {
    const cred = Address.getPaymentCredential(Address.toHex(a));
    return Credential.toHex(cred!).toLowerCase();
  }) as [string, string];

  const byRef = new Map<string, { utxo: UTxO.UTxO; owner: 0 | 1 }>();
  for (const spec of options.utxos) {
    const [hash, idx] = spec.ref.split("#");
    let assets = Assets.fromLovelace(spec.lovelace);
    for (const [unit, qty] of Object.entries(spec.assets ?? {})) {
      const [policy, name] = unit.split(".");
      assets = Assets.addByHex(assets, policy, name, qty);
    }
    const utxo = new UTxO.UTxO({
      transactionId: TransactionHash.fromHex(hash),
      index: BigInt(idx),
      address: addressObjects[spec.owner],
      assets,
      datumOption: undefined,
      scriptRef: undefined,
    });
    byRef.set(spec.ref.toLowerCase(), { utxo, owner: spec.owner });
  }

  const calls: Cip30ShimCalls = {
    getUsedAddresses: 0,
    getUtxos: 0,
    signTx: [],
    submitTx: 0,
    signData: 0,
  };

  const api: Cip30WalletApi = {
    async getUsedAddresses() {
      calls.getUsedAddresses += 1;
      return addressObjects.map(a => Address.toHex(a));
    },
    async getUnusedAddresses() {
      return [];
    },
    async getRewardAddresses() {
      return [];
    },
    async getUtxos() {
      calls.getUtxos += 1;
      return [
        ...[...byRef.values()].map(({ utxo }) => encodeCip30Utxo(utxo)),
        ...(options.rawUtxoHexes ?? []),
      ];
    },
    async signTx(cbor, partial) {
      calls.signTx.push({ cbor, partial });
      await options.beforeSign?.(cbor);
      const tx = Transaction.fromCBORHex(cbor);
      const owned: Array<UTxO.UTxO[]> = [[], []];
      for (const input of tx.body.inputs) {
        const ref = `${Buffer.from(input.transactionId.hash).toString("hex")}#${Number(input.index)}`;
        const entry = byRef.get(ref);
        if (entry) owned[entry.owner].push(entry.utxo);
      }
      const vkeyWitnesses = [];
      for (const owner of [0, 1] as const) {
        if (owned[owner].length === 0) continue;
        const ws = await wallets[owner].signTx(cbor, { utxos: owned[owner] });
        vkeyWitnesses.push(...(ws.vkeyWitnesses ?? []));
      }
      return TransactionWitnessSet.toCBORHex(
        new TransactionWitnessSet.TransactionWitnessSet({ vkeyWitnesses }),
      );
    },
    async signData() {
      calls.signData += 1;
      throw new Error("signData is not used by the payment signer");
    },
    async submitTx() {
      calls.submitTx += 1;
      throw new Error("a CIP-30 payment signer must never submit");
    },
  };

  return {
    api,
    calls,
    addresses,
    paymentKeyHashes,
    snapshot(ref) {
      const entry = byRef.get(ref.toLowerCase());
      if (!entry) return undefined;
      const assets = snapshotAssets(entry.utxo.assets);
      return {
        exists: true,
        address: addresses[entry.owner],
        coin: entry.utxo.assets.lovelace,
        assets,
        paymentKeyHash: paymentKeyHashes[entry.owner],
      };
    },
  };
}
