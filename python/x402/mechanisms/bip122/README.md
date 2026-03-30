# x402 BIP-122 Mechanism

Bitcoin Lightning implementation of the x402 payment protocol using the `exact`
payment scheme with BOLT11 invoices.

## Installation

```bash
uv add x402[lightning]
```

## Overview

Three components for handling x402 payments on Bitcoin Lightning:

- `ExactBip122ClientScheme` pays a BOLT11 invoice through a `LightningPayer`
- `ExactBip122ServerScheme` builds invoice-backed payment requirements
- `ExactBip122FacilitatorScheme` verifies paid invoices and returns `payment_hash`

## Quick Start

### Client

```python
from x402 import x402Client
from x402.mechanisms.bip122.exact import ExactBip122Scheme

client = x402Client()
client.register("bip122:*", ExactBip122Scheme(payer=lightning_payer))
```

### Server

```python
from x402 import x402ResourceServer
from x402.mechanisms.bip122.exact import ExactBip122ServerScheme

server = x402ResourceServer(facilitator_client)
server.register("bip122:*", ExactBip122ServerScheme(receiver=lightning_receiver))
```

### Facilitator

```python
from x402 import x402Facilitator
from x402.mechanisms.bip122.exact import ExactBip122FacilitatorScheme

facilitator = x402Facilitator()
facilitator.register(
    ["bip122:000000000019d6689c085ae165831e93"],
    ExactBip122FacilitatorScheme(receiver=lightning_receiver),
)
```

## Exports

### `x402.mechanisms.bip122.exact`

| Export | Description |
|--------|-------------|
| `ExactBip122Scheme` | Client scheme (alias for `ExactBip122ClientScheme`) |
| `ExactBip122ClientScheme` | Client-side invoice payment |
| `ExactBip122ServerScheme` | Server-side invoice generation |
| `ExactBip122FacilitatorScheme` | Facilitator verification/settlement |
| `register_exact_bip122_client()` | Helper to register client |
| `register_exact_bip122_server()` | Helper to register server |
| `register_exact_bip122_facilitator()` | Helper to register facilitator |

### `x402.mechanisms.bip122`

| Export | Description |
|--------|-------------|
| `LightningPayer` | Protocol for client payer adapters |
| `LightningReceiver` | Protocol for server/facilitator receiver adapters |
| `ExactBip122Payload` | BOLT11 payload wrapper |
| `LightningInvoiceStatus` | Normalized invoice state |
| `SettlementCache` | Duplicate settlement protection |
| `sat_to_msat()` | Convert sats to millisatoshis |
| `msat_to_sat()` | Convert millisatoshis to sats |

## Supported Networks

- `bip122:000000000019d6689c085ae165831e93` - Bitcoin Mainnet
- `bip122:000000000933ea01ad0ee984209779ba` - Bitcoin Testnet
- `bip122:*` - Wildcard (all supported BIP-122 Bitcoin networks)

## Price Semantics

By default, server-side `parse_price()` treats money values as satoshis and
converts them to millisatoshis internally:

- `100` -> `100000` msat
- `0.1` -> `100` msat

If you need fiat pricing or external rate lookup, register a custom money parser
on `ExactBip122ServerScheme`.

## Technical Details

- `asset` is always `"BTC"`
- `pay_to` is always normalized to `"anonymous"`
- `extra.paymentMethod` is always `"lightning"`
- `extra.invoice` carries the BOLT11 invoice string
- `SettleResponse.transaction` returns the invoice `payment_hash`

