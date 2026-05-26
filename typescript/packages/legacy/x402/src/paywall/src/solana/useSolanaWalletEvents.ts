import { useEffect } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import type { WalletWithSolanaFeatures } from "@solana/wallet-standard-features";

import { SolanaSignTransaction } from "@solana/wallet-standard-features";

import { getStandardEventsFeature, type StandardEventsChangeProperties } from "./features";

type Params = {
  activeWallet: WalletWithSolanaFeatures | null;
  targetChain: "solana:mainnet" | "solana:devnet";
  chainName: string;
  setActiveWallet: (wallet: WalletWithSolanaFeatures | null) => void;
  setActiveAccount: (account: WalletAccount | null) => void;
  setSelectedWalletValue: (value: string) => void;
  setStatus: (status: string) => void;
  resetBalance: () => void;
  refreshBalance: (account?: WalletAccount | null) => Promise<bigint | null>;
};

/**
 * Listens for wallet-standard change events and keeps local state in sync.
 *
 * @param params - Hook parameters describing wallet state handlers and dependencies.
 * @param params.activeWallet - Wallet currently active in the UI.
 * @param params.targetChain - Chain identifier expected for the session.
 * @param params.chainName - Human-readable name of the active chain.
 * @param params.setActiveWallet - Setter used to store the active wallet.
 * @param params.setActiveAccount - Setter used to store the active account.
 * @param params.setSelectedWalletValue - Setter for the selected wallet option value.
 * @param params.setStatus - Setter for user-facing status messages.
 * @param params.resetBalance - Helper to clear cached balance state.
 * @param params.refreshBalance - Function that refreshes the cached balance.
 */
export function useSolanaWalletEvents({
  activeWallet,
  targetChain,
  chainName,
  setActiveWallet,
  setActiveAccount,
  setSelectedWalletValue,
  setStatus,
  resetBalance,
  refreshBalance,
}: Params): void {
  useEffect(() => {
    if (!activeWallet) {
      return;
    }

    const eventsFeature = getStandardEventsFeature(activeWallet);
    if (!eventsFeature) {
      return;
    }

    const unsubscribe = eventsFeature.on("change", (properties: StandardEventsChangeProperties) => {
      if (properties.features && !(SolanaSignTransaction in properties.features)) {
        setActiveWallet(null);
        setActiveAccount(null);
        setSelectedWalletValue("");
        resetBalance();
        setStatus("Selected wallet no longer supports Solana signing. Please reconnect.");
        return;
      }

      if (properties.accounts) {
        if (!properties.accounts.length) {
          setActiveAccount(null);
          resetBalance();
          setStatus("Wallet disconnected. Select a wallet to reconnect.");
          return;
        }

        const nextAccount =
          properties.accounts.find((account: WalletAccount) =>
            account.chains?.includes(targetChain),
          ) ??
          properties.accounts[0] ??
          null;

        setActiveAccount(nextAccount);

        if (!nextAccount) {
          setStatus("No authorized Solana accounts available. Reconnect your wallet.");
          resetBalance();
          return;
        }

        if (nextAccount.chains?.includes(targetChain)) {
          setStatus("");
        } else {
          setStatus(`Switch your wallet to ${chainName} to continue.`);
        }

        void refreshBalance(nextAccount);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    activeWallet,
    targetChain,
    chainName,
    setActiveWallet,
    setActiveAccount,
    setSelectedWalletValue,
    setStatus,
    resetBalance,
    refreshBalance,
  ]);
}
