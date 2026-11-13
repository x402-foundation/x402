import {
  Address,
  AddressEras,
  Assets,
  Bytes,
  CBOR,
  type Transaction,
  TransactionInput,
  TransactionOutput,
  UTxO,
} from "@evolution-sdk/evolution";

import { Cip30SignerError } from "./errors";

/** One output of an Evolution transaction body. */
export type Cip30TxOutput = Transaction.Transaction["body"]["outputs"][number];

/** Anything that names a transaction output: a transaction input or a UTXO. */
interface OutputPointer {
  readonly transactionId: { readonly hash: Uint8Array };
  readonly index: bigint | number;
}

/**
 * Formats a transaction input or UTXO as its canonical lowercase `txHash#index` reference.
 *
 * @param input - The input or UTXO.
 * @returns The reference string.
 */
export function inputRef(input: OutputPointer): string {
  return `${Bytes.toHex(input.transactionId.hash)}#${Number(input.index)}`;
}

/**
 * Whether an output carries a datum (hash or inline) or a reference script.
 *
 * @param output - Transaction output.
 * @returns True when the output is anything but a plain value transfer.
 */
export function outputCarriesScriptData(
  output: Cip30TxOutput | TransactionOutput.TransactionOutput,
): boolean {
  const o = output as unknown as {
    datumOption?: unknown;
    datumHash?: unknown;
    scriptRef?: unknown;
  };
  return o.datumOption !== undefined || o.datumHash !== undefined || o.scriptRef !== undefined;
}

/**
 * Decodes one CIP-30 `getUtxos()` entry (CBOR `[input, output]`) into a UTXO
 * the payer may spend, or `undefined` when it must not enter the pool:
 * undecodable, Byron/pointer/script-credential address, another network, or
 * carrying a datum or reference script.
 *
 * Unlike the SDK's own decoder this never throws, so one exotic UTXO in the
 * wallet cannot make the whole wallet unusable.
 *
 * @param hex - CBOR hex from the wallet.
 * @param networkId - Expected network id (0 testnets, 1 mainnet).
 * @returns The spendable UTXO, or undefined.
 */
export function decodeCip30PoolUtxo(hex: string, networkId: number): UTxO.UTxO | undefined {
  try {
    const decoded = CBOR.fromCBORHex(hex);
    if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
    const input = TransactionInput.fromCBORBytes(CBOR.toCBORBytes(decoded[0]));
    const output = TransactionOutput.fromCBORBytes(CBOR.toCBORBytes(decoded[1]));
    if (outputCarriesScriptData(output)) return undefined;
    // Base/enterprise only: Address.fromBytes rejects Byron, pointer and reward.
    const address = Address.fromBytes(AddressEras.toBytes(output.address));
    if (address.paymentCredential._tag !== "KeyHash") return undefined;
    if (address.networkId !== networkId) return undefined;
    const amount = output.amount;
    const assets =
      amount._tag === "WithAssets"
        ? Assets.withMultiAsset(amount.coin, amount.assets)
        : Assets.fromLovelace(amount.coin);
    return new UTxO.UTxO({
      transactionId: input.transactionId,
      index: input.index,
      address,
      assets,
      datumOption: undefined,
      scriptRef: undefined,
    });
  } catch {
    return undefined;
  }
}

/**
 * Builds the spendable pool from raw CIP-30 UTXOs.
 *
 * @param hexes - `getUtxos()` result.
 * @param networkId - Expected network id.
 * @returns Spendable UTXOs, de-duplicated by reference.
 */
export function buildCip30Pool(hexes: ReadonlyArray<string>, networkId: number): UTxO.UTxO[] {
  const seen = new Set<string>();
  const pool: UTxO.UTxO[] = [];
  for (const hex of hexes) {
    const utxo = decodeCip30PoolUtxo(hex, networkId);
    if (!utxo) continue;
    const ref = inputRef(utxo);
    if (seen.has(ref)) continue;
    seen.add(ref);
    pool.push(utxo);
  }
  return pool;
}

/**
 * Picks the nonce UTXO. A pinned nonce always wins and must still be in the
 * pool; otherwise the choice is deterministic regardless of wallet ordering:
 * ADA-only UTXOs first, then by `txHash` ascending, then `index` ascending.
 *
 * @param pool - Spendable UTXOs.
 * @param pinnedRef - Nonce pinned by an earlier attempt of the same payment.
 * @returns The nonce UTXO.
 */
export function chooseCip30Nonce(pool: ReadonlyArray<UTxO.UTxO>, pinnedRef?: string): UTxO.UTxO {
  if (pinnedRef !== undefined) {
    const wanted = pinnedRef.toLowerCase();
    const pinned = pool.find(utxo => inputRef(utxo) === wanted);
    if (!pinned) {
      throw new Cip30SignerError(
        "pinned_nonce_missing",
        "The wallet no longer lists the funds this payment was signed with",
      );
    }
    return pinned;
  }
  if (pool.length === 0) {
    throw new Cip30SignerError(
      "no_spendable_utxo",
      "The wallet has no plain ADA funds on this network that can pay",
    );
  }
  const ranked = [...pool].sort((a, b) => {
    const aHasTokens = a.assets.multiAsset === undefined ? 0 : 1;
    const bHasTokens = b.assets.multiAsset === undefined ? 0 : 1;
    if (aHasTokens !== bHasTokens) return aHasTokens - bHasTokens;
    const aHash = Bytes.toHex(a.transactionId.hash);
    const bHash = Bytes.toHex(b.transactionId.hash);
    if (aHash !== bHash) return aHash < bHash ? -1 : 1;
    return Number(a.index - b.index);
  });
  return ranked[0];
}
