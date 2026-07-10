import type { SubmittableTransaction, Wallet } from "xrpl";
import type { ClientXrplSigner } from "./types";

/**
 * Creates a client signer adapter from an xrpl.js Wallet.
 *
 * @param wallet - XRPL wallet
 * @returns x402 XRPL client signer
 */
export function createXrplWalletSigner(wallet: Wallet): ClientXrplSigner {
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
