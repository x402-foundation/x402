/**
 * Origin Request Lambda@Edge Handler
 * 
 * Verifies x402 payment and forwards valid requests to origin.
 * Settlement is deferred to origin-response handler.
 */

import type { CloudFrontRequestEvent, CloudFrontRequestResult } from 'aws-lambda';
import { createX402Middleware, MiddlewareResultType, type LambdaEdgeResponse } from './lib';
import { FACILITATOR_URL, NETWORK, ROUTES } from './config';

const x402 = createX402Middleware({
  facilitatorUrl: FACILITATOR_URL,
  network: NETWORK,
  routes: ROUTES,
});

export const handler = async (
  event: CloudFrontRequestEvent
): Promise<CloudFrontRequestResult | LambdaEdgeResponse> => {
  const request = event.Records[0].cf.request;
  const distributionDomain = event.Records[0].cf.config.distributionDomainName;

  // --- Your custom logic here (before x402) ---
  // Example: API key check, WAF label check, logging, etc.
  // if (request.headers['x-api-key']?.[0]?.value !== 'secret') {
  //   return { status: '401', body: 'Unauthorized' };
  // }

  // x402 payment verification
  const result = await x402.processOriginRequest(request, distributionDomain);

  if (result.type === MiddlewareResultType.RESPOND) {
    return result.response; // 402 Payment Required or error
  }

  // --- Your custom logic here (after x402, before origin) ---
  // Example: Add custom headers, modify request, etc.

  return result.request;
};
