# x402 Payment Skill

Make HTTP payments using the x402 protocol with stablecoins.

## Overview

x402 is an open standard for internet-native payments. When an API endpoint requires payment, it responds with HTTP 402 Payment Required, including payment details in the response. The client then makes a stablecoin payment and retries the request with proof of payment.

## How to Use

1. Send an HTTP request to the target endpoint
2. If you receive a **402 Payment Required** response, parse the payment requirements from the response body
3. The response includes: price, payment network, token address, and recipient
4. Create a stablecoin payment transaction on the specified network
5. Resend the original request with the payment proof in the `X-PAYMENT` header

## Supported Networks

- Base: `eip155:8453`
- Ethereum: `eip155:1`
- Arbitrum: `eip155:42161`
- Solana: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`

## Supported Tokens

- USDC
- EURC

## Integration

```javascript
import { paymentMiddleware } from "@x402/express";

app.use(
  paymentMiddleware({
    "GET /api/data": {
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          maxAmountRequired: "100000",
          resource: "https://api.example.com/data",
        },
      ],
      description: "Access to data API",
    },
  })
);
```

## Resources

- [GitHub Repository](https://github.com/coinbase/x402)
- [Documentation](https://x402.org/writing/x402-v2-launch)
- [Ecosystem](https://x402.org/ecosystem)
