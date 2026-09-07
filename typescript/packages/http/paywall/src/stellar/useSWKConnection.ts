import { useCallback, useEffect, useRef, useState } from "react";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { KleverModule } from "@creit.tech/stellar-wallets-kit/modules/klever";
import { OneKeyModule } from "@creit.tech/stellar-wallets-kit/modules/onekey";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";
import type { Network } from "@x402/core/types";
import { getNetworkPassphrase } from "@x402/stellar";
import { parseError } from "./utils";
import { statusClear, statusError, statusInfo, type Status } from "./status";

export type UseSWKConnectionParams = {
  network: Network;
  onStatus: (status: Status | null) => void;
};

export type UseSWKConnectionReturn = {
  kitReady: boolean;
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
};

/**
 * Manages Stellar Wallet Kit connection state.
 *
 * @param params - Hook parameters.
 * @param params.network - Network to connect to (CAIP-2 format).
 * @param params.onStatus - Callback for status messages.
 * @returns Connection state and methods.
 */
export function useSWKConnection({
  network,
  onStatus,
}: UseSWKConnectionParams): UseSWKConnectionReturn {
  const [kitReady, setKitReady] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onStatusRef.current = onStatus;
  });

  useEffect(() => {
    try {
      const networkPassphrase = getNetworkPassphrase(network);
      StellarWalletsKit.init({
        network: networkPassphrase as Networks,
        modules: [new FreighterModule(), new HanaModule(), new KleverModule(), new OneKeyModule()],
      });

      setKitReady(true);
    } catch (error) {
      console.error("Failed to initialize Stellar Wallet Kit", error);
      onStatusRef.current(
        statusError(parseError(error, "Failed to initialize Stellar Wallet Kit.")),
      );
    }
  }, [network]);

  const connect = useCallback(async () => {
    if (!kitReady) {
      onStatusRef.current(statusError("Wallet kit is not ready."));
      return;
    }

    try {
      onStatusRef.current(statusInfo("Connecting to wallet..."));

      const { address: walletAddress } = await StellarWalletsKit.authModal();

      if (!walletAddress) {
        throw new Error("Failed to get wallet address.");
      }

      const { networkPassphrase: swkNetworkPassphrase } = await StellarWalletsKit.getNetwork();
      if (!swkNetworkPassphrase) {
        throw new Error("Failed to get SWK's wallet network passphrase.");
      }

      const desiredNetworkPassphrase = getNetworkPassphrase(network);
      if (swkNetworkPassphrase !== desiredNetworkPassphrase) {
        const networkName = network === "stellar:pubnet" ? "Mainnet" : "Testnet";
        throw new Error(`Please switch your wallet to ${networkName} network, then try again.`);
      }

      setAddress(walletAddress);
      onStatusRef.current(statusClear());
    } catch (error) {
      console.error("Failed to connect wallet", error);
      onStatusRef.current(statusError(parseError(error, "Failed to connect to wallet.")));
      setAddress(null);
    }
  }, [kitReady, network]);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch (error) {
      console.error("Failed to disconnect wallet", error);
    }
    setAddress(null);
  }, []);

  return {
    kitReady,
    address,
    connect,
    disconnect,
  };
}
