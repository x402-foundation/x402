# x402 TVM Mechanism

TON/TVM implementation of the x402 payment protocol using the **Exact** payment scheme with jetton transfers relayed through W5R1 and highload-wallet-v3 wallets.

## Installation

```bash
uv add x402[tvm]
```

## Overview

Three components for handling x402 payments on TVM-compatible networks:

- **Client** (`ExactTvmClientScheme`) - Creates signed W5R1 payment payloads
- **Server** (`ExactTvmServerScheme`) - Builds payment requirements and parses prices
- **Facilitator** (`ExactTvmFacilitatorScheme`) - Verifies payloads and relays settlements on-chain

`ExactTvmScheme` in `x402.mechanisms.tvm.exact` is an alias for the client scheme (`ExactTvmClientScheme`).

## Quick Start

### Client

```python
import os

from x402 import x402Client
from x402.mechanisms.tvm import TVM_TESTNET, WalletV5R1Config, WalletV5R1MnemonicSigner
from x402.mechanisms.tvm.exact import ExactTvmScheme

config = WalletV5R1Config.from_private_key(
    TVM_TESTNET,
    os.environ["TVM_CLIENT_PRIVATE_KEY"],
)
config.api_key = os.environ.get("TONCENTER_API_KEY")

signer = WalletV5R1MnemonicSigner(config)

client = x402Client()
client.register(TVM_TESTNET, ExactTvmScheme(signer=signer))

payload = await client.create_payment_payload(payment_required)
```

Call `scheme.close()` when you are done with a long-lived `ExactTvmScheme` so its cached Toncenter HTTP clients are released.

### Server

```python
from x402 import x402ResourceServer
from x402.mechanisms.tvm.exact import ExactTvmServerScheme

server = x402ResourceServer(facilitator_client)
server.register("tvm:*", ExactTvmServerScheme())
```

### Facilitator

```python
import os

from x402 import x402Facilitator
from x402.mechanisms.tvm import HighloadV3Config, TVM_TESTNET, FacilitatorHighloadV3Signer
from x402.mechanisms.tvm.exact import ExactTvmFacilitatorScheme

config = HighloadV3Config.from_private_key(os.environ["TVM_FACILITATOR_PRIVATE_KEY"])
config.api_key = os.environ.get("TONCENTER_API_KEY")

signer = FacilitatorHighloadV3Signer({TVM_TESTNET: config})

facilitator = x402Facilitator()
facilitator.register([TVM_TESTNET], ExactTvmFacilitatorScheme(signer))
```

## Exports

### `x402.mechanisms.tvm.exact`

| Export                             | Description                                      |
| ---------------------------------- | ------------------------------------------------ |
| `ExactTvmScheme`                   | Client scheme (alias for `ExactTvmClientScheme`) |
| `ExactTvmClientScheme`             | Client-side payment creation                     |
| `ExactTvmServerScheme`             | Server-side requirement building                 |
| `ExactTvmFacilitatorScheme`        | Facilitator verification/settlement              |
| `register_exact_tvm_client()`      | Helper to register client                        |
| `register_exact_tvm_server()`      | Helper to register server                        |
| `register_exact_tvm_facilitator()` | Helper to register facilitator                   |

### `x402.mechanisms.tvm`

| Export                        | Description                                 |
| ----------------------------- | ------------------------------------------- |
| `ClientTvmSigner`             | Protocol for client signers                 |
| `FacilitatorTvmSigner`        | Protocol for facilitator signers            |
| `WalletV5R1MnemonicSigner`    | Client signer using a W5R1 wallet           |
| `FacilitatorHighloadV3Signer` | Facilitator signer using highload-wallet-v3 |
| `ToncenterRestClient`         | Toncenter provider client                   |
| `TVM_MAINNET`                 | TON mainnet CAIP-2 identifier               |
| `TVM_TESTNET`                 | TON testnet CAIP-2 identifier               |

## Supported Networks

- `tvm:-239` - TON mainnet
- `tvm:-3` - TON testnet
- `tvm:*` - Wildcard (all supported TVM chains)

## Asset Support

Supports [TEP-74](https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md) jetton payments with explicit asset requirements:

- Mainnet USDT (`USDT_MAINNET_MINTER`)
- Testnet USDT (`USDT_TESTNET_MINTER`)
- Any TEP-74 jetton when the server is given an explicit asset address

Server-side prices may be supplied as:

- `AssetAmount(...)` or `{"amount": "...", "asset": "..."}` for an explicit jetton
- `int`, `float`, or strings like `"$0.01"` and `"0.01 USDT"` for built-in USDT conversion

For non-default jettons, provide either:

- the amount in atomic units, or
- `extra.decimals` so decimal amounts can be normalized correctly

## Technical Details

### Client Wallet Format

The TVM client flow uses Wallet V5R1:

1. Build wallet state init from the configured private key
2. Read account state and seqno from Toncenter
3. Derive the payer jetton wallet for the configured asset
4. Create a signed W5R1 internal message targeting the payer wallet
5. Wrap the message as a base64 BOC settlement payload

The signer network must match the selected payment requirement network.

### Facilitator Settlement Flow

The facilitator batches relay requests through a highload-wallet-v3 account:

1. Verify the settlement BOC, signature, wallet code hash, wallet id, seqno, timeout, and jetton transfer
2. Reserve the settlement in `SettlementCache` to reject duplicate settlements
3. Batch valid relay requests per network
4. Send the batched external message through the facilitator wallet
5. Wait for finalized trace confirmation through Toncenter APIs

Call `signer.close()` when you are done with a long-lived facilitator signer so its Toncenter clients and streaming watchers are released.
