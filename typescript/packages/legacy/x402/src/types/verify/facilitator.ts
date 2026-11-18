import { z } from "zod";
import { safeBase64Decode, safeBase64Encode } from "../../shared";
import { PaymentRequirementsSchema, SettleResponse } from "./x402Specs";

export const facilitatorRequestSchema = z.object({
  paymentHeader: z.string(),
  paymentRequirements: PaymentRequirementsSchema,
});

export type FacilitatorRequest = z.infer<typeof facilitatorRequestSchema>;

/**
 * Encodes a settlement response into a base64 header string
 *
 * @param response - The settlement response to encode
 * @returns A base64 encoded string containing the settlement response
 */
export function settleResponseHeader(response: SettleResponse): string {
  return safeBase64Encode(JSON.stringify(response));
}

/**
 * Decodes a base64 header string back into a settlement response
 *
 * @param header - The base64 encoded settlement response header
 * @returns The decoded settlement response object
 */
export function settleResponseFromHeader(header: string): SettleResponse {
  const decoded = safeBase64Decode(header);
  return JSON.parse(decoded) as SettleResponse;
}
