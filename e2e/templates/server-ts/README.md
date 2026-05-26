# x402 <Framework> E2E Test Server

## Overview

## Setup

### Prerequisites

1. Node.js and pnpm installed
2. Environment variables configured:
   ```bash
   EVM_PRIVATE_KEY=0x...  # Private key for facilitator account
   EVM_PAYEE_ADDRESS=0x...      # Address to receive payments
   PORT=4021              # Optional: server port (defaults to 4021)
   ```

### Installation

```bash
pnpm install
```

### Running the Server

```bash
pnpm run start
```

Or for development with auto-reload:

```bash
pnpm run dev
```

## Endpoints

### Protected Endpoint
- **GET /protected** - Requires $0.001 USDC payment on Base Sepolia
- Returns success message with timestamp when payment is valid

### Utility Endpoints  
- **GET /health** - Health check (no payment required)
- **POST /close** - Gracefully shutdown server (for testing)

## Architecture

### Components

1. **`index.ts`** - Main server file with Express app and route configuration
2. **`facilitator.ts`** - Local facilitator setup for payment processing

### Payment Flow

1. Client requests protected endpoint
2. Server returns 402 Payment Required with payment instructions
3. Client creates and signs payment
4. Client retries request with payment signature
5. Server verifies payment via facilitator
6. If valid, server processes request and settles payment
7. Server returns response with settlement confirmation

## Testing

This server is used by the e2e test suite to verify x402 client implementations. The local facilitator allows testing without relying on external services.

### Running E2E Tests

From the project root:

```bash
pnpm run test:e2e
```

## Production Considerations

For production use:

1. Replace the local facilitator with a remote facilitator service
2. Configure appropriate payment amounts and networks
3. Add proper error handling and logging
4. Implement rate limiting and security measures
5. Use environment-specific configuration

## Troubleshooting

### Common Issues

1. **"EVM_PRIVATE_KEY environment variable is required"**
   - Ensure `.env` file exists with required variables
   - Check that dotenv is loading correctly

2. **"Server already running on port"**
   - Check for existing processes: `lsof -i :4021`
   - Kill existing process or use different port

3. **Payment verification fails**
   - Verify private key matches the expected account
   - Check network configuration matches client
   - Ensure sufficient balance for gas fees

## Related Documentation

- [x402 Protocol Specification](../../../specs/x402-specification.md)
- [Express Middleware Package](../../../typescript/packages/http/express/README.md)
- [E2E Test Suite](../../README.md)