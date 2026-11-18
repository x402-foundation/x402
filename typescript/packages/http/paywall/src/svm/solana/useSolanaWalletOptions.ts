import { useEffect, useState } from "react";
import { getWallets } from "@wallet-standard/app";

import { hasSolanaSigning } from "./features";
import type { WalletOption } from "./types";

/**
 * Subscribes to wallet-standard registrations and collects Solana-capable wallets.
 *
 * @returns Wallet options suitable for Solana interactions.
 */
export function useSolanaWalletOptions(): WalletOption[] {
  const [walletOptions, setWalletOptions] = useState<WalletOption[]>([]);

  useEffect(() => {
    const walletsApi = getWallets();

    const mapWallets = (): WalletOption[] =>
      walletsApi
        .get()
        .filter(hasSolanaSigning)
        .map(wallet => ({
          value: wallet.name,
          wallet,
        }));

    setWalletOptions(mapWallets());

    const offRegister = walletsApi.on("register", () => {
      setWalletOptions(mapWallets());
    });
    const offUnregister = walletsApi.on("unregister", () => {
      setWalletOptions(mapWallets());
    });

    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  return walletOptions;
}
