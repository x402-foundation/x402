import { useCallback, useRef, useState } from "react";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { ClientStellarSigner } from "@x402/stellar";
import type { PaymentRequired } from "@x402/core/types";
import { statusError, statusInfo, statusSuccess, type Status } from "./status";
import { formatPaymentError, parseError } from "./utils";

export type UseStellarPaymentParams = {
  paymentRequired: PaymentRequired;
  walletSigner: ClientStellarSigner | null;
  setStatus: (status: Status | null) => void;
  onSuccessfulResponse: (response: Response) => Promise<void>;
};

export type UseStellarPaymentResult = {
  isPaying: boolean;
  submitPayment: () => Promise<void>;
};

type X402Runtime = {
  config?: {
    rpcUrl?: string;
  };
};

/**
 * Builds the x402 client used to pay the paywall.
 *
 * Spend controls guard unattended agent clients; here the user sees the
 * price and approves the exact amount in their wallet, so the default
 * $1-per-payment cap would only break servers priced above it.
 *
 * @param walletSigner - The signer responsible for Stellar signatures.
 * @param rpcUrl - Optional Soroban RPC URL override.
 * @returns A client with spend controls disabled and the Stellar scheme registered.
 */
export function createPaywallClient(
  walletSigner: ClientStellarSigner,
  rpcUrl?: string,
): x402Client {
  const client = new x402Client().setSpendControls(false);
  client.register("stellar:*", new ExactStellarScheme(walletSigner, { url: rpcUrl }));
  return client;
}

/**
 * Handles Stellar payment submission.
 *
 * @param params - Hook parameters.
 * @param params.paymentRequired - Payment required response with accepts array.
 * @param params.walletSigner - The signer responsible for Stellar signatures.
 * @param params.onSuccessfulResponse - Callback invoked once paywall returns success.
 * @param params.setStatus - UI status setter used for toast-like messages.
 * @returns Handlers to trigger payments and the current loading state.
 */
export function useStellarPayment(params: UseStellarPaymentParams): UseStellarPaymentResult {
  const { walletSigner, paymentRequired, onSuccessfulResponse, setStatus } = params;
  const [isPaying, setIsPaying] = useState(false);
  const inFlightRef = useRef(false);

  const x402 = (window as Window & { x402?: X402Runtime }).x402;
  const runtimeRpcUrl = x402?.config?.rpcUrl;

  const submitPayment = useCallback(async () => {
    if (inFlightRef.current) return;
    if (!x402 || !walletSigner || !paymentRequired) {
      setStatus(statusError("Unable to submit Stellar payment; wallet or config missing."));
      return;
    }

    inFlightRef.current = true;
    setIsPaying(true);
    try {
      setStatus(statusInfo("Waiting for user signature..."));

      const client = createPaywallClient(walletSigner, runtimeRpcUrl);

      const paymentPayload = await client.createPaymentPayload(paymentRequired);

      const paymentHeader = encodePaymentSignatureHeader(paymentPayload);

      setStatus(statusInfo("Settling payment..."));
      const targetUrl = window.location.href;
      const response = await fetch(targetUrl, {
        headers: {
          "PAYMENT-SIGNATURE": paymentHeader,
        },
      });

      if (response.ok) {
        setStatus(statusSuccess("Payment successful! Loading content..."));
        await onSuccessfulResponse(response);
        return;
      }

      const responseBody = await response.text().catch(() => "");
      let parsedBody: Record<string, unknown> | null = null;
      try {
        parsedBody = JSON.parse(responseBody) as Record<string, unknown>;
      } catch {
        /* body is not JSON; parsedBody stays null */
      }

      if (response.status === 402) {
        if (parsedBody && typeof parsedBody.x402Version === "number") {
          setStatus(statusInfo("Retrying payment..."));

          // Validate fresh requirements only for the error message context.
          const freshHeader = response.headers.get("PAYMENT-REQUIRED");
          const freshRequirements = freshHeader
            ? decodePaymentRequiredHeader(freshHeader)
            : (parsedBody as unknown as PaymentRequired);

          // clientReq is the paymentRequirement chosen by the x402 client
          const clientReq = paymentPayload.accepted;
          const freshMatch = freshRequirements.accepts?.find(
            f =>
              f.scheme === clientReq.scheme &&
              f.network === clientReq.network &&
              f.asset === clientReq.asset,
          );
          if (!freshMatch) {
            throw new Error(
              "Server removed the accepted payment option on retry — aborting for safety",
            );
          }
          if (freshMatch.payTo !== clientReq.payTo || freshMatch.amount !== clientReq.amount) {
            throw new Error(
              "Server changed payment recipient or amount on retry — aborting for safety",
            );
          }

          const retryResponse = await fetch(targetUrl, {
            headers: {
              "PAYMENT-SIGNATURE": paymentHeader,
            },
          });

          if (retryResponse.ok) {
            setStatus(statusSuccess("Payment successful! Loading content..."));
            await onSuccessfulResponse(retryResponse);
            return;
          }

          const retryBody = await retryResponse.text().catch(() => "");
          throw new Error(
            formatPaymentError(
              "Payment retry failed",
              retryResponse.status,
              retryBody,
              retryResponse.headers.get("payment-required"),
            ),
          );
        }

        throw new Error(
          formatPaymentError(
            "Payment required but settlement failed",
            response.status,
            responseBody,
            response.headers.get("payment-required"),
          ),
        );
      }

      throw new Error(
        formatPaymentError(
          "Payment request rejected",
          response.status,
          responseBody,
          response.headers.get("payment-required"),
        ),
      );
    } catch (error) {
      setStatus(statusError(parseError(error, "Payment failed.")));
    } finally {
      inFlightRef.current = false;
      setIsPaying(false);
    }
  }, [walletSigner, x402, paymentRequired, onSuccessfulResponse, setStatus, runtimeRpcUrl]);

  return { isPaying, submitPayment };
}
