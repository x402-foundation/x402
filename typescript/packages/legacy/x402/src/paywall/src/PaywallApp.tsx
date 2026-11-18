"use client";

import { useCallback, useMemo } from "react";
import type { PaymentRequirements } from "../../types/verify";
import { choosePaymentRequirement, isEvmNetwork, isSvmNetwork } from "./paywallUtils";
import { EvmPaywall } from "./EvmPaywall";
import { SolanaPaywall } from "./SolanaPaywall";

/**
 * Main Paywall App Component
 *
 * @returns The PaywallApp component
 */
export function PaywallApp() {
  const x402 = window.x402;
  const testnet = x402.testnet ?? true;

  const paymentRequirement = useMemo<PaymentRequirements>(() => {
    return choosePaymentRequirement(x402.paymentRequirements, testnet);
  }, [testnet, x402.paymentRequirements]);

  const handleSuccessfulResponse = useCallback(async (response: Response) => {
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      document.documentElement.innerHTML = await response.text();
    } else {
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      window.location.href = url;
    }
  }, []);

  if (!paymentRequirement) {
    return (
      <div className="container">
        <div className="header">
          <h1 className="title">Payment Required</h1>
          <p className="subtitle">Loading payment details...</p>
        </div>
      </div>
    );
  }

  if (isEvmNetwork(paymentRequirement.network)) {
    return (
      <EvmPaywall
        paymentRequirement={paymentRequirement}
        onSuccessfulResponse={handleSuccessfulResponse}
      />
    );
  }

  if (isSvmNetwork(paymentRequirement.network)) {
    return (
      <SolanaPaywall
        paymentRequirement={paymentRequirement}
        onSuccessfulResponse={handleSuccessfulResponse}
      />
    );
  }

  return (
    <div className="container">
      <div className="header">
        <h1 className="title">Payment Required</h1>
        <p className="subtitle">
          Unsupported network configuration for this paywall. Please contact the application
          developer.
        </p>
      </div>
    </div>
  );
}
