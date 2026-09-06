import { Network } from "../";

// Payments
export type PaymentRequirementsV1 = {
  scheme: string;
  network: Network;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  outputSchema: Record<string, unknown>;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: Record<string, unknown>;
};

export type PaymentRequiredV1 = {
  x402Version: 1;
  error?: string;
  accepts: PaymentRequirementsV1[];
};

export type PaymentPayloadV1 = {
  x402Version: 1;
  scheme: string;
  network: Network;
  payload: Record<string, unknown>;
};

// Facilitator Requests/Responses
export type VerifyRequestV1 = {
  x402Version: number;
  paymentPayload: PaymentPayloadV1;
  paymentRequirements: PaymentRequirementsV1;
};

export type SettleRequestV1 = {
  x402Version: number;
  paymentPayload: PaymentPayloadV1;
  paymentRequirements: PaymentRequirementsV1;
};

export type SettleResponseV1 = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
};

export type SupportedResponseV1 = {
  kinds: {
    x402Version: number;
    scheme: string;
    network: Network;
    extra?: Record<string, unknown>;
  }[];
  // NO extensions field - V1 doesn't support extensions
};
