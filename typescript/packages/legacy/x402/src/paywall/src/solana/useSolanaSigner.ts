import { useMemo } from "react";
import {
  getTransactionDecoder,
  getTransactionEncoder,
  type SignatureDictionary,
  type TransactionSigner,
  address as toAddress,
} from "@solana/kit";
import type { WalletAccount } from "@wallet-standard/base";
import type { WalletWithSolanaFeatures } from "@solana/wallet-standard-features";

import { getSolanaSignTransactionFeature } from "./features";

type Params = {
  activeWallet: WalletWithSolanaFeatures | null;
  activeAccount: WalletAccount | null;
  targetChain: "solana:mainnet" | "solana:devnet";
};

/**
 * Derives a transaction signer that proxies requests to the connected Solana wallet.
 *
 * @param params - Hook parameters defining the active wallet/account and chain target.
 * @param params.activeWallet - Wallet currently selected by the user.
 * @param params.activeAccount - Account inside the wallet authorised for signing.
 * @param params.targetChain - Identifier of the Solana cluster to sign transactions for.
 * @returns A transaction signer or null when the wallet cannot sign.
 */
export function useSolanaSigner({
  activeWallet,
  activeAccount,
  targetChain,
}: Params): TransactionSigner<string> | null {
  return useMemo(() => {
    if (!activeWallet || !activeAccount) {
      return null;
    }

    const signFeature = getSolanaSignTransactionFeature(activeWallet);
    if (!signFeature) {
      return null;
    }

    const signerAddress = toAddress(activeAccount.address);
    const encoder = getTransactionEncoder();
    const decoder = getTransactionDecoder();

    return {
      address: signerAddress,
      async signTransactions(transactions) {
        const signatures: SignatureDictionary[] = [];

        for (const transaction of transactions) {
          const serialized = new Uint8Array(encoder.encode(transaction));
          const [signed] = await signFeature.signTransaction({
            account: activeAccount,
            transaction: serialized,
            chain: targetChain,
          });

          const decodedTransaction = decoder.decode(new Uint8Array(signed.signedTransaction));
          const signature = decodedTransaction.signatures[signerAddress];

          if (!signature) {
            throw new Error("Wallet did not return a signature for the selected account.");
          }

          signatures.push(
            Object.freeze({
              [signerAddress]: signature,
            }) as SignatureDictionary,
          );
        }

        return signatures;
      },
    };
  }, [activeWallet, activeAccount, targetChain]);
}
