import type {
  CloudFrontRequest,
  CloudFrontResponse,
} from 'aws-lambda';
import type { x402HTTPResourceServer } from '@x402/core/server';
import { CloudFrontHTTPAdapter } from './adapter';
import { toLambdaResponse, LambdaEdgeResponse } from './responses';
import { createX402Server, type X402ServerConfig } from './server';

/**
 * Result types for middleware processing
 */
export const MiddlewareResultType = {
  /** Continue processing - forward request/response to next step */
  CONTINUE: 'continue',
  /** Respond immediately - return response to client */
  RESPOND: 'respond',
} as const;

export type MiddlewareResultType = typeof MiddlewareResultType[keyof typeof MiddlewareResultType];

/**
 * x402 HTTP process result types (from @x402/core)
 */
export const HTTPProcessResultType = {
  /** Route doesn't require payment */
  NO_PAYMENT_REQUIRED: 'no-payment-required',
  /** Payment verified successfully */
  PAYMENT_VERIFIED: 'payment-verified',
  /** Payment missing or invalid */
  PAYMENT_ERROR: 'payment-error',
} as const;

export type HTTPProcessResultType = typeof HTTPProcessResultType[keyof typeof HTTPProcessResultType];

/**
 * Result of origin-request processing
 */
export type OriginRequestResult =
  | { type: typeof MiddlewareResultType.CONTINUE; request: CloudFrontRequest }
  | { type: typeof MiddlewareResultType.RESPOND; response: LambdaEdgeResponse };

/**
 * Result of origin-response processing  
 */
export type OriginResponseResult =
  | { type: typeof MiddlewareResultType.CONTINUE; response: CloudFrontResponse }
  | { type: typeof MiddlewareResultType.RESPOND; response: LambdaEdgeResponse };

/**
 * Internal header used to pass payment data between origin-request and origin-response
 */
const PENDING_SETTLEMENT_HEADER = 'x-x402-pending-settlement';

/**
 * Creates x402 middleware functions for Lambda@Edge.
 * 
 * Unlike full handlers, these return results that you can use in your own handler logic.
 * This allows composing x402 with other middleware (auth, logging, WAF, etc.).
 * 
 * @example
 * ```typescript
 * import { createX402Middleware } from './lib';
 * 
 * const x402 = createX402Middleware({
 *   facilitatorUrl: 'https://x402.org/facilitator',
 *   network: 'eip155:84532',
 *   routes: {
 *     '/api/*': {
 *       accepts: { scheme: 'exact', network: 'eip155:84532', payTo: '0x...', price: '$0.01' }
 *     }
 *   }
 * });
 * 
 * // Origin Request handler with custom logic
 * export const handler = async (event: CloudFrontRequestEvent) => {
 *   const request = event.Records[0].cf.request;
 *   
 *   // Your custom logic first (auth, logging, etc.)
 *   if (request.headers['x-api-key']?.[0]?.value !== 'secret') {
 *     return { status: '401', body: 'Unauthorized' };
 *   }
 *   
 *   // x402 payment check
 *   const result = await x402.processOriginRequest(request, event.Records[0].cf.config.distributionDomainName);
 *   
 *   if (result.type === 'respond') {
 *     return result.response; // 402 Payment Required
 *   }
 *   
 *   return result.request;
 * };
 * ```
 */
