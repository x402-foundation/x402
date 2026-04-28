# Commerce Scheme Example

End-to-end example demonstrating the x402 commerce payment scheme on Base Mainnet.

The commerce scheme uses `ReceiveWithAuthorization` (EIP-3009) with an escrow contract
(`AuthCaptureEscrow`) for authorize/charge settlement patterns.

## Prerequisites

- Go 1.24+
- Client wallet funded with USDC on Base Mainnet
- Operator wallet with ETH for gas on Base Mainnet
- The operator address must be `0x6Ca3B21D18E2B60291413c99DD6969c43d26c3D2` (authorized in the escrow contract)

## Setup

1. Copy `.env-example` to `.env` and fill in your values:

```bash
cp .env-example .env
```

2. Set the required environment variables:
   - `CLIENT_PRIVATE_KEY` — Private key of the payer wallet (has USDC)
   - `OPERATOR_PRIVATE_KEY` — Private key of the operator/facilitator
   - `RPC_URL` — Base Mainnet RPC endpoint
   - `RECEIVER_ADDRESS` — Address that will receive the payment

## Contract Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| AuthCaptureEscrow | `0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff` |
| ERC3009PaymentCollector | `0x0E3dF9510de65469C4518D7843919c0b8C7A7757` |
| Operator | `0x6Ca3B21D18E2B60291413c99DD6969c43d26c3D2` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Running

```bash
cd examples/go/commerce
go run .
```

## Flow

1. **Server** builds payment requirements with commerce-specific fields (escrow, operator, tokenCollector)
2. **Client** creates a `ReceiveWithAuthorization` payload with deterministic nonce derived from PaymentInfo
3. **Facilitator** verifies the payload (signature, amounts, addresses)
4. **Facilitator** settles by calling `AuthCaptureEscrow.authorize()` which pulls funds via the token collector

## Key Differences from Exact Scheme

- Uses `ReceiveWithAuthorization` instead of `TransferWithAuthorization`
- Funds go to `tokenCollector` (not directly to recipient)
- Deterministic nonce derived from payment parameters (not random)
- Settlement calls escrow contract (not token directly)
- Amount must match exactly (not `>=`)
