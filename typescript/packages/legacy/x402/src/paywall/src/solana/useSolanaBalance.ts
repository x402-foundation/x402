import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import type { WalletAccount } from "@wallet-standard/base";
import type { PaymentRequirements } from "../../../types/verify";
import { getRpcClient } from "../../../shared/svm/rpc";
import type { Address } from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeToken as fetchMaybeSplToken,
} from "@solana-program/token";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMaybeToken as fetchMaybeToken2022,
  fetchMint,
  findAssociatedTokenPda,
} from "@solana-program/token-2022";
import { address as toAddress } from "@solana/kit";

type Params = {
  activeAccount: WalletAccount | null;
  paymentRequirement: PaymentRequirements;
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
 * Tracks and refreshes the Solana USDC balance for the active account.
 *
 * @param params - Hook parameters containing account details and callbacks.
 * @param params.activeAccount - Wallet account whose balance is being tracked.
 * @param params.paymentRequirement - Payment requirement describing the asset to monitor.
 * @param params.onStatus - Callback for reporting status messages to the UI.
 * @returns Balance state and helper methods for refreshing/resetting data.
 */
export function useSolanaBalance({
  activeAccount,
  paymentRequirement,
  onStatus,
}: Params): BalanceState {
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [formattedBalance, setFormattedBalance] = useState<string>("");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);

  const resetBalance = useCallback(() => {
    setUsdcBalance(null);
    setFormattedBalance("");
  }, []);

  const refreshBalance = useCallback(
    async (account: WalletAccount | null = activeAccount) => {
      if (!account) {
        resetBalance();
        return null;
      }

      try {
        setIsFetchingBalance(true);

        const rpc = getRpcClient(paymentRequirement.network);
        const mint = await fetchMint(rpc, paymentRequirement.asset as Address);
        const tokenProgramAddress = mint.programAddress;
        const [ata] = await findAssociatedTokenPda({
          mint: paymentRequirement.asset as Address,
          owner: toAddress(account.address),
          tokenProgram: tokenProgramAddress,
        });

        let balance = 0n;
        if (tokenProgramAddress.toString() === TOKEN_PROGRAM_ADDRESS.toString()) {
          const tokenAccount = await fetchMaybeSplToken(rpc, ata);
          if (tokenAccount.exists) {
            balance = tokenAccount.data.amount;
          }
        } else if (tokenProgramAddress.toString() === TOKEN_2022_PROGRAM_ADDRESS.toString()) {
          const tokenAccount = await fetchMaybeToken2022(rpc, ata);
          if (tokenAccount.exists) {
            balance = tokenAccount.data.amount;
          }
        }

        setUsdcBalance(balance);
        setFormattedBalance(formatUnits(balance, mint.data.decimals));
        return balance;
      } catch (error) {
        console.error("Failed to fetch Solana USDC balance", error);
        onStatus("Unable to read your USDC balance. Please retry.");
        resetBalance();
        return null;
      } finally {
        setIsFetchingBalance(false);
      }
    },
    [activeAccount, paymentRequirement, onStatus, resetBalance],
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
