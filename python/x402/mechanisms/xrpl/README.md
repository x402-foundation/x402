# x402 XRPL Mechanism

XRP Ledger implementation of the x402 payment protocol using the **Exact** payment scheme
with payer-signed `Payment` transactions.

## Installation

```bash
uv add x402[xrpl]
```

## Overview

Three components for handling x402 payments on XRPL:

- **Client** (`ExactXrplClientScheme`) - Builds and signs `Payment` transactions
- **Server** (`ExactXrplServerScheme`) - Validates prices, enriches payment requirements
- **Facilitator** (`ExactXrplFacilitatorScheme`) - Verifies signed transactions and submits them

The facilitator holds no keys and never signs: the payer signs the transaction, and the
transaction carries its own network fee (`extra.areFeesSponsored` is always `false`).

## Quick Start

### Client

```python
from x402 import x402ClientSync
from x402.mechanisms.xrpl.exact import ExactXrplScheme
from xrpl.wallet import Wallet

wallet = Wallet.from_seed("s...")

client = x402ClientSync()
client.register("xrpl:*", ExactXrplScheme(wallet))

payload = client.create_payment_payload(payment_required)
```

### Server

```python
from x402 import x402ResourceServerSync
from x402.mechanisms.xrpl.exact import ExactXrplServerScheme

server = x402ResourceServerSync(facilitator_client)
server.register("xrpl:*", ExactXrplServerScheme())
```

XRPL has no on-ledger exchange rate, so prices are explicit `AssetAmount`s: integer
drops for XRP, or the issued-currency decimal value with `extra.issuer`. A money price
such as `"$0.01"` is dispatched to parsers registered with `register_money_parser()`.

### Facilitator

```python
from x402 import x402FacilitatorSync
from x402.mechanisms.xrpl.exact import ExactXrplFacilitatorScheme

facilitator = x402FacilitatorSync()
facilitator.register(
    ["xrpl:0", "xrpl:1", "xrpl:2"],
    ExactXrplFacilitatorScheme(),
)
```

`XrplFacilitatorOptions` configures the fee ceiling (`max_fee_drops`), the longest
validity window it will honour (`max_timeout_seconds`, default one hour; this bounds
both how far ahead a payment may expire and how long the duplicate guard retains it),
per-network JSON-RPC endpoints (`rpc_url_by_network`), and lets a deployment inject every
ledger interaction (reads, submission and simulation) for testing or custom
infrastructure.

## Exports

### `x402.mechanisms.xrpl.exact`

| Export | Description |
|--------|-------------|
| `ExactXrplScheme` | Client scheme (alias for `ExactXrplClientScheme`) |
| `ExactXrplClientScheme` | Client-side transaction building and signing |
| `ExactXrplServerScheme` | Server-side price validation and requirement enrichment |
| `ExactXrplFacilitatorScheme` | Facilitator verification/settlement |
| `XrplClientOptions` | Client fee, endpoint and ticket configuration |

### `x402.mechanisms.xrpl`

| Export | Description |
|--------|-------------|
| `XrplFacilitatorOptions` | Facilitator configuration and ledger-access injection |
| `SettlementCache` | Duplicate-settlement guard, shareable across scheme instances |
| `SettlementCacheLike` | Protocol a shared-store settlement guard implements |
| `XRPL_MAINNET` / `XRPL_TESTNET` / `XRPL_DEVNET` | CAIP-2 network identifiers |
| `ERR_*` | Wire reason codes; shared codes use the TypeScript spelling |

## Supported Networks

CAIP-2 format `xrpl:{network_id}`, where the id is the XRPL numeric NetworkID:

- `xrpl:0` - Mainnet
- `xrpl:1` - Testnet
- `xrpl:2` - Devnet
- any other `xrpl:{uint32}` - custom network or sidechain, given an endpoint in
  `rpc_url_by_network`

For networks with id > 1024 the signed `NetworkID` field binds the payment to one chain;
standard networks omit it per XRPL protocol rules, so wallets should use separate
accounts per standard network.

## Asset Support

- **XRP** (`asset: "XRP"`): amounts are integer drops strings
- **Issued currencies (IOU)**: 3-character or 160-bit hex currency codes with
  `extra.issuer`; amounts are exact decimal strings, compared with decimal arithmetic

## Asset Transfer Methods

`extra.assetTransferMethod` selects how the signed transaction is sequenced:

- **`sequence`** (default): consumes the account's current `Sequence`; one pending
  payment per account, no reserve
