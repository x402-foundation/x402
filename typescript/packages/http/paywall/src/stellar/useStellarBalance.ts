import { useCallback, useEffect, useState } from "react";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import type { Network } from "@x402/core/types";
import { getNetworkPassphrase, getRpcUrl } from "@x402/stellar";
import { formatUnits, getRuntimeRpcUrl, parseError } from "./utils";
import { statusError, type Status } from "./status";

export type UseBalanceParams = {
  address: string | null;
  network: Network;
  asset: string;
  onStatus: (status: Status | null) => void;
};

export type AssetMetadata = {
  code: string;
  issuer: string;
};

export type UseBalanceReturn = {
  isFetchingBalance: boolean;
  tokenBalanceRaw: bigint | null;
  tokenBalanceFormatted: string;
  isMissingTrustline: boolean | null;
  assetMetadata: AssetMetadata | null;
  refreshBalance: () => Promise<string>;
  resetBalance: () => void;
};

/**
 * Tracks and refreshes the Stellar USDC balance for the active account.
 *
 * @param params - Hook parameters containing account details and callbacks.
 * @param params.address - Wallet address whose balance is being tracked.
 * @param params.network - Network to fetch the balance from (CAIP-2 format).
 * @param params.asset - Asset contract address to fetch the balance of.
 * @param params.onStatus - Callback for reporting status messages to the UI.
 * @returns Balance state and helper methods for refreshing/resetting data.
 */
export function useStellarBalance({
  address,
  network,
  asset,
  onStatus,
}: UseBalanceParams): UseBalanceReturn {
  const runtimeRpcUrl = getRuntimeRpcUrl();
  const [tokenBalanceRaw, setTokenBalanceRaw] = useState<bigint | null>(null);
  const [tokenBalanceFormatted, setTokenBalanceFormatted] = useState<string>("");
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);
  const [isMissingTrustline, setIsMissingTrustline] = useState<boolean | null>(null);
  const [assetMetadata, setAssetMetadata] = useState<AssetMetadata | null>(null);

  const resetBalance = useCallback(() => {
    setTokenBalanceRaw(null);
    setTokenBalanceFormatted("");
  }, []);

  /**
   * Fetches SAC metadata (asset code and issuer) by simulating `name()` on the
   * asset contract to get `"<code>:<issuer>"`
   */
  const fetchAssetMetadata = useCallback(async (): Promise<void> => {
    const networkPassphrase = getNetworkPassphrase(network);
    const rpcUrl = getRpcUrl(network, { url: runtimeRpcUrl });

    try {
      const nameTx = await AssembledTransaction.build({
        contractId: asset,
        method: "name",
        networkPassphrase,
        rpcUrl,
        parseResultXdr: result => result,
      });

      if (!nameTx.result) {
        return;
      }

      // SAC name() returns "<code>:<issuer>" for issued assets, "native" for XLM
      const name = scValToNative(nameTx.result) as string;
      const parts = name.split(":");

      if (parts.length === 2) {
        setAssetMetadata({ code: parts[0], issuer: parts[1] });
      }
    } catch (error) {
      console.error("Failed to fetch SAC metadata", error);
    }
  }, [network, asset, runtimeRpcUrl]);

  const refreshBalance = useCallback(async (): Promise<string> => {
    if (!address) {
      resetBalance();
      return "";
    }

    setIsFetchingBalance(true);
    setIsMissingTrustline(null);
    setAssetMetadata(null);

    try {
      const networkPassphrase = getNetworkPassphrase(network);
      const rpcUrl = getRpcUrl(network, { url: runtimeRpcUrl });
      const contractId = asset;

      // Simulate to fetch the balance and decimals in parallel
      const [balanceTx, decimalsTx] = await Promise.all([
        AssembledTransaction.build({
          contractId,
          method: "balance",
          args: [nativeToScVal(address, { type: "address" })],
          networkPassphrase,
          rpcUrl,
          parseResultXdr: result => result,
        }),
        AssembledTransaction.build({
          contractId,
          method: "decimals",
          networkPassphrase,
          rpcUrl,
          parseResultXdr: result => result,
        }),
      ]);

      await Promise.all([balanceTx.simulate(), decimalsTx.simulate()]);

      if (!balanceTx.result) {
        throw new Error("Balance simulation failed");
      }
      if (!decimalsTx.result) {
        throw new Error("Decimals simulation failed");
      }

      const balanceRaw = scValToNative(balanceTx.result) as bigint;
      const decimals = scValToNative(decimalsTx.result) as number;

      // Format the balance
      const balanceFormatted = formatUnits(balanceRaw, decimals);

      setTokenBalanceRaw(balanceRaw);
      setTokenBalanceFormatted(balanceFormatted);
      setIsMissingTrustline(false);
      return balanceFormatted;
    } catch (error) {
      console.error("Failed to fetch Stellar USDC balance", error);
      const msg = parseError(error, "Unable to read balance. Please retry.");
      const isTrustlineError = msg.includes("trustline entry is missing for account");
      if (isTrustlineError) {
        setIsMissingTrustline(true);
        fetchAssetMetadata();
      } else {
        onStatus(statusError(msg));
      }
      resetBalance();
      return "";
    } finally {
      setIsFetchingBalance(false);
    }
  }, [address, network, asset, onStatus, resetBalance, fetchAssetMetadata, runtimeRpcUrl]);

  useEffect(() => {
    if (address) {
      void refreshBalance();
    }
  }, [address, refreshBalance]);

  return {
    isMissingTrustline,
    assetMetadata,
    isFetchingBalance,
    tokenBalanceRaw,
    tokenBalanceFormatted,
    refreshBalance,
    resetBalance,
  };
}
