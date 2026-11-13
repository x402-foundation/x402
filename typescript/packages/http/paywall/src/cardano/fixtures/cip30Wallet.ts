/**
 * Offline CIP-30 wallet for tests. Not part of the shipped package.
 *
 * Two payment addresses (payment index 0 and 1 of one fresh mnemonic):
 * `getUtxos()` returns CBOR `[input, output]` hex, and `signTx(cbor, partial)`
 * signs with whichever keys own the spent inputs, returning only vkey witnesses.
 */
import {
  Address,
  Assets,
  Bytes,
  CBOR,
  Client,
  PrivateKey,
  Transaction,
  TransactionHash,
  TransactionWitnessSet,
  UTxO,
  preprod,
} from "@evolution-sdk/evolution";
import type { Cip30WalletApi } from "@x402/cardano";

/** One ADA-only wallet UTXO. */
export interface TestUtxo {
  /** `txHash#index`. */
  ref: string;
  /** Which of the two wallet addresses owns it. */
  owner: 0 | 1;
  /** Lovelace held. */
  lovelace: bigint;
}

/** Recorded wallet calls. */
export interface TestWalletCalls {
  signTx: number;
  submitTx: number;
}

/**
 * Encodes an ADA-only UTXO as CIP-30 `[input, output]` CBOR hex.
 *
 * @param utxo - The UTXO.
 * @returns CBOR hex.
 */
function encodeUtxo(utxo: UTxO.UTxO): string {
  return Bytes.toHex(
    CBOR.toCBORBytes([
      [utxo.transactionId.hash, utxo.index],
      [Address.toBytes(utxo.address), utxo.assets.lovelace],
    ]),
  );
}

/**
 * Creates an offline two-address CIP-30 wallet on preprod.
 *
 * @param utxos - The wallet's UTXOs.
 * @returns The CIP-30 API and its recorded calls.
 */
export async function createTestCip30Wallet(
  utxos: TestUtxo[],
): Promise<{ api: Cip30WalletApi; calls: TestWalletCalls }> {
  const mnemonic = PrivateKey.generateMnemonic();
  const wallets = [0, 1].map(paymentIndex =>
    Client.make(preprod).withSeed({ mnemonic, paymentIndex }),
  );
  const addresses = await Promise.all(wallets.map(w => w.address()));
  const byRef = new Map<string, { utxo: UTxO.UTxO; owner: 0 | 1 }>();
  for (const spec of utxos) {
    const [hash, index] = spec.ref.split("#");
    const utxo = new UTxO.UTxO({
      transactionId: TransactionHash.fromHex(hash),
      index: BigInt(index),
      address: addresses[spec.owner],
      assets: Assets.fromLovelace(spec.lovelace),
      datumOption: undefined,
      scriptRef: undefined,
    });
    byRef.set(spec.ref.toLowerCase(), { utxo, owner: spec.owner });
  }
  const calls: TestWalletCalls = { signTx: 0, submitTx: 0 };

  const api: Cip30WalletApi = {
    getUsedAddresses: async () => addresses.map(a => Address.toHex(a)),
    getUnusedAddresses: async () => [],
    getRewardAddresses: async () => [],
    getUtxos: async () => [...byRef.values()].map(({ utxo }) => encodeUtxo(utxo)),
    async signTx(cbor) {
      calls.signTx += 1;
      const tx = Transaction.fromCBORHex(cbor);
      const owned: UTxO.UTxO[][] = [[], []];
      for (const input of tx.body.inputs) {
        const entry = byRef.get(`${Bytes.toHex(input.transactionId.hash)}#${Number(input.index)}`);
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
    signData: async () => {
      throw new Error("signData is not used by the payment signer");
    },
    submitTx: async () => {
      calls.submitTx += 1;
      throw new Error("a CIP-30 payment signer must never submit");
    },
  };
  return { api, calls };
}
