# Extension: `crosschain-swap`

## Overview

`crosschain-swap` lets a resource server advertise which origin networks and assets a client could pay from when it does not hold the destination asset, with indicative prices. It is a **discovery** extension: it describes routes, it does not create a payment path. The only payable entries in a 402 are those in `accepts[]`.

It complements cross-chain asset transfer methods in the client-submitted (payment proof) family (see [`scheme_exact.md`](../schemes/exact/scheme_exact.md)).

## Extension Identifier

`crosschain-swap`

## Wire Format

Server → client, in the `extensions` object of the `PaymentRequired` response.

```jsonc
{
  "extensions": {
    "crosschain-swap": {
      "info": {
        "provider": "near-intents",
        "destination": {
          "network": "eip155:8453",
          "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "amount": "1000000"
        },
        "origins": [
          { "network": "eip155:42161", "asset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "indicativeAmount": "1005000", "timeEstimate": 120 },
          { "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "indicativeAmount": "1006000", "timeEstimate": 120 },
          { "network": "bip122:000000000019d6689c085ae165831e93", "asset": "BTC", "indicativeAmount": "1520", "timeEstimate": 1800 }
        ],
        "expires": "2026-09-04T15:10:00Z"
      }
    }
  }
}
```

| Field | Presence | Description |
| --- | --- | --- |
| `info.provider` | OPTIONAL | Settlement provider identifier. Free-form. |
| `info.destination.network` | REQUIRED | CAIP-2 of the network the merchant receives on. |
| `info.destination.asset` | REQUIRED | Asset the merchant receives. |
| `info.destination.amount` | REQUIRED | Amount the merchant receives, in base units. |
| `info.origins[]` | REQUIRED | Origin routes. One entry per (network, asset). |
| `origins[].network` | REQUIRED | CAIP-2 of the origin network. |
| `origins[].asset` | REQUIRED | Origin asset, in the identifier the corresponding `accepts[]` entry uses. |
| `origins[].indicativeAmount` | OPTIONAL | Approximate amount the client would pay, in base units of `asset`. Non-binding. |
| `origins[].timeEstimate` | OPTIONAL | Approximate settlement time in seconds. |
| `info.expires` | OPTIONAL | RFC 3339 time after which indicative amounts SHOULD be treated as stale. |

## Server Behavior
- Origins listed MUST be routes the server is able to accept via a cross-chain asset transfer method, whether or not a payable `accepts[]` entry is offered for them in this response.
- `indicativeAmount` MUST be derived without allocating a payment instrument (for the NEAR Intents backend, a `dry: true` quote). Servers SHOULD cache indicative amounts across requests.
- Servers SHOULD keep `destination` consistent with the same-network `accepts[]` entry when one is present.

## Client Behavior
- Clients MUST NOT construct a payment from this extension. A payable route is one with a matching `accepts[]` entry (`network` and `asset` equal).
- Clients MAY use `origins[]` to determine whether a route exists for an asset they hold, and `indicativeAmount` to estimate cost before selecting an entry. Indicative amounts MUST NOT be treated as the amount to pay, the amount to pay is `accepts[].amount`.
- Clients that do not implement this extension ignore it and are unaffected.

## Relationship to `accepts[]`
A server offering cross-chain payment includes payable `accepts[]` entries for the origins it has quoted, on the origin network with a payment instrument as `payTo`. This extension may list a superset of those origins. An origin listed here but absent from `accepts[]` is visible but not payable from this response.

## Security Considerations
- The extension carries no instrument and no proof, it cannot cause funds to move.
- `destination` discloses the merchant's receiving network and asset. Servers that do not wish to disclose this SHOULD omit the extension.
