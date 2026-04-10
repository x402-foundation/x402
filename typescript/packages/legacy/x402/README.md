# x402

Core TypeScript implementation of the x402 Payment Protocol. This package provides the foundational types, schemas, and utilities that power all x402 integrations.

## Installation

```bash
npm install x402
```

## Overview

The x402 package provides the core building blocks for implementing the x402 Payment Protocol in TypeScript. It's designed to be used by:

- Middleware implementations (Express, Hono, Next.js)
- Client-side payment handlers (fetch wrapper)
- Facilitator services
- Custom integrations

## Integration Packages

This core package is used by the following integration packages:

- `x402-express`: Express.js middleware
- `x402-hono`: Hono middleware
- `x402-next`: Next.js middleware
- `x402-fetch`: Fetch API wrapper
- `x402-axios`: Axios interceptor

## Manual Server Integration

If you're not using one of our server middleware packages, you can implement the x402 protocol manually. Here's what you'll need to handle:

1. Return 402 error responses with the appropriate response body
2. Use the facilitator to validate payments
3. Use the facilitator to settle payments
4. Return the appropriate response header to the caller

For a complete example implementation, see our [advanced server example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/advanced) which demonstrates both synchronous and asynchronous payment processing patterns.

## Manual Client Integration

If you're not using our `x402-fetch` or `x402-axios` packages, you can manually integrate the x402 protocol in your client application. Here's how:

1. Make a request to a x402-protected endpoint. The server will respond with a 402 status code and a JSON object containing:
   - `x402Version`: The version of the x402 protocol being used
   - `accepts`: An array of payment requirements you can fulfill

2. Select the payment requirement you wish to fulfill from the `accepts` array

3. Create the payment header using the selected payment requirement

4. Retry your network call with:
   - The payment header assigned to the `X-PAYMENT` field
   - The `Access-Control-Expose-Headers` field set to `"X-PAYMENT-RESPONSE"` to receive the server's transaction response

For implementation examples, we recommend reviewing our official client packages:
- [x402-fetch implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/legacy/x402-fetch)
- [x402-axios implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/legacy/x402-axios)

