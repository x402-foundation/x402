import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, formatUnits, http, publicActions, type Chain } from "viem";
import * as allChains from "viem/chains";
import { useAccount, useSwitchChain, useWalletClient, useConnect, useDisconnect } from "wagmi";

import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { getUSDCBalance } from "./utils";

import { Spinner } from "./Spinner";
import { getNetworkDisplayName, isTestnetNetwork } from "../paywallUtils";
import { wagmiToClientSigner } from "./browserAdapter";

type EvmPaywallProps = {
  paymentRequired: PaymentRequired;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

/**
 * Paywall experience for EVM networks.
 *
 * @param props - Component props.
 * @param props.paymentRequired - Payment required response with accepts array.
 * @param props.onSuccessfulResponse - Callback fired once the 402 fetch succeeds.
 * @returns JSX element.
 */
export function EvmPaywall({ paymentRequired, onSuccessfulResponse }: EvmPaywallProps) {
  const { address, isConnected, chainId: connectedChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { data: wagmiWalletClient } = useWalletClient();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();

  const [status, setStatus] = useState<string>("");
  const [isCorrectChain, setIsCorrectChain] = useState<boolean | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [formattedUsdcBalance, setFormattedUsdcBalance] = useState<string>("");
  const [hideBalance, setHideBalance] = useState(true);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>("");

  const x402 = window.x402;
  const amount = x402.amount;

  const firstRequirement = paymentRequired.accepts[0];
  if (!firstRequirement) {
    throw new Error("No payment requirements in paymentRequired.accepts");
  }

  const network = firstRequirement.network;
  const chainName = getNetworkDisplayName(network);
  const testnet = isTestnetNetwork(network);

  const chainId = parseInt(network.split(":")[1]);

  // Find the chain from viem's chain definitions
  const paymentChain: Chain | undefined = Object.values(allChains).find(c => c.id === chainId);

  if (!paymentChain) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: paymentChain,
        transport: http(),
      }).extend(publicActions),
    [paymentChain],
  );

  const checkUSDCBalance = useCallback(async () => {
    if (!address) {
      return;
    }
    const balance = await getUSDCBalance(publicClient, address);
    const formattedBalance = formatUnits(balance, 6);
    setFormattedUsdcBalance(formattedBalance);
  }, [address, publicClient]);

  const handleSwitchChain = useCallback(async () => {
    if (isCorrectChain) {
      return;
    }

    try {
      setStatus("");
      await switchChainAsync({ chainId });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to switch network");
    }
  }, [switchChainAsync, chainId, isCorrectChain]);

  useEffect(() => {
    if (!address) {
      return;
    }

    void handleSwitchChain();
    void checkUSDCBalance();
  }, [address, handleSwitchChain, checkUSDCBalance]);

  useEffect(() => {
    if (isConnected && chainId === connectedChainId) {
      setIsCorrectChain(true);
      setStatus("");
    } else if (isConnected && chainId !== connectedChainId) {
      setIsCorrectChain(false);
      setStatus(`On the wrong network. Please switch to ${chainName}.`);
    } else {
      setIsCorrectChain(null);
      setStatus("");
    }
  }, [chainId, connectedChainId, isConnected, chainName]);

  // Auto-select if only one connector is available
  useEffect(() => {
    if (!selectedConnectorId && connectors.length === 1) {
      setSelectedConnectorId(connectors[0].id);
    }
  }, [connectors, selectedConnectorId]);

  const handlePayment = useCallback(async () => {
    if (!address || !x402) {
      return;
    }

    await handleSwitchChain();

    if (!wagmiWalletClient) {
      setStatus("Wallet client not available. Please reconnect your wallet.");
      return;
    }
    const walletClient = wagmiWalletClient.extend(publicActions);

    setIsPaying(true);

    try {
      setStatus("Checking USDC balance...");
      const balance = await getUSDCBalance(publicClient, address);

      if (balance === 0n) {
        throw new Error(`Insufficient balance. Make sure you have USDC on ${chainName}`);
      }

      setStatus("Creating payment signature...");

      const signer = wagmiToClientSigner(walletClient);
      const client = new x402Client();
      client.register("eip155:*", new ExactEvmScheme(signer));

      // Create payment payload - client automatically handles version
      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      // Encode as base64 JSON for v2 header
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
      setStatus(error instanceof Error ? error.message : "Payment failed");
    } finally {
      setIsPaying(false);
    }
  }, [
    address,
    x402,
    paymentRequired,
    handleSwitchChain,
    wagmiWalletClient,
    publicClient,
    chainName,
    onSuccessfulResponse,
  ]);

  if (!x402) {
    return null;
  }

  return (
    <div className="container gap-8">
      <div className="header">
        <h1 className="title">Payment Required</h1>
        <p>
          {paymentRequired.resource?.description && `${paymentRequired.resource.description}.`} To
          access this content, please pay ${amount} {chainName} USDC.
        </p>
        {testnet && (
          <p className="instructions">
            Need {chainName} USDC?{" "}
            <a href="https://faucet.circle.com/" target="_blank" rel="noopener noreferrer">
              Get some <u>here</u>.
            </a>
          </p>
        )}
      </div>

      <div className="content w-full">
        {!isConnected ? (
          <div className="cta-container">
            <select
              className="input"
              value={selectedConnectorId}
              onChange={event => setSelectedConnectorId((event.target as HTMLSelectElement).value)}
            >
              <option value="" disabled>
                Select a wallet
              </option>
              {connectors.map(connector => (
                <option value={connector.id} key={connector.id}>
                  {connector.name}
                </option>
              ))}
            </select>
            <button
              className="button button-primary"
              onClick={() => {
                const connector = connectors.find(c => c.id === selectedConnectorId);
                if (connector) {
                  connect({ connector });
                }
              }}
              disabled={!selectedConnectorId}
            >
              Connect wallet
            </button>
          </div>
        ) : (
          <div className="cta-container">
            <button className="button button-secondary" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        )}
        {isConnected && (
          <div id="payment-section">
            <div className="payment-details">
              <div className="payment-row">
                <span className="payment-label">Wallet:</span>
                <span className="payment-value">
                  {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Loading..."}
                </span>
              </div>
              <div className="payment-row">
                <span className="payment-label">Available balance:</span>
                <span className="payment-value">
                  <button className="balance-button" onClick={() => setHideBalance(prev => !prev)}>
                    {formattedUsdcBalance && !hideBalance
                      ? `$${formattedUsdcBalance} USDC`
                      : "••••• USDC"}
                  </button>
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
              {isCorrectChain ? (
                <button
                  className="button button-primary"
                  onClick={handlePayment}
                  disabled={isPaying}
                >
                  {isPaying ? <Spinner /> : "Pay now"}
                </button>
              ) : (
                <button className="button button-primary w-full" onClick={handleSwitchChain}>
                  Switch to {chainName}
                </button>
              )}
            </div>
          </div>
        )}
        {status && <div className="status">{status}</div>}
      </div>
    </div>
  );
}
