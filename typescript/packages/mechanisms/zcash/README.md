# Zcash (Shielded) Network Support for x402

This adds Zcash as a supported network in the x402 protocol, enabling shielded agent-to-agent payments.

## Why Zcash

x402 currently supports 8 chains (Base, Solana, Aptos, Stellar, Avalanche, Polygon, Sei, SKALE). All use transparent ledgers. Zcash adds the first shielded settlement option: agents can pay for HTTP resources without revealing transaction amounts or addresses on-chain.

This is relevant for:
- Agent treasury flows where payment history should not be public
- x402 payments that require privacy compliance (GDPR, financial regulation)
- Selective disclosure: prove an agent paid without revealing how much or to whom

## Architecture

Zcash is not an EVM chain. It requires a new mechanism module (parallel to `evm`, `svm`, `aptos`, `stellar`):

```
typescript/packages/mechanisms/zcash/
  src/
    index.ts          # mechanism entry point
    verify.ts         # verify payment via Zebra RPC
    settlement.ts     # memo-based payment matching
```

Payment verification uses the shielded memo field: the x402 payment ID is encoded in the Zcash transaction memo, and the facilitator verifies the payment by checking the memo against the expected payment ID via Zebra RPC.

## Reference implementation

The full Zcash x402 facilitator is available as a standalone npm package:
- [@frontiercompute/zcash-402](https://www.npmjs.com/package/@frontiercompute/zcash-402) (MCP server, 4 tools)

This PR adds the network definition and mechanism stub. The full mechanism delegates to zcash-402 for payment construction and verification.

## Network configuration

- **CAIP-2:** `zcash:mainnet` (Zcash mainnet, chain ID derived from genesis block)
- **RPC:** Zebra JSON-RPC (default `http://127.0.0.1:8232`)
- **Asset:** ZEC (8 decimals, native)
- **Memo encoding:** x402 payment ID in Zcash encrypted memo field
- **Attestation:** Optional ZAP1 Merkle receipt for payment auditability
