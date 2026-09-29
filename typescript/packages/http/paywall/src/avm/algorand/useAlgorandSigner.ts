import { useMemo } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import type { ClientAvmSigner } from "@x402/avm";

import { getAlgorandSignTransactionFeature } from "./features";
import type { WalletWithAvmFeatures } from "./types";

type Params = {
  activeWallet: WalletWithAvmFeatures | null;
  activeAccount: WalletAccount | null;
};

/**
 * Derives a transaction signer that proxies requests to the connected Algorand wallet.
 *
 * @param params - Hook parameters defining the active wallet/account.
 * @param params.activeWallet - Wallet currently selected by the user.
 * @param params.activeAccount - Account inside the wallet authorised for signing.
 * @returns A transaction signer or null when the wallet cannot sign.
 */
export function useAlgorandSigner({ activeWallet, activeAccount }: Params): ClientAvmSigner | null {
  return useMemo(() => {
    if (!activeWallet || !activeAccount) {
      return null;
    }

    const signFeature = getAlgorandSignTransactionFeature(activeWallet);
    if (!signFeature) {
      return null;
    }

    return {
      address: activeAccount.address,
      async signTransactions(txns: Uint8Array[], indexesToSign?: number[]) {
        const result = await signFeature.signTransaction({
          txns,
          indexesToSign,
        });
        return result;
      },
    };
  }, [activeWallet, activeAccount]);
}
