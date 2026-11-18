import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import type { WalletAccount } from "@wallet-standard/base";
import type { PaymentRequired } from "@x402/core/types";
import { getAlgodClient } from "./rpc";

type Params = {
  activeAccount: WalletAccount | null;
  paymentRequired: PaymentRequired;
  onStatus: (message: string) => void;
};

type BalanceState = {
  usdcBalance: bigint | null;
  formattedBalance: string;
  isFetchingBalance: boolean;
  refreshBalance: (account?: WalletAccount | null) => Promise<bigint | null>;
  resetBalance: () => void;
};

/**
 * Tracks and refreshes the Algorand USDC balance for the active account.
 *
 * @param params - Hook parameters containing account details and callbacks.
 * @param params.activeAccount - Wallet account whose balance is being tracked.
 * @param params.paymentRequired - Payment required response with accepts array.
 * @param params.onStatus - Callback for reporting status messages to the UI.
 * @returns Balance state and helper methods for refreshing/resetting data.
 */
export function useAlgorandBalance({
  activeAccount,
  paymentRequired,
  onStatus,
}: Params): BalanceState {
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [formattedBalance, setFormattedBalance] = useState<string>("");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);

  const firstRequirement = paymentRequired.accepts[0];

  const resetBalance = useCallback(() => {
    setUsdcBalance(null);
    setFormattedBalance("");
  }, []);

  const refreshBalance = useCallback(
    async (account: WalletAccount | null = activeAccount) => {
      if (!account || !firstRequirement) {
        resetBalance();
        return null;
      }

      try {
        setIsFetchingBalance(true);

        const algodClient = getAlgodClient(firstRequirement.network);
        const assetId = parseInt(firstRequirement.asset);

        // Get account info to find the asset holding
        const accountInfo = await algodClient.accountInformation(account.address);

        const assets = accountInfo.assets || [];

        // Find the USDC asset holding
        const assetHolding = assets.find(
          (a: { assetId: bigint; amount: bigint }) => Number(a.assetId) === assetId,
        );

        // Get decimals from asset info
        const decimals =
          (firstRequirement.extra as { decimals?: number } | undefined)?.decimals ?? 6;

        const balance = assetHolding ? BigInt(assetHolding.amount) : 0n;

        setUsdcBalance(balance);
        setFormattedBalance(formatUnits(balance, decimals));
        return balance;
      } catch (error) {
        console.error("Failed to fetch Algorand USDC balance", error);
        onStatus("Unable to read your USDC balance. Please retry.");
        resetBalance();
        return null;
      } finally {
        setIsFetchingBalance(false);
      }
    },
    [activeAccount, firstRequirement, onStatus, resetBalance],
  );

  useEffect(() => {
    if (activeAccount) {
      void refreshBalance();
    }
  }, [activeAccount, refreshBalance]);

  return {
    usdcBalance,
    formattedBalance,
    isFetchingBalance,
    refreshBalance,
    resetBalance,
  };
}
