import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import type { WalletWithSolanaFeatures } from "@solana/wallet-standard-features";

import { ExactSvmScheme } from "@x402/svm/exact/client";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";

import { Spinner } from "./Spinner";
import { getNetworkDisplayName, SOLANA_NETWORK_REFS } from "../paywallUtils";
import { getStandardConnectFeature, getStandardDisconnectFeature } from "./solana/features";
import { useSolanaBalance } from "./solana/useSolanaBalance";
import { useSolanaSigner } from "./solana/useSolanaSigner";
import { useSolanaWalletEvents } from "./solana/useSolanaWalletEvents";
import { useSolanaWalletOptions } from "./solana/useSolanaWalletOptions";
import { useSilentWalletConnection } from "./solana/useSilentWalletConnection";
import type { WalletOption } from "./solana/types";

type SolanaPaywallProps = {
  paymentRequired: PaymentRequired;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

/**
 * Paywall experience for Solana networks.
 *
 * @param props - Component props.
 * @param props.paymentRequired - Payment required response with accepts array.
 * @param props.onSuccessfulResponse - Callback invoked on successful 402 response.
 * @returns JSX element.
 */
export function SolanaPaywall({ paymentRequired, onSuccessfulResponse }: SolanaPaywallProps) {
  const [status, setStatus] = useState<string>("");
  const [isPaying, setIsPaying] = useState(false);
  const walletOptions = useSolanaWalletOptions();
  const [selectedWalletValue, setSelectedWalletValue] = useState<string>("");
  const [activeWallet, setActiveWallet] = useState<WalletWithSolanaFeatures | null>(null);
  const [activeAccount, setActiveAccount] = useState<WalletAccount | null>(null);
  const [hideBalance, setHideBalance] = useState(true);
  const attemptedSilentConnectWalletsRef = useRef<Set<string>>(new Set());

  const x402 = window.x402;
  const amount = x402.amount;

  const firstRequirement = paymentRequired.accepts[0];
  if (!firstRequirement) {
    throw new Error("No payment requirements in paymentRequired.accepts");
  }

  const network = firstRequirement.network;
  const chainName = getNetworkDisplayName(network);

  const isMainnet = network.includes(SOLANA_NETWORK_REFS.MAINNET);
  const targetChain = isMainnet ? ("solana:mainnet" as const) : ("solana:devnet" as const);

  const { usdcBalance, formattedBalance, isFetchingBalance, refreshBalance, resetBalance } =
    useSolanaBalance({
      activeAccount,
      paymentRequired,
      onStatus: setStatus,
    });

  const walletSigner = useSolanaSigner({
    activeWallet,
    activeAccount,
    targetChain,
  });

  useEffect(() => {
    if (!selectedWalletValue && walletOptions.length === 1) {
      setSelectedWalletValue(walletOptions[0].value);
    }
  }, [walletOptions, selectedWalletValue]);

  useEffect(() => {
    if (!activeWallet) {
      return;
    }

    if (!walletOptions.some(option => option.wallet === activeWallet)) {
      setActiveWallet(null);
      setActiveAccount(null);
      setSelectedWalletValue("");
      resetBalance();
    }
  }, [walletOptions, activeWallet, resetBalance]);

  useSilentWalletConnection({
    walletOptions,
    activeWallet,
    targetChain,
    attemptedSilentConnectWalletsRef,
    setSelectedWalletValue,
    setActiveWallet,
    setActiveAccount,
    refreshBalance,
    setStatus,
  });

  useSolanaWalletEvents({
    activeWallet,
    targetChain,
    chainName,
    setActiveWallet,
    setActiveAccount,
    setSelectedWalletValue,
    setStatus,
    resetBalance,
    refreshBalance,
  });

  const handleConnect = useCallback(async () => {
    const wallet = walletOptions.find(
      (option: WalletOption) => option.value === selectedWalletValue,
    )?.wallet;
    if (!wallet) {
      setStatus("Select a Solana wallet to continue.");
      return;
    }

    const connectFeature = getStandardConnectFeature(wallet);
    if (!connectFeature) {
      setStatus("Selected wallet does not support standard connect.");
      return;
    }

    try {
      setStatus("Connecting to wallet...");
      const { accounts } = await connectFeature.connect();
      if (!accounts?.length) {
        throw new Error("Wallet did not provide any accounts.");
      }

      const matchingAccount =
        accounts.find((account: WalletAccount) => account.chains?.includes(targetChain)) ??
        accounts[0];

      setActiveWallet(wallet);
      setActiveAccount(matchingAccount);
      setStatus("");
      await refreshBalance(matchingAccount);
    } catch (error) {
      console.error("Failed to connect wallet", error);
      setStatus(error instanceof Error ? error.message : "Failed to connect wallet.");
    }
  }, [walletOptions, selectedWalletValue, targetChain, refreshBalance]);

  const handleDisconnect = useCallback(async () => {
    const disconnectFeature = activeWallet && getStandardDisconnectFeature(activeWallet);
    if (disconnectFeature) {
      await disconnectFeature.disconnect().catch(console.error);
    }

    setActiveWallet(null);
    setActiveAccount(null);
    resetBalance();
    setStatus("");
  }, [activeWallet, resetBalance]);

  const handlePayment = useCallback(async () => {
    if (!x402) {
      return;
    }

    if (!walletSigner || !activeAccount) {
      setStatus("Connect a Solana wallet before paying.");
      return;
    }

    setIsPaying(true);

    try {
      if (usdcBalance === null || usdcBalance === 0n) {
        setStatus("Checking USDC balance...");
        const latestBalance = await refreshBalance();
        if (!latestBalance || latestBalance === 0n) {
          throw new Error(`Insufficient balance. Make sure you have USDC on ${chainName}.`);
        }
      }

      setStatus("Creating payment signature...");

      const client = new x402Client();
      client.register("solana:*", new ExactSvmScheme(walletSigner));

      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      const paymentHeader = encodePaymentSignatureHeader(paymentPayload);

      setStatus("Requesting content with payment...");
      const response = await fetch(x402.currentUrl, {
        headers: {
          "PAYMENT-SIGNATURE": paymentHeader,
          "Access-Control-Expose-Headers": "PAYMENT-RESPONSE",
        },
      });

      if (response.ok) {
        await onSuccessfulResponse(response);
      } else {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Payment failed.");
    } finally {
      setIsPaying(false);
    }
  }, [
    x402,
    walletSigner,
    activeAccount,
    usdcBalance,
    refreshBalance,
    chainName,
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
        {String(network).includes("devnet") && (
          <p className="instructions">
            Need Solana Devnet USDC?{" "}
            <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">
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
              {activeAccount
                ? `${activeAccount.address.slice(0, 6)}...${activeAccount.address.slice(-4)}`
                : "-"}
            </span>
          </div>
          <div className="payment-row">
            <span className="payment-label">Available balance:</span>
            <span className="payment-value">
              {activeAccount ? (
                <button className="balance-button" onClick={() => setHideBalance(prev => !prev)}>
                  {!hideBalance && formattedBalance
                    ? `$${formattedBalance} USDC`
                    : isFetchingBalance
                      ? "Loading..."
                      : "••••• USDC"}
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
          {activeAccount ? (
            <button className="button button-secondary" onClick={handleDisconnect}>
              Disconnect
            </button>
          ) : (
            <>
              <select
                className="input"
                value={selectedWalletValue}
                onChange={event =>
                  setSelectedWalletValue((event.target as HTMLSelectElement).value)
                }
              >
                <option value="" disabled>
                  Select a wallet
                </option>
                {walletOptions.map(option => (
                  <option value={option.value} key={option.value}>
                    {option.wallet.name}
                  </option>
                ))}
              </select>
              <button
                className="button button-primary"
                onClick={handleConnect}
                disabled={!selectedWalletValue}
              >
                Connect wallet
              </button>
            </>
          )}
          {activeAccount && (
            <button className="button button-primary" onClick={handlePayment} disabled={isPaying}>
              {isPaying ? <Spinner /> : "Pay now"}
            </button>
          )}
        </div>

        {!walletOptions.length && (
          <div className="status">
            Install a Solana wallet such as Phantom to continue, then refresh this page.
          </div>
        )}

        {status && <div className="status">{status}</div>}
      </div>
    </div>
  );
}