- **`ticketSequence`**: consumes a pre-created XRPL Ticket; multiple concurrent pending
  payments, each ticket locks owner reserve until spent. The client creates a ticket
  automatically when it holds none (`ticket_create_count` configures how many; `0`
  disables creation).

When the requirements omit the method, the client chooses; when they name one, it is
binding. See the [scheme specification] for the trade-offs.

## Verification

`verify` checks the envelope (accepted terms must match the requirements exactly),
decodes the blob, and enforces the scheme's rules: destination and destination tag,
network binding, exact amount (with the IOU `SendMax` policy), invoice binding via
`InvoiceID`, no partial payments / `Paths` / `DeliverMin` / `Memos` / multisig /
`Delegate`, the fee ceiling, the `LastLedgerSequence` window derived from
`maxTimeoutSeconds`, sequence or ticket state, and that the signing key is currently
authorised on the payer's account. It then simulates the transaction against the ledger,
so a payment that cannot succeed (unfunded payer, missing trust line, frozen balance)
is refused before the resource server does the work it is being paid for.

Two encodings are pinned down because the ledger pins them down: the blob must be the
canonical serialisation of the transaction it decodes to, and the signature must be in
the one form rippled accepts. Both are otherwise malleable: the same payment can be
re-encoded, or its signature rewritten without the key, into a variant that verifies and
hashes differently, which would give one payment several identities.

Field acceptance is pinned to rippled's own Payment template rather than to whatever the
installed codec can decode. The codec is type-agnostic and learns new fields with every
release, so gating on its knowledge would silently widen acceptance on upgrade — XLS-68's
`Sponsor`/`SponsorFlags`, for example, become decodable signing fields the release after
the amendment's definitions ship. A field outside the template is refused as a malformed
payload, exactly as its codec-unknown spelling is refused today, until it is admitted
deliberately.

Verification is total: any input yields a `VerifyResponse` with a machine-readable
`invalidReason`, never an exception. Codes shared with the TypeScript mechanism use its
spelling, so a client switching facilitators gets the same string for the same fault;
this implementation additionally distinguishes a disabled master key, an out-of-policy
timeout, an unusable payload, and a submission that has not validated.

## Settlement

`settle` re-verifies, submits with `fail_hard`, and polls `tx` until the ledger reports
`validated: true`; only a validated `tesSUCCESS` is reported as success. A submission
that was applied provisionally but has not validated is reported as
`transaction_not_validated`, distinct from `transaction_failed`: it may still land, so it
must not be read as either settled or definitively refused. The reported transaction id
is always computed from the signed blob rather than read back from the node.

## Duplicate Settlement Protection

XRPL submission is idempotent on the transaction hash, so concurrent `/settle` calls
carrying the same signed blob would each report success while only one payment lands. The
built-in `SettlementCache` rejects the second and subsequent attempts with
`duplicate_settlement`, retaining each entry until its transaction can no longer land
(derived from `maxTimeoutSeconds`, floor 120s). Within that window a resubmission after a
transient failure is also rejected: `duplicate_settlement` means "already seen", not
"settled successfully".

The cache is per-process. A horizontally scaled facilitator must back it with a shared
atomic store, or duplicates routed to different replicas each pass their local check.
Pass a shared `SettlementCache` instance to scheme constructors that should block each
other's duplicates within one process; across processes, pass anything satisfying the
`SettlementCacheLike` protocol. The one obligation is that test-and-record is a single
atomic operation. Redis' `SET NX EX` is exactly that:

```python
import math

import redis

class RedisSettlementCache:
    """Shared duplicate-settlement guard for a horizontally scaled facilitator."""

    def __init__(self, client: redis.Redis) -> None:
        self._client = client

    def is_duplicate(self, key: str, ttl_seconds: float) -> bool:
        stored = self._client.set(
            f"x402:xrpl:settle:{key}", "1", nx=True, ex=max(1, math.ceil(ttl_seconds))
        )
        return stored is None

facilitator = ExactXrplFacilitatorScheme(settlement_cache=RedisSettlementCache(client))
```

A database row inserted under a uniqueness constraint works the same way.

For details, see the [scheme specification]'s duplicate-settlement section.

## Trust Model

The configured XRPL node is the facilitator's trust anchor: every ledger read is
believed. A node that lies about the ledger index, account sequence or master-key flag
can only cause a rejection, but one that invents a regular key or misreports a simulation
can make `verify` pass; settlement is the backstop, so a resource server should release
resources on a successful `settle`, not on `verify` alone. Deployments that want more
should run their own node or read from several via the injectable ledger options.

[scheme specification]: ../../../../specs/schemes/exact/scheme_exact_xrpl.md
