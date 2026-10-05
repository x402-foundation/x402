# Cardano

The Python SDK implements x402 v2 `exact` payments for Cardano, matching the
[Cardano scheme](../../../../specs/schemes/exact/scheme_exact_cardano.md): direct
payments (`default`), generic script outputs (`script`), and Masumi escrow locks
(`masumi`). The client signs the complete transaction; the facilitator verifies
and broadcasts those bytes. The buyer pays fees and minimum UTxO deposits.

Install the optional dependencies:

```sh
pip install 'x402[cardano]'
```

## Server

Register the scheme through the existing v2 resource server API:

```python
from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.mechanisms.cardano.exact import ExactCardanoServerScheme

facilitator = HTTPFacilitatorClientSync(FacilitatorConfig(url="http://localhost:4022"))
server = x402ResourceServerSync(facilitator)
server.register("cardano:*", ExactCardanoServerScheme())
server.initialize()
```

Use `cardano:mainnet`, `cardano:preprod` or `cardano:preview`. CIP-34 aliases are
also accepted. Dollar prices resolve to USDM on mainnet and Preprod; Preview
requires an explicit asset. An explicit ADA price is
`{"asset": "lovelace", "amount": "5000000"}`. Native tokens use
`<56 lowercase policy hex>.<asset-name hex>` and atomic integer amounts.
Direct ADA amounts must cover the receiving output's minimum UTxO value.

## Client

```python
import os

from x402 import x402ClientSync
from x402.mechanisms.cardano import (
    BlockfrostConfig,
    CardanoProviderConfig,
    ClientCardanoSignerConfig,
    to_client_cardano_signer,
)
from x402.mechanisms.cardano.exact import ExactCardanoClientScheme

provider = CardanoProviderConfig(
    blockfrost=BlockfrostConfig(
        "https://cardano-preprod.blockfrost.io/api/v0",
        os.environ["BLOCKFROST_PROJECT_ID"],
    )
)
signer = to_client_cardano_signer(
    ClientCardanoSignerConfig(
        mnemonic=os.environ["CARDANO_MNEMONIC"],
        network="cardano:preprod",
        provider=provider,
    )
)
client = x402ClientSync().register("cardano:*", ExactCardanoClientScheme(signer))
# Pass this client to the existing requests, httpx or MCP adapter.
# Close the signer when the application shuts down.
```

The default client spend controls recognize USDM. Configure an explicit spend
policy for ADA or custom native tokens. A custom wallet can instead implement
`ClientCardanoSigner`: `get_address()` and
`build_and_sign_payment_transaction(ClientCardanoSignInput)`, returning an
`ExactCardanoPayload`. Scheme and signer methods are synchronous, following the
Python SDK's existing mechanism interfaces.

## Facilitator and confirmation policy

```python
from x402 import x402FacilitatorSync
from x402.mechanisms.cardano import (
    FacilitatorCardanoSignerConfig,
    to_facilitator_cardano_signer,
)
from x402.mechanisms.cardano.exact import ExactCardanoFacilitatorScheme

relay = to_facilitator_cardano_signer(
    FacilitatorCardanoSignerConfig(
        network="cardano:preprod", provider=provider, await_confirmation=False
    )
)
facilitator = x402FacilitatorSync().register(
    ["cardano:preprod"], ExactCardanoFacilitatorScheme(relay)
)
```

A facilitator needs no mnemonic or funds. Blockfrost supplies transaction
inclusion and confirmation depth; Koios is also supported via `KoiosConfig`,
with confirmation waiting enabled and depth limited to canonical inclusion.
Provider requests default to a 10-second timeout.

Verification, submission and confirmation polling are synchronous. In an async
HTTP application, offload the complete operation so unrelated requests can run:

```python
import asyncio

# `facilitator` above is x402FacilitatorSync.
result = await asyncio.to_thread(facilitator.settle, payload, requirements)
```

Use the same pattern for `verify`. The advanced facilitator example retains its
async hooks by running the entire Cardano lifecycle in a worker event loop.
Hooks used that way must create loop-bound resources in that worker, rather than
reuse async clients attached to the HTTP server's event loop.

`extra.confirmationPolicy = {"l1Confirmations": 1}` is the default. Zero means
canonical inclusion; positive depths count newer blocks. Mempool acceptance
(`-1`) additionally requires facilitator `accept_mempool=True`. Below the
requested depth, settlement returns `settlement_pending` with the transaction
ID. Retry the same signed payload; the facilitator reconciles it without
broadcasting again. Applications must preserve that payload across pending
retries instead of creating a second payment transaction.

`InMemoryCardanoSettlementStore` and `InMemoryMasumiTermsStorage` are bounded,
process-local stores. Multiple replicas require shared implementations of their
atomic storage protocols. A custom signer may add a complete
`validate_phase1_transaction` hook; balance-changing transactions and spending
script inputs require it. Ordinary funding inputs must carry the matching key
witnesses.

## Script and Masumi payments

A script route supplies `assetTransferMethod: "script"`, either `scriptHash` or
`script: {"type": "plutusV3", "code": "..."}`, and optional ordered `parameters`
and CBOR-hex `datum`. The facilitator reconstructs the script payment credential.
Contract-specific datum meaning is the application's responsibility.

Masumi routes use an escrow address from `masumi_escrow_address(network)` and a
stable `{"assetTransferMethod": "masumi"}` template. Configure per-request quote
issuance on the resource server:

```python
from x402.mechanisms.cardano import (
    MasumiIssuerConfig,
    masumi_escrow_address,
    to_masumi_seller_signer,
)

seller = to_masumi_seller_signer(os.environ["SERVER_CARDANO_SELLER_MNEMONIC"], "cardano:preprod")
server_scheme = ExactCardanoServerScheme(masumi=MasumiIssuerConfig(seller))
escrow = masumi_escrow_address("cardano:preprod")
```

The issuer signs fresh terms and commits to the protected resource. Applications
can provide their own commitment callback. The client verifies seller CIP-8
authorization and all commitment contents before selecting funds. Omitted request
contents must be supplied through `masumi_request_content`. Custom deployments
and nonempty registry claims require explicit validation callbacks. The client
also limits collateral and the deadline horizon. This implementation covers the
escrow lock; later release, refund and dispute operations remain outside x402.

## Verification

From the repository root:

```sh
uv run --project python/x402 --all-extras --group dev pytest python/x402/tests/unit
uv run --project python/x402 --all-extras --group dev --with pytest-cov pytest \
  python/x402/tests/unit/mechanisms/cardano --cov=x402.mechanisms.cardano
uv run --project python/x402 --all-extras --group dev pytest \
  python/x402/tests/integrations/test_cardano.py
```

Unit tests are offline and include TypeScript codec/hash vectors, real Ed25519
signatures, PyCardano transaction construction, quote binding, and concurrent
settlement/retry checks. Live integration tests require the Preprod environment
variables documented in their module; they submit real testnet transactions.
The shared e2e catalog enables Python HTTP/MCP clients, servers and facilitators
alongside TypeScript for all three transfer methods.
