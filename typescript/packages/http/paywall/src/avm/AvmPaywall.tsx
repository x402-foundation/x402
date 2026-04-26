import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { WalletManager } from "@txnlab/use-wallet";
import type { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";

import { ExactAvmScheme } from "@x402/avm/exact/client";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";

import { Spinner } from "./Spinner";
import { getNetworkDisplayName, ALGORAND_NETWORK_REFS } from "../paywallUtils";
import { getAlgodClient } from "./algorand/rpc";

type AvmPaywallProps = {
  paymentRequired: PaymentRequired;
  walletManager?: WalletManager;
  algorandClient?: AlgorandClient;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

/**
 * Paywall experience for Algorand networks using @txnlab/use-wallet.
 *
 * Supports Pera, Defly, and Lute wallets.
 *
 * @param props - Component props.
 * @param props.paymentRequired - Payment required response with accepts array.
 * @param props.walletManager - WalletManager instance from use-wallet.
 * @param props.algorandClient - Optional AlgorandClient instance for network connectivity.
 * @param props.onSuccessfulResponse - Callback invoked on successful 402 response.
 * @returns JSX element.
 */
export function AvmPaywall({
  paymentRequired,
  walletManager,
  algorandClient,
  onSuccessfulResponse,
}: AvmPaywallProps) {
  // WalletManager is required for AVM paywall — when used from the shared PaywallApp
  // without AVM-specific initialization, show a setup message
  if (!walletManager) {
    return (
      <div className="container">
        <div className="header">
          <h1 className="title">Payment Required</h1>
          <p>Algorand wallet support requires the AVM-specific paywall entry point.</p>
        </div>
      </div>
    );
  }

  const [status, setStatus] = useState<string>("");
  const [isPaying, setIsPaying] = useState(false);
  const [hideBalance, setHideBalance] = useState(true);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [isFetchingBalance, setIsFetchingBalance] = useState(false);
  const [selectedWalletId, setSelectedWalletId] = useState<string>("");

  // Subscribe to wallet manager state changes using useSyncExternalStore
  // This triggers re-renders when state changes
  useSyncExternalStore(
    callback => walletManager.subscribe(callback),
    () => walletManager.store.state,
    () => walletManager.store.state,
  );

  // In use-wallet v4, use the getters from walletManager after state change triggers re-render
  const wallets = walletManager.wallets;
  const activeWallet = walletManager.activeWallet;
  const activeAccount = walletManager.activeAccount;

  const x402 = window.x402;
  const amount = x402.amount;

  const firstRequirement = paymentRequired.accepts[0];
  if (!firstRequirement) {
    throw new Error("No payment requirements in paymentRequired.accepts");
  }

  const network = firstRequirement.network;
  const chainName = getNetworkDisplayName(network);
  const isTestnet = network.includes(ALGORAND_NETWORK_REFS.TESTNET);

  // Get USDC ASA ID based on network
  const usdcAsaId = firstRequirement.asset
    ? parseInt(firstRequirement.asset as string, 10)
    : isTestnet
      ? 10458941
      : 31566704;

  // Format balance for display
  const formattedBalance =
    usdcBalance !== null ? (Number(usdcBalance) / 1_000_000).toFixed(2) : null;

  // Fetch USDC balance for connected account
  const refreshBalance = useCallback(async () => {
    if (!activeAccount?.address) {
      return null;
    }

    setIsFetchingBalance(true);
    try {
      const algod = getAlgodClient(network);
      const accountInfo = await algod.accountInformation(activeAccount.address);
      const assets = accountInfo.assets || [];
      const usdcAsset = assets.find(
        (asset: { assetId: bigint }) => Number(asset.assetId) === usdcAsaId,
      );
      const balance = usdcAsset ? BigInt(usdcAsset.amount) : BigInt(0);
      setUsdcBalance(balance);
      return balance;
    } catch (error) {
      console.error("Failed to fetch balance:", error);
      setUsdcBalance(null);
      return null;
    } finally {
      setIsFetchingBalance(false);
    }
  }, [activeAccount?.address, network, usdcAsaId]);

  // Refresh balance when account changes
  useEffect(() => {
    if (activeAccount?.address) {
      refreshBalance();
    } else {
      setUsdcBalance(null);
    }
  }, [activeAccount?.address, refreshBalance]);

  // Auto-select first wallet if only one available
  useEffect(() => {
    if (!selectedWalletId && wallets.length === 1) {
      setSelectedWalletId(wallets[0].id);
    }
  }, [wallets, selectedWalletId]);

  // Handle wallet connection
  const handleConnect = useCallback(async () => {
    const wallet = wallets.find(w => w.id === selectedWalletId);
    if (!wallet) {
      setStatus("Select an Algorand wallet to continue.");
      return;
    }

    try {
      setStatus("Connecting to wallet...");
      await wallet.connect();
      setStatus("");
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      setStatus(error instanceof Error ? error.message : "Failed to connect wallet.");
    }
  }, [wallets, selectedWalletId]);

  // Handle wallet disconnection
  const handleDisconnect = useCallback(async () => {
    if (activeWallet) {
      try {
        await activeWallet.disconnect();
      } catch (error) {
        console.error("Failed to disconnect:", error);
      }
    }
    setUsdcBalance(null);
    setStatus("");
  }, [activeWallet]);

  // Handle payment
  const handlePayment = useCallback(async () => {
    if (!x402 || !activeAccount?.address || !activeWallet) {
      setStatus("Connect an Algorand wallet before paying.");
      return;
    }

    setIsPaying(true);

    try {
      // Check balance first
      if (usdcBalance === null || usdcBalance === 0n) {
        setStatus("Checking USDC balance...");
        const latestBalance = await refreshBalance();
        if (!latestBalance || latestBalance === 0n) {
          throw new Error(`Insufficient balance. Make sure you have USDC on ${chainName}.`);
        }
      }

      setStatus("Creating payment signature...");

      // Create signer that wraps the wallet's signTransactions function
      const walletSigner = {
        address: activeAccount.address,
        signTransactions: async (
          txns: Uint8Array[],
          indexesToSign?: number[],
        ): Promise<(Uint8Array | null)[]> => {
          const signedTxns = await activeWallet.signTransactions(txns, indexesToSign);
          return signedTxns;
        },
      };

      const client = new x402Client();
      client.register(
        "algorand:*",
        new ExactAvmScheme(walletSigner, algorandClient ? { algorandClient } : undefined),
      );

      // Log payment requirements for debugging
      console.log("Creating payment payload with requirements:", {
        x402Version: paymentRequired.x402Version,
        accepts: paymentRequired.accepts.map(a => ({
          scheme: a.scheme,
          network: a.network,
          amount: a.amount,
          asset: a.asset,
          payTo: a.payTo,
        })),
      });

      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      // Log the created payload for debugging
      console.log("Created payment payload:", {
        x402Version: paymentPayload.x402Version,
        accepted: paymentPayload.accepted,
        payloadKeys: Object.keys(paymentPayload.payload || {}),
      });

      const paymentHeader = btoa(JSON.stringify(paymentPayload));

      setStatus("Requesting content with payment...");
      const response = await fetch(x402.currentUrl, {
        headers: {
          "PAYMENT-SIGNATURE": paymentHeader,
          "Access-Control-Expose-Headers": "PAYMENT-RESPONSE,PAYMENT-REQUIRED",
        },
      });

      if (response.ok) {
        await onSuccessfulResponse(response);
      } else {
        // Try to extract detailed error from PAYMENT-REQUIRED header or response body
        let errorDetail = "";

        // Check for PAYMENT-REQUIRED header (contains error info from facilitator)
        const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
        if (paymentRequiredHeader) {
          try {
            const paymentRequired = JSON.parse(atob(paymentRequiredHeader));
            if (paymentRequired.error) {
              errorDetail = paymentRequired.error;
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Also try to get error from response body
        if (!errorDetail) {
          try {
            const body = await response.json();
            if (body.error) {
              errorDetail =
                typeof body.error === "string" ? body.error : JSON.stringify(body.error);
            } else if (body.details) {
              errorDetail = body.details;
            }
          } catch {
            // Response might not be JSON
          }
        }

        const errorMessage = errorDetail
          ? `Payment verification failed: ${errorDetail}`
          : `Request failed: ${response.status} ${response.statusText}`;

        console.error("Payment error details:", {
          status: response.status,
          errorDetail,
          paymentRequiredHeader: paymentRequiredHeader ? "present" : "absent",
        });

        throw new Error(errorMessage);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Payment failed.");
    } finally {
      setIsPaying(false);
    }
  }, [
    x402,
    activeAccount,
    activeWallet,
    usdcBalance,
    refreshBalance,
    chainName,
    algorandClient,
    paymentRequired,
    onSuccessfulResponse,
  ]);

  return (
    <div className="container gap-8">
      <div className="header">
        <h1 className="title">Payment Required</h1>
        <p>
          {paymentRequired.resource?.description && `${paymentRequired.resource.description}.`} To
          access this content, please pay ${amount} {chainName} USDC.
        </p>
        {isTestnet && (
          <p className="instructions">
            Need Algorand Testnet USDC?{" "}
            <a
              href="https://dispenser.testnet.aws.algodev.network/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Request some <u>here</u>.
            </a>
          </p>
        )}
      </div>

      <div className="content w-full">
        <div className="payment-details">
          <div className="payment-row">
            <span className="payment-label">Wallet:</span>
            <span className="payment-value">
              {activeAccount?.address
                ? `${activeAccount.address.slice(0, 6)}...${activeAccount.address.slice(-4)}`
                : "-"}
            </span>
          </div>
          <div className="payment-row">
            <span className="payment-label">Available balance:</span>
            <span className="payment-value">
              {activeAccount?.address ? (
                <button className="balance-button" onClick={() => setHideBalance(prev => !prev)}>
                  {!hideBalance && formattedBalance
                    ? `$${formattedBalance} USDC`
                    : isFetchingBalance
                      ? "Loading..."
                      : "* USDC"}
                </button>
              ) : (
                "-"
              )}
            </span>
          </div>
          <div className="payment-row">
            <span className="payment-label">Amount:</span>
            <span className="payment-value">${amount} USDC</span>
          </div>
          <div className="payment-row">
            <span className="payment-label">Network:</span>
            <span className="payment-value">{chainName}</span>
          </div>
        </div>

        <div className="cta-container">
          {activeAccount?.address ? (
            <button className="button button-secondary" onClick={handleDisconnect}>
              Disconnect
            </button>
          ) : (
            <>
              <select
                className="input"
                value={selectedWalletId}
                onChange={event => setSelectedWalletId((event.target as HTMLSelectElement).value)}
              >
                <option value="" disabled>
                  Select a wallet
                </option>
                {wallets.map(wallet => (
                  <option value={wallet.id} key={wallet.id}>
                    {wallet.metadata?.name ?? wallet.id}
                  </option>
                ))}
              </select>
              <button
                className="button button-primary"
                onClick={handleConnect}
                disabled={!selectedWalletId}
              >
                Connect wallet
              </button>
            </>
          )}
          {activeAccount?.address && (
            <button className="button button-primary" onClick={handlePayment} disabled={isPaying}>
              {isPaying ? <Spinner /> : "Pay now"}
            </button>
          )}
        </div>

        {wallets.length === 0 && (
          <div className="status">
            Install an Algorand wallet such as Pera, Defly, or Lute to continue, then refresh this
            page.
          </div>
        )}

        {status && <div className="status">{status}</div>}
      </div>
    </div>
  );
}
