# x402 EVM Mechanism

EVM implementation of the x402 payment protocol using the **Exact** payment scheme with EIP-3009 TransferWithAuthorization.

## Installation

```bash
uv add x402[evm]
```

## Overview

Three components for handling x402 payments on EVM-compatible blockchains:

- **Client** (`ExactEvmClientScheme`) - Creates signed payment authorizations
- **Server** (`ExactEvmServerScheme`) - Builds payment requirements, parses prices
- **Facilitator** (`ExactEvmFacilitatorScheme`) - Verifies signatures, executes on-chain transfers

## Quick Start

### Client

```python
from x402 import x402Client
from x402.mechanisms.evm.exact import ExactEvmScheme
from x402.mechanisms.evm import EthAccountSigner
from eth_account import Account

account = Account.from_key("0x...")
signer = EthAccountSigner(account)

client = x402Client()
client.register("eip155:*", ExactEvmScheme(signer=signer))

payload = await client.create_payment_payload(payment_required)
```

### Server

```python
from x402 import x402ResourceServer
from x402.mechanisms.evm.exact import ExactEvmServerScheme

server = x402ResourceServer(facilitator_client)
server.register("eip155:*", ExactEvmServerScheme())
```

### Facilitator

```python
from x402 import x402Facilitator
from x402.mechanisms.evm.exact import ExactEvmFacilitatorScheme
from x402.mechanisms.evm import FacilitatorWeb3Signer

signer = FacilitatorWeb3Signer(web3_instance, account)

facilitator = x402Facilitator()
facilitator.register(["eip155:8453", "eip155:84532"], ExactEvmFacilitatorScheme(wallet=signer))
```

## Exports

### `x402.mechanisms.evm.exact`

| Export | Description |
|--------|-------------|
| `ExactEvmScheme` | Client scheme (alias for `ExactEvmClientScheme`) |
| `ExactEvmClientScheme` | Client-side payment creation |
| `ExactEvmServerScheme` | Server-side requirement building |
| `ExactEvmFacilitatorScheme` | Facilitator verification/settlement |
| `register_exact_evm_client()` | Helper to register client |
| `register_exact_evm_server()` | Helper to register server |
| `register_exact_evm_facilitator()` | Helper to register facilitator |

### `x402.mechanisms.evm`

| Export | Description |
|--------|-------------|
| `ClientEvmSigner` | Protocol for client signers |
| `FacilitatorEvmSigner` | Protocol for facilitator signers |
| `EthAccountSigner` | Client signer using eth-account |
| `FacilitatorWeb3Signer` | Facilitator signer using web3.py |
| `NETWORK_CONFIGS` | Network configuration mapping |
| `V1_NETWORKS` | List of V1 network names |

## Supported Networks

**V2 Networks** (CAIP-2 format):
- `eip155:1` - Ethereum Mainnet
- `eip155:8453` - Base Mainnet
- `eip155:84532` - Base Sepolia
- `eip155:*` - Wildcard (all EVM chains)

**V1 Networks** (legacy names):
- `base`, `base-sepolia`
- `polygon`, `polygon-amoy`
- `avalanche`, `avalanche-fuji`
- See `V1_NETWORKS` for full list

## Asset Support

Supports ERC-3009 compatible tokens:
- USDC (primary)
- EURC
- Any token implementing `transferWithAuthorization()`

For the current list of chains with default assets configured, see [Default Assets for Dollar-String Pricing](../../../../docs/core-concepts/network-and-token-support.mdx#default-assets-for-dollar-string-pricing) in the x402 docs. To add default asset support for a new chain, see [Adding Support for New Networks](../../../../docs/core-concepts/network-and-token-support.mdx#adding-support-for-new-networks).

## Technical Details

### EIP-3009 TransferWithAuthorization

The Exact scheme uses signed authorizations:

```python
{
    "from": "0x...",      # Payer address
    "to": "0x...",        # Recipient (payTo)
    "value": 1000000,     # Amount in token units
    "validAfter": 0,      # Unix timestamp
    "validBefore": ...,   # Expiration timestamp
    "nonce": "0x...",     # Random nonce
}
```

### Smart Wallet Support (ERC-6492)

Automatic handling of:
- Deployed smart wallets (ERC-1271 signature verification)
- Undeployed smart wallets (ERC-6492 counterfactual verification)
- EOA wallets (standard ECDSA)

