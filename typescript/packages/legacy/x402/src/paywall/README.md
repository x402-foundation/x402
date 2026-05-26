# x402 Paywall

Automatic wallet connection and payment UI for x402 middleware-enabled servers. Handles wallet connection, network switching, balance checking, and payment processing.

```typescript
export const middleware = paymentMiddleware(
  address,
  {
    "/protected": { price: "$0.01" },
  },
  {
    appLogo: "/logos/your-app.png",         // Optional
    appName: "Your App Name",               // Optional
    cdpClientKey: "your-cdp-client-key",    // Optional: Enhanced RPC
  },
);
```

## Features

**Wallet Connection & Payment Processing:** Supports Coinbase Smart Wallet, Coinbase EOA, MetaMask, Rabby, Trust Wallet, Frame, and wallet-standard compatible Solana wallets such as Phantom and Backpack. Includes x402 payment processing by default.

**Multi-chain Aware:** Automatically chooses the best available payment requirement (Base, Base Sepolia, Solana, Solana Devnet) and renders the appropriate wallet flow without additional configuration.

**Enhanced RPC** (optional): Add `cdpClientKey` to use Coinbase's hosted RPC infrastructure for improved performance.

## Configuration Options

| Option | Description |
|--------|-------------|
| `appLogo` | Logo URL for wallet selection modal (optional, defaults to no logo) |
| `appName` | App name displayed in wallet selection modal (optional, defaults to "Dapp") |
| `cdpClientKey` | [Coinbase Developer Platform Client API Key](https://docs.cdp.coinbase.com/get-started/docs/cdp-api-keys) for enhanced RPC |


## Usage

The paywall automatically loads when a browser attempts to access a protected route configured in your middleware.

![](../../../../../static/paywall.jpg)

### Solana Support

- Solana flows use the [Wallet Standard](https://solana.com/developers/wallets/wallet-standard) to discover installed wallets at runtime.
- The paywall requests `solana:signTransaction` permissions only when a Solana payment requirement is selected.
- Balances are fetched directly from the relevant USDC mint (Token or Token-2022) via `@solana/kit`.
