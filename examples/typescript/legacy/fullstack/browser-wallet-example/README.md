# x402 Browser Wallet Payment Template

> 🛠️ **A starter template for building payment-enabled applications with x402**

This is a simplified scaffolding project demonstrating [x402 payment protocol](https://x402.org) integration with browser wallet support. Use this as a foundation to build your own micropayment-enabled services, SaaS applications, or any project that needs frictionless web payments.

## What is x402?

x402 is a payments protocol for the internet built on HTTP. It enables:
- **1 line of code** to accept digital dollars
- **No fees**, 2 second settlement
- **$0.001 minimum** payments

Learn more at [x402.org](https://x402.org) or check out the [GitHub repository](https://github.com/x402-foundation/x402).

## This Template Includes

✅ **Two Payment Models** ready to customize:
- **24-Hour Session** ($1.00): Time-based access perfect for SaaS
- **One-Time Access** ($0.10): Single-use payments for actions or content

✅ **Complete Implementation**:
- Server with x402 payment middleware (Hono)
- React client with wallet integration (Viem)
- Session management and validation
- Clean, modern UI ready to customize

✅ **Developer Friendly**:
- TypeScript throughout
- Easy to extend and modify
- Well-documented code
- Production-ready patterns

## Quick Start

### 1. Install Dependencies

```bash
pnpm install:all
```

### 2. Configure the Server

Create `.env`:
```env
FACILITATOR_URL=https://x402.org/facilitator
NETWORK=base-sepolia
ADDRESS=0x_YOUR_WALLET_ADDRESS_HERE
PORT=3001
```

### 3. Run Both Server and Client

```bash
pnpm dev
```

This starts:
- Server on http://localhost:3001
- Client on http://localhost:5173

## How It Works

### Payment Flow

1. **Connect Wallet**: User connects browser wallet to the app
2. **Choose Payment Type**:
   - **24-Hour Session**: Pay $1.00 to get a session ID valid for 24 hours
   - **One-Time Access**: Pay $0.10 for single-use access (valid for 5 minutes)
3. **Sign Payment**: User signs the payment request
4. **Receive Session ID**: After payment, user gets a session ID
5. **Validate Session**: Use the session ID to access protected resources

### Session Types

#### 24-Hour Session
- **Price**: $1.00
- **Duration**: 24 hours from purchase
- **Usage**: Unlimited during the valid period
- **Use Case**: Users who need extended access

#### One-Time Access  
- **Price**: $0.10
- **Duration**: 5 minutes to use
- **Usage**: Single use only
- **Use Case**: Quick one-off actions or trials

## API Endpoints

### Free Endpoints

- `GET /api/health` - Server health check
- `GET /api/payment-options` - Available payment options
- `GET /api/session/:sessionId` - Validate a session
- `GET /api/sessions` - List active sessions

### Paid Endpoints

- `POST /api/pay/session` - Purchase 24-hour session ($1.00)
- `POST /api/pay/onetime` - Purchase one-time access ($0.10)

## Client Features

1. **Wallet Connection**: Connect/disconnect wallet
2. **Payment Options**: Clear display of both payment types
3. **Session Validation**: Input field to check session validity
4. **Active Sessions**: Display of all active sessions
5. **Real-time Updates**: Session list updates after purchases

## Testing

1. Get Base Sepolia ETH from [Coinbase Faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
2. Get Base Sepolia USDC from [Circle Faucet](https://faucet.circle.com/)
3. Connect browser wallet to the app
4. Purchase a session or one-time access
5. Use the session validator to check your session
6. Watch one-time sessions expire after use

## Use This Template For

This scaffolding is perfect as a starting point for:

- **SaaS Applications**: Implement day passes, premium features, or usage-based billing
- **Content Platforms**: Charge for articles, videos, or exclusive content
- **API Services**: Monetize your API with per-call or time-based pricing
- **Digital Tools**: Add trial periods or one-time purchase options
- **Gaming**: Implement in-game purchases or pay-to-play mechanics
- **Any Web Service**: If you can imagine it, you can charge for it with x402

## Customization Guide

### Changing Payment Models

The template uses two payment types, but you can easily modify them:

```typescript
// In server/index.ts, customize your payment endpoints:
"/api/pay/custom": {
  price: "$0.50",  // Your price
  network,
}
```

### Adding New Features

1. **New Payment Tiers**: Add more options in the payment middleware
2. **Different Session Durations**: Modify the expiration logic
3. **Custom Validation**: Extend the session validation system
4. **Database Integration**: Replace in-memory storage with your database
5. **User Authentication**: Add user accounts and payment history

### Styling and Branding

The UI is intentionally minimal so you can add your own design system. All styles are in `client/src/App.css`.

## Get Help

Building something with x402? We're here to help!

- 📚 **Documentation**: [x402.org](https://x402.org)
- 💻 **Source Code**: [github.com/x402-foundation/x402](https://github.com/x402-foundation/x402)
- 💬 **Community**: [Join our Discord](https://discord.gg/invite/cdp)
- 🐛 **Issues**: [GitHub Issues](https://github.com/x402-foundation/x402/issues)

## Contributing

Found a bug or have an improvement for this template? Please open an issue or submit a PR!

## License

This template is open source and available under the same license as the x402 protocol. See the [x402 repository](https://github.com/x402-foundation/x402) for details.

---

**Ready to build?** Fork this template and start accepting payments in minutes! 🚀
