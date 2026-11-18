import { verify as verifyExactEvm, settle as settleExactEvm } from "../schemes/exact/evm";
import { verify as verifyExactSvm, settle as settleExactSvm } from "../schemes/exact/svm";
import { SupportedEVMNetworks, SupportedSVMNetworks } from "../types/shared";
import { X402Config } from "../types/config";
import {
  ConnectedClient as EvmConnectedClient,
  SignerWallet as EvmSignerWallet,
} from "../types/shared/evm";
import { ConnectedClient, Signer } from "../types/shared/wallet";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  ExactEvmPayload,
} from "../types/verify";
import { Chain, Transport, Account } from "viem";
import { TransactionSigner } from "@solana/kit";

/**
 * Verifies a payment payload against the required payment details regardless of the scheme
 * this function wraps all verify functions for each specific scheme
 *
 * @param client - The public client used for blockchain interactions
 * @param payload - The signed payment payload containing transfer parameters and signature
 * @param paymentRequirements - The payment requirements that the payload must satisfy
 * @param config - Optional configuration for X402 operations (e.g., custom RPC URLs)
 * @returns A ValidPaymentRequest indicating if the payment is valid and any invalidation reason
 */
export async function verify<
  transport extends Transport,
  chain extends Chain,
  account extends Account | undefined,
>(
  client: ConnectedClient | Signer,
  payload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  config?: X402Config,
): Promise<VerifyResponse> {
  // exact scheme
  if (paymentRequirements.scheme === "exact") {
    // evm
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      return verifyExactEvm(
        client as EvmConnectedClient<transport, chain, account>,
        payload,
        paymentRequirements,
      );
    }

    // svm
    if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      return await verifyExactSvm(
        client as TransactionSigner,
        payload,
        paymentRequirements,
        config,
      );
    }
  }

  // unsupported scheme
  return {
    isValid: false,
    invalidReason: "invalid_scheme",
    payer: SupportedEVMNetworks.includes(paymentRequirements.network)
      ? (payload.payload as ExactEvmPayload).authorization.from
      : "",
  };
}

/**
 * Settles a payment payload against the required payment details regardless of the scheme
 * this function wraps all settle functions for each specific scheme
 *
 * @param client - The signer wallet used for blockchain interactions
 * @param payload - The signed payment payload containing transfer parameters and signature
 * @param paymentRequirements - The payment requirements that the payload must satisfy
 * @param config - Optional configuration for X402 operations (e.g., custom RPC URLs)
 * @returns A SettleResponse indicating if the payment is settled and any settlement reason
 */
export async function settle<transport extends Transport, chain extends Chain>(
  client: Signer,
  payload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  config?: X402Config,
): Promise<SettleResponse> {
  // exact scheme
  if (paymentRequirements.scheme === "exact") {
    // evm
    if (SupportedEVMNetworks.includes(paymentRequirements.network)) {
      return await settleExactEvm(
        client as EvmSignerWallet<chain, transport>,
        payload,
        paymentRequirements,
      );
    }

    // svm
    if (SupportedSVMNetworks.includes(paymentRequirements.network)) {
      return await settleExactSvm(
        client as TransactionSigner,
        payload,
        paymentRequirements,
        config,
      );
    }
  }

  return {
    success: false,
    errorReason: "invalid_scheme",
    transaction: "",
    network: paymentRequirements.network,
    payer: SupportedEVMNetworks.includes(paymentRequirements.network)
      ? (payload.payload as ExactEvmPayload).authorization.from
      : "",
  };
}

export type Supported = {
  x402Version: number;
  kind: {
    scheme: string;
    networkId: string;
    extra: object;
  }[];
};
