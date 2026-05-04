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
from x402.mechanisms.tvm import (
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
    WalletV5R1Config,
    WalletV5R1MnemonicSigner,
)
from x402.mechanisms.tvm.exact import ExactTvmScheme

config = WalletV5R1Config.from_private_key(
    TVM_TESTNET,
    os.environ["TVM_CLIENT_PRIVATE_KEY"],
)
config.api_key = os.environ.get("TONCENTER_API_KEY")
# Optional: switch REST + compatible streaming routes to TonAPI.
# config.provider = TVM_PROVIDER_TONAPI
# config.api_key = os.environ.get("TONAPI_API_KEY")
# config.provider_base_url = os.environ.get("TONAPI_BASE_URL")

signer = WalletV5R1MnemonicSigner(config)

client = x402Client()
client.register(TVM_TESTNET, ExactTvmScheme(signer=signer))

payload = await client.create_payment_payload(payment_required)
```

Call `scheme.close()` when you are done with a long-lived `ExactTvmScheme` so its cached provider HTTP clients are released.

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
from x402.mechanisms.tvm import (
    FacilitatorHighloadV3Signer,
    HighloadV3Config,
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
)
from x402.mechanisms.tvm.exact import ExactTvmFacilitatorScheme

config = HighloadV3Config.from_private_key(os.environ["TVM_FACILITATOR_PRIVATE_KEY"])
config.api_key = os.environ.get("TONCENTER_API_KEY")
# Optional: switch REST + compatible streaming routes to TonAPI.
# config.provider = TVM_PROVIDER_TONAPI
# config.api_key = os.environ.get("TONAPI_API_KEY")
# config.provider_base_url = os.environ.get("TONAPI_BASE_URL")

signer = FacilitatorHighloadV3Signer({TVM_TESTNET: config})

facilitator = x402Facilitator()
facilitator.register([TVM_TESTNET], ExactTvmFacilitatorScheme(signer))
```

## Exports

### `x402.mechanisms.tvm.exact`

| Export                      | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `ExactTvmScheme`            | Client scheme (alias for `ExactTvmClientScheme`) |
| `ExactTvmClientScheme`      | Client-side payment creation                     |
| `ExactTvmServerScheme`      | Server-side requirement building                 |
| `ExactTvmFacilitatorScheme` | Facilitator verification/settlement              |

### `x402.mechanisms.tvm`

| Export                        | Description                                 |
| ----------------------------- | ------------------------------------------- |
| `ClientTvmSigner`             | Protocol for client signers                 |
| `FacilitatorTvmSigner`        | Protocol for facilitator signers            |
| `WalletV5R1MnemonicSigner`    | Client signer using a W5R1 wallet           |
| `FacilitatorHighloadV3Signer` | Facilitator signer using highload-wallet-v3 |
| `ToncenterRestClient`         | Toncenter provider client                   |
| `TonapiRestClient`            | TonAPI provider client                      |
| `create_tvm_provider_client`  | Provider factory                            |
| `TVM_PROVIDER_TONCENTER`      | Toncenter provider selector                 |
| `TVM_PROVIDER_TONAPI`         | TonAPI provider selector                    |
| `TVM_MAINNET`                 | TON mainnet CAIP-2 identifier               |
| `TVM_TESTNET`                 | TON testnet CAIP-2 identifier               |

## Provider Selection

Toncenter remains the default provider. Set `config.provider = TVM_PROVIDER_TONAPI` on `WalletV5R1Config` or `HighloadV3Config` to switch REST calls and facilitator streaming to TonAPI.

- Toncenter REST defaults: `https://toncenter.com`, `https://testnet.toncenter.com`
- TonAPI REST defaults: `https://tonapi.io`, `https://testnet.tonapi.io`

`config.api_key` is used as `X-Api-Key` for Toncenter and `Authorization: Bearer <key>` for TonAPI. For custom deployments, set `config.provider_base_url`, `config.provider_timeout_seconds`, and `config.provider_emulation_timeout_seconds`.

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

## Testnet funding

To fund a TVM payer wallet, request testnet TON from [@testgiver_ton_bot](https://t.me/testgiver_ton_bot) for fees. Then open the [testnet USDT transfer link](https://app.tonkeeper.com/transfer/kQDNUDJC0iQvJoZp0ml-YteL1NtTXKphU03CTI5v4VtBhGYs?amount=49000000&bin=te6cckEBAQEAFgAAKClXdJkAAAAAAAAAAAAAAAAAmJaAhDUekg) or scan the QR code below to obtain testnet USDT:

The facilitator wallet also needs testnet TON (no USDT required) and must hold **at least 1.1 TON** before running tests.

> **Note:** the facilitator uses a highload-wallet-v3 account, so the facilitator's wallet address differs from your W5 address — fund the highload-v3 address, not the W5 one derived from the same key.

<img width="228" height="228" alt="QR code for the testnet USDT transfer link" src="https://github.com/user-attachments/assets/da09ad03-388d-4960-88bf-afbacf4a7c65" />

## Technical Details

### Client Wallet Format

The TVM client flow uses Wallet V5R1:

1. Build wallet state init from the configured private key
2. Read account state and seqno from the configured TVM provider
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
5. Wait for finalized trace confirmation through the configured provider APIs

Call `signer.close()` when you are done with a long-lived facilitator signer so its provider clients and streaming watchers are released.
