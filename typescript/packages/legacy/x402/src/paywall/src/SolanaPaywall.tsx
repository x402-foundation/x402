import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletAccount } from "@wallet-standard/base";
import type { WalletWithSolanaFeatures } from "@solana/wallet-standard-features";

import type { PaymentRequirements } from "../../types/verify";
import { exact } from "../../schemes";

import { Spinner } from "./Spinner";
import { ensureValidAmount } from "./utils";
import { getNetworkDisplayName } from "./paywallUtils";
import { getStandardConnectFeature, getStandardDisconnectFeature } from "./solana/features";
import { useSolanaBalance } from "./solana/useSolanaBalance";
import { useSolanaSigner } from "./solana/useSolanaSigner";
import { useSolanaWalletEvents } from "./solana/useSolanaWalletEvents";
import { useSolanaWalletOptions } from "./solana/useSolanaWalletOptions";
import { useSilentWalletConnection } from "./solana/useSilentWalletConnection";
import type { WalletOption } from "./solana/types";

type SolanaPaywallProps = {
  paymentRequirement: PaymentRequirements;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

/**
 * Paywall experience for Solana networks.
 *
 * @param props - Component props.
 * @param props.paymentRequirement - Payment requirement enforced for Solana requests.
 * @param props.onSuccessfulResponse - Callback invoked on successful 402 response.
 * @returns JSX element.
 */
export function SolanaPaywall({ paymentRequirement, onSuccessfulResponse }: SolanaPaywallProps) {
  const [status, setStatus] = useState<string>("");
  const [isPaying, setIsPaying] = useState(false);
  const walletOptions = useSolanaWalletOptions();
  const [selectedWalletValue, setSelectedWalletValue] = useState<string>("");
  const [activeWallet, setActiveWallet] = useState<WalletWithSolanaFeatures | null>(null);
  const [activeAccount, setActiveAccount] = useState<WalletAccount | null>(null);
  const [hideBalance, setHideBalance] = useState(true);
  const attemptedSilentConnectWalletsRef = useRef<Set<string>>(new Set());

  const { usdcBalance, formattedBalance, isFetchingBalance, refreshBalance, resetBalance } =
    useSolanaBalance({
      activeAccount,
      paymentRequirement,
      onStatus: setStatus,
    });

  const x402 = window.x402;
  const amount =
    typeof x402.amount === "number"
      ? x402.amount
      : Number(paymentRequirement.maxAmountRequired ?? 0) / 1_000_000;

  const network = paymentRequirement.network;
  const chainName = getNetworkDisplayName(network);
  const targetChain =
    network === "solana" ? ("solana:mainnet" as const) : ("solana:devnet" as const);

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

      setStatus("Creating payment transaction...");
      const validPaymentRequirements = ensureValidAmount(paymentRequirement);

      const createHeader = async (version: number) =>
        exact.svm.createPaymentHeader(walletSigner, version, validPaymentRequirements);

      const paymentHeader = await createHeader(1);

      setStatus("Requesting content with payment...");
      const response = await fetch(x402.currentUrl, {
        headers: {
          "X-PAYMENT": paymentHeader,
          "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
        },
      });

      if (response.ok) {
        await onSuccessfulResponse(response);
        return;
      }

      if (response.status === 402) {
        const errorData = await response.json().catch(() => ({}));
        if (errorData && typeof errorData.x402Version === "number") {
          const retryPayment = await exact.svm.createPaymentHeader(
            walletSigner,
            errorData.x402Version,
            validPaymentRequirements,
          );

          const retryResponse = await fetch(x402.currentUrl, {
            headers: {
              "X-PAYMENT": retryPayment,
              "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
            },
          });

          if (retryResponse.ok) {
            await onSuccessfulResponse(retryResponse);
            return;
          }

          throw new Error(
            `Payment retry failed: ${retryResponse.status} ${retryResponse.statusText}`,
          );
        }

        throw new Error(`Payment failed: ${response.statusText}`);
      }

      let errorMessage = `Payment failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        } else if (errorData.errorReason) {
          errorMessage = `Payment failed: ${errorData.errorReason}`;
        }
      } catch {
        // Use default error message if parsing fails
      }
      throw new Error(errorMessage);
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
    paymentRequirement,
    onSuccessfulResponse,
  ]);

  return (
    <div className="container gap-8">
      <div className="header">
        <h1 className="title">Payment Required</h1>
        <p>
          {paymentRequirement.description && `${paymentRequirement.description}.`} To access this
          content, please pay ${amount} {chainName} USDC.
        </p>
        {network === "solana-devnet" && (
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
                onChange={event => setSelectedWalletValue(event.target.value)}
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
