import { safeBase64Encode, safeBase64Decode } from "../../../../shared";
import { SupportedEVMNetworks, SupportedSVMNetworks } from "../../../../types";
import {
  PaymentPayload,
  PaymentPayloadSchema,
  ExactEvmPayload,
  ExactSvmPayload,
} from "../../../../types/verify";

/**
 * Encodes a payment payload into a base64 string, ensuring bigint values are properly stringified
 *
 * @param payment - The payment payload to encode
 * @returns A base64 encoded string representation of the payment payload
 */
export function encodePayment(payment: PaymentPayload): string {
  let safe: PaymentPayload;

  // evm
  if (SupportedEVMNetworks.includes(payment.network)) {
    const evmPayload = payment.payload as ExactEvmPayload;
    safe = {
      ...payment,
      payload: {
        ...evmPayload,
        authorization: Object.fromEntries(
          Object.entries(evmPayload.authorization).map(([key, value]) => [
            key,
            typeof value === "bigint" ? (value as bigint).toString() : value,
          ]),
        ) as ExactEvmPayload["authorization"],
      },
    };
    return safeBase64Encode(JSON.stringify(safe));
  }

  // svm
  if (SupportedSVMNetworks.includes(payment.network)) {
    safe = { ...payment, payload: payment.payload as ExactSvmPayload };
    return safeBase64Encode(JSON.stringify(safe));
  }

  throw new Error("Invalid network");
}

/**
 * Decodes a base64 encoded payment string back into a PaymentPayload object
 *
 * @param payment - The base64 encoded payment string to decode
 * @returns The decoded and validated PaymentPayload object
 */
export function decodePayment(payment: string): PaymentPayload {
  const decoded = safeBase64Decode(payment);
  const parsed = JSON.parse(decoded);

  let obj: PaymentPayload;

  // evm
  if (SupportedEVMNetworks.includes(parsed.network)) {
    obj = {
      ...parsed,
      payload: parsed.payload as ExactEvmPayload,
    };
  }

  // svm
  else if (SupportedSVMNetworks.includes(parsed.network)) {
    obj = {
      ...parsed,
      payload: parsed.payload as ExactSvmPayload,
    };
  } else {
    throw new Error("Invalid network");
  }

  const validated = PaymentPayloadSchema.parse(obj);
  return validated;
}