export function createX402Middleware(config: X402ServerConfig) {
  let serverPromise: Promise<x402HTTPResourceServer> | null = null;

  const getServer = async (): Promise<x402HTTPResourceServer> => {
    if (!serverPromise) {
      serverPromise = createX402Server(config);
    }
    return serverPromise;
  };

  /**
   * Process origin-request for x402 payment verification.
   * 
   * @param request - CloudFront request object
   * @param distributionDomain - CloudFront distribution domain name
   * @returns Result indicating whether to continue or respond
   */
  async function processOriginRequest(
    request: CloudFrontRequest,
    distributionDomain: string
  ): Promise<OriginRequestResult> {
    console.log('x402 origin-request:', request.uri);

    // Security: Remove any pre-existing settlement header to prevent bypass attacks
    delete request.headers[PENDING_SETTLEMENT_HEADER];

    try {
      const server = await getServer();
      const adapter = new CloudFrontHTTPAdapter(request, distributionDomain);

      const context = {
        adapter,
        path: adapter.getPath(),
        method: adapter.getMethod(),
        paymentHeader: adapter.getHeader('payment-signature'),
      };

      const result = await server.processHTTPRequest(context);

      switch (result.type) {
        case HTTPProcessResultType.NO_PAYMENT_REQUIRED:
          return { type: MiddlewareResultType.CONTINUE, request };

        case HTTPProcessResultType.PAYMENT_ERROR:
          console.log('Payment required or invalid');
          return {
            type: MiddlewareResultType.RESPOND,
            response: toLambdaResponse(
              result.response.status,
              result.response.headers,
              result.response.body
            ),
          };

        case HTTPProcessResultType.PAYMENT_VERIFIED:
          console.log('Payment verified, forwarding to origin (settlement deferred)');

          const paymentData = JSON.stringify({
            payload: result.paymentPayload,
            requirements: result.paymentRequirements,
          });

          request.headers[PENDING_SETTLEMENT_HEADER] = [
            { key: PENDING_SETTLEMENT_HEADER, value: Buffer.from(paymentData).toString('base64') },
          ];

          return { type: MiddlewareResultType.CONTINUE, request };
      }

      // Should never reach here - all cases handled above
      throw new Error(`Unexpected result type`);
    } catch (error) {
      console.error('x402 origin-request error:', error);
      return {
        type: MiddlewareResultType.RESPOND,
        response: toLambdaResponse(500, { 'Content-Type': 'application/json' }, {
          error: 'Internal server error',
        }),
      };
    }
  }

  /**
   * Process origin-response for x402 payment settlement.
   * Only settles if origin returned success (status < 400).
   * 
   * @param request - Original CloudFront request (contains payment data)
   * @param response - CloudFront response from origin
   * @returns Result indicating whether to continue or replace response
   */
  async function processOriginResponse(
    request: CloudFrontRequest,
    response: CloudFrontResponse
  ): Promise<OriginResponseResult> {
    const pendingSettlement = request.headers[PENDING_SETTLEMENT_HEADER]?.[0]?.value;

    if (!pendingSettlement) {
      return { type: MiddlewareResultType.CONTINUE, response };
    }

    const status = parseInt(response.status, 10);
    console.log('x402 origin-response:', request.uri, 'status:', status);

    // Only settle if origin succeeded
    if (status >= 400) {
      console.log('Origin failed, skipping settlement - customer not charged');
      return { type: MiddlewareResultType.CONTINUE, response };
    }

    try {
      const paymentData = JSON.parse(
        Buffer.from(pendingSettlement, 'base64').toString('utf-8')
      );

      const server = await getServer();
      const settlement = await server.processSettlement(
        paymentData.payload,
        paymentData.requirements
      );

      if (settlement.success) {
        console.log('Payment settled successfully');
        for (const [key, value] of Object.entries(settlement.headers)) {
          response.headers[key.toLowerCase()] = [{ key, value: String(value) }];
        }
        return { type: MiddlewareResultType.CONTINUE, response };
      } else {
        console.error('Settlement failed:', settlement.errorReason);
        return {
          type: MiddlewareResultType.RESPOND,
          response: toLambdaResponse(402, { 'Content-Type': 'application/json' }, {
            error: 'Settlement failed',
            details: settlement.errorReason,
          }),
        };
      }
    } catch (error) {
      console.error('x402 origin-response settlement error:', error);
      return {
        type: MiddlewareResultType.RESPOND,
        response: toLambdaResponse(402, { 'Content-Type': 'application/json' }, {
          error: 'Settlement failed',
          details: error instanceof Error ? error.message : 'Unknown error',
        }),
      };
    }
  }

  return {
    processOriginRequest,
    processOriginResponse,
  };
}

export type X402Middleware = ReturnType<typeof createX402Middleware>;
