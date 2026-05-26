import { decodePaymentRequiredHeader } from '@x402/core/http';

/**
 * Lambda@Edge response format
 */
export interface LambdaEdgeResponse {
  status: string;
  statusDescription?: string;
  body?: string;
  headers?: Record<string, Array<{ key: string; value: string }>>;
}

/**
 * Convert HTTP response to Lambda@Edge response format.
 * For 402 responses, decodes the PAYMENT-REQUIRED header and includes it in the body.
 */
export function toLambdaResponse(
  status: number,
  headers: Record<string, string>,
  body?: unknown
): LambdaEdgeResponse {
  const lambdaHeaders: Record<string, Array<{ key: string; value: string }>> = {};

  for (const [key, value] of Object.entries(headers)) {
    lambdaHeaders[key.toLowerCase()] = [{ key, value }];
  }

  // For 402 responses, decode PAYMENT-REQUIRED header and use as body
  let responseBody = body;
  if (status === 402 && headers['PAYMENT-REQUIRED']) {
    try {
      responseBody = decodePaymentRequiredHeader(headers['PAYMENT-REQUIRED']);
    } catch {
      // Fall back to original body if decoding fails
    }
  }

  return {
    status: String(status),
    statusDescription: status === 402 ? 'Payment Required' : undefined,
    headers: lambdaHeaders,
    body: responseBody ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : undefined,
  };
}
