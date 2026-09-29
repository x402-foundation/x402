/**
 * x402 Lambda@Edge Exports
 * 
 * Two separate handlers for CloudFront events:
 * - origin-request.ts: Payment verification
 * - origin-response.ts: Payment settlement (only on success)
 */

// Handler exports for Lambda deployment
export { handler as originRequestHandler } from './origin-request';
export { handler as originResponseHandler } from './origin-response';

// Re-export library for custom integrations
export * from './lib';
