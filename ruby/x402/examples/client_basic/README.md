# Basic Client Example

This example demonstrates how to use the x402 Client to make payments for protected resources.

## Setup

1. Install dependencies:
```bash
bundle install
```

2. Set environment variables:
```bash
export PRIVATE_KEY="0x..." # Your EVM private key
export API_URL="https://example.com/api/premium/data" # Protected resource URL
```

## Running

```bash
ruby client.rb
```

## What It Does

1. Creates an EVM signer from private key
2. Configures the x402 client with EVM scheme
3. Adds policies (prefer Base network, max $10 limit)
4. Makes initial request to protected resource (expects 402)
5. Parses Payment-Required response
6. Creates signed payment payload
7. Retries request with Payment-Signature header
8. Displays resource data and payment confirmation

## Example Output

```
=== X402 Client Example ===
API URL: https://example.com/api/premium/data

1. Creating EVM signer...
   Address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb

2. Creating client scheme...
   Scheme: exact

3. Configuring client...
   Registered schemes: eip155:*
   Policies: prefer Base, max $10

4. Making initial request...
   Status: 402

5. Resource requires payment (402 response)
   Parsing payment requirements...
   Requirements received:
     Protocol version: 2
     Options: 1
       1. exact on eip155:8453 - 1000000 (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)

6. Creating payment payload...
   Creating payment:
     Network: eip155:8453
     Amount: 1000000
     Recipient: 0x...
   ✓ Payment created successfully
   ✓ Payment payload created
     Scheme: exact
     Network: eip155:8453

7. Encoding payment for HTTP header...
   ✓ Payment encoded (1234 bytes)

8. Retrying request with payment...
   Status: 200
   ✓ Success! Resource accessed

9. Payment response received
   Settlement details:
     Success: true
     Transaction: 0xabc123...

10. Resource data:
{"data": "premium content"}

=== Payment Complete ===
```

## Notes

- Requires EVM private key with USDC balance
- Supports all EVM networks (Ethereum, Base, Polygon, etc.)
- Policies filter available payment options
- Payment is settled on-chain automatically
