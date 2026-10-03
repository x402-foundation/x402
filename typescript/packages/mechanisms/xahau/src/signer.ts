import type { SubmittableTransaction, Wallet } from "xahau";
import type { ClientXahauSigner } from "./types";

/**
 * Creates a client signer adapter from an xahau.js Wallet.
 *
 * @param wallet - Xahau wallet
 * @returns x402 Xahau client signer
 */
export function createXahauWalletSigner(wallet: Wallet): ClientXahauSigner {
  return {
    classicAddress: wallet.classicAddress,
    sign: (transaction: SubmittableTransaction) => {
      const signed = wallet.sign(transaction);
      return {
        signedTxBlob: signed.tx_blob,
        hash: signed.hash,
      };
    },
  };
}
