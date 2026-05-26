"use client";

import { useCallback } from "react";
import type { PaymentRequired } from "@x402/core/types";
import { isEvmNetwork, isSvmNetwork, isAvmNetwork } from "./paywallUtils";
import { EvmPaywall } from "./evm/EvmPaywall";
import { SolanaPaywall } from "./svm/SolanaPaywall";
import { AvmPaywall } from "./avm/AvmPaywall";

/**
 * Main Paywall App Component
 *
 * @returns The PaywallApp component
 */
export function PaywallApp() {
  const x402 = window.x402;
  const paymentRequired: PaymentRequired = x402.paymentRequired;

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

  if (!paymentRequired || !paymentRequired.accepts || paymentRequired.accepts.length === 0) {
    return (
      <div className="container">
        <div className="header">
          <h1 className="title">Payment Required</h1>
          <p className="subtitle">Loading payment details...</p>
        </div>
      </div>
    );
  }

  const firstRequirement = paymentRequired.accepts[0];
  const network = firstRequirement.network;

  if (isEvmNetwork(network)) {
    return (
      <EvmPaywall
        paymentRequired={paymentRequired}
        onSuccessfulResponse={handleSuccessfulResponse}
      />
    );
  }

  if (isSvmNetwork(network)) {
    return (
      <SolanaPaywall
        paymentRequired={paymentRequired}
        onSuccessfulResponse={handleSuccessfulResponse}
      />
    );
  }

  if (isAvmNetwork(network)) {
    return (
      <AvmPaywall
        paymentRequired={paymentRequired}
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
