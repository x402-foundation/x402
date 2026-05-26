import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import type { WalletWithSolanaFeatures } from "@solana/wallet-standard-features";

import { getStandardConnectFeature } from "./features";
import type { WalletOption } from "./types";

type Params = {
  walletOptions: WalletOption[];
  activeWallet: WalletWithSolanaFeatures | null;
  targetChain: "solana:mainnet" | "solana:devnet";
  attemptedSilentConnectWalletsRef: MutableRefObject<Set<string>>;
  setSelectedWalletValue: (value: string) => void;
  setActiveWallet: (wallet: WalletWithSolanaFeatures | null) => void;
  setActiveAccount: (account: WalletAccount | null) => void;
  refreshBalance: (account?: WalletAccount | null) => Promise<bigint | null>;
  setStatus: (message: string) => void;
};

/**
 * Attempts a silent connection with available wallets to restore prior authorization.
 *
 * @param params - Hook parameters controlling wallet state and callbacks.
 * @param params.walletOptions - Wallets eligible for silent reconnection.
 * @param params.activeWallet - Currently active wallet, if any.
 * @param params.targetChain - Solana chain identifier targeted by the paywall.
 * @param params.attemptedSilentConnectWalletsRef - Ref tracking wallets already attempted silently.
 * @param params.setSelectedWalletValue - Setter for the currently selected wallet option.
 * @param params.setActiveWallet - Setter storing the active wallet instance.
 * @param params.setActiveAccount - Setter storing the active wallet account.
 * @param params.refreshBalance - Callback used to refresh the USDC balance.
 * @param params.setStatus - Setter used to surface user-visible status messages.
 */
export function useSilentWalletConnection({
  walletOptions,
  activeWallet,
  targetChain,
  attemptedSilentConnectWalletsRef,
  setSelectedWalletValue,
  setActiveWallet,
  setActiveAccount,
  refreshBalance,
  setStatus,
}: Params): void {
  useEffect(() => {
    if (activeWallet) {
      return;
    }

    for (const option of walletOptions) {
      if (attemptedSilentConnectWalletsRef.current.has(option.value)) {
        continue;
      }

      attemptedSilentConnectWalletsRef.current.add(option.value);
      const connectFeature = getStandardConnectFeature(option.wallet);
      if (!connectFeature) {
        continue;
      }

      void (async () => {
        try {
          const { accounts } = await connectFeature.connect({ silent: true });
          if (!accounts?.length) {
            return;
          }

          const matchingAccount =
            accounts.find((account: WalletAccount) => account.chains?.includes(targetChain)) ??
            accounts[0];
          if (!matchingAccount) {
            return;
          }

          setSelectedWalletValue(option.value);
          setActiveWallet(option.wallet);
          setActiveAccount(matchingAccount);
          setStatus("");
          await refreshBalance(matchingAccount);
        } catch {
          // Wallet may throw if silent connect isn't supported or authorization is missing. Ignore.
        }
      })();
    }
  }, [
    walletOptions,
    activeWallet,
    targetChain,
    attemptedSilentConnectWalletsRef,
    setSelectedWalletValue,
    setActiveWallet,
    setActiveAccount,
    refreshBalance,
    setStatus,
  ]);
}
