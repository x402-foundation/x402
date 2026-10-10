# @x402/lnbtc

The x402 `exact` scheme on Bitcoin Lightning, as specified in
[`scheme_exact_lnbtc.md`](../../../../specs/schemes/exact/scheme_exact_lnbtc.md).

The resource server issues a fresh BOLT11 invoice whose signed description hash commits to the
actual request. The client pays it and returns the 32-byte preimage. The facilitator checks
`SHA-256(preimage) == payment_hash`, the invoice signature against `payTo`, and the request
binding, then atomically consumes `network:payment_hash`. It needs no access to the receiver's
node. Only the `bolt11` transfer method and the `upfront` flow are supported: settlement runs
before the handler, and the server never calls `/verify`.

| Network | CAIP-2 id | BOLT11 currency |
| --- | --- | --- |
| Mainnet | `lnbtc:000000000019d6689c085ae165831e93` | `bc` |
| Testnet | `lnbtc:000000000933ea01ad0ee984209779ba` | `tb` |

Amounts are integral millisatoshis with asset `BTC`.

## Installation

```bash
pnpm add @x402/lnbtc
```

## Node adapters

Node credentials stay in your application. Each role takes a small adapter:

- **Client** — `LightningPayer.payInvoice(invoice, network)` pays exactly the invoice amount and
  returns `{ status: "paid", preimage }` (or `in_flight` / `unpaid`). An adapter that cannot
  return the preimage cannot be used.
- **Server** — `LightningReceiver.createInvoice({ amountMsat, descriptionHash, expirySeconds })`
  creates a fresh invoice with a new preimage and the given description hash.
- **Facilitator** — `ReplayStore.consume(key, retainUntil)` atomically inserts a key and returns
  `true` only when it inserted it (`false` if it already exists; any other result counts as a
  duplicate, and a thrown error fails the settlement). It must survive restarts and be shared by every instance that
  settles for the same receiver (for example a table with a unique key). `InMemoryReplayStore`
  is for tests only.

Nostr Wallet Connect (NIP-47) wallets fit both node adapters: `make_invoice` accepts
`description_hash`, and `pay_invoice` returns the preimage. See the advanced examples.

## Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { LNBTC_MAINNET } from "@x402/lnbtc";
import { ExactLnbtcScheme, httpTransportBinding } from "@x402/lnbtc/exact/server";

server.register(
  LNBTC_MAINNET,
  new ExactLnbtcScheme({
    receiver,
    requestBinding: httpTransportBinding({
      publicOrigin: "https://api.example.com",
      boundHeaders: ["content-type"],
    }),
  }),
);
```

- `payTo` is the receiver node's compressed public key, and the server must be the only party
  able to create invoices with that key. A shared custodial node where other tenants can create
  invoices is not compatible: a tenant could pay its own invoice and present the preimage.
- `publicOrigin` is the origin clients use; the bound URL is it plus the raw path and query
  from the adapter. Adapters build their URL from request headers, so the binding requires every
  `Host`, `:authority`, and `X-Forwarded-Host` value to be a valid RFC 3986 authority, the
  URL's authority to equal one of them, and `X-Forwarded-Proto` to be a scheme token; otherwise
  the request is refused. The target is not cross-checked against `adapter.getPath()`, because
  adapters disagree on that path (Hono decodes percent escapes; Next.js drops `basePath` and the
  locale). `resource.url` must equal the bound URL: the server refuses to build a challenge
  otherwise, and clients refuse to pay. Behind a proxy, set the route's `resource` explicitly.
- `boundHeaders` must list every header that affects the purchased operation, its content
  interpretation, or account selection, even when absent.
- The binding hashes the request body bytes as received, so a paid route with a body needs a
  raw body parser (with Express, `express.raw({ type: "*/*" })` on the route); the adapter's
  body is used when it is bytes. A body already parsed (for example JSON from Hono or Next.js) is
  refused rather than re-serialized. Pass `rawBody` (it may be async) to read the bytes some other
  way. Without either, a request is treated as bodiless only when it has no `Content-Length` or
  `Transfer-Encoding` and the adapter reports no body; over HTTP/2, where those headers are
  optional, prefer `rawBody`.
- Prices are an explicit `{ asset: "BTC", amount: "<msat>" }` or `"21 sats"`. Bare numbers and
  `$` prices are rejected unless you `registerMoneyParser` a conversion.
- `allowInvoice` can rate-limit invoice issuance. Each lnbtc accept gets one fresh invoice per
  challenge. When a request carries a payment, the server issues nothing: it matches the payment
  using the client's invoice and the binding recomputed from the request.

MCP tools wrapped by `@x402/mcp` use `mcpTransportBinding({ server, boundMetadata })`. The
specification binds the tool call as the client sent it, before the tool's input schema applies
defaults or strips keys. When the server calls `@x402/mcp`'s `captureRawToolCalls(server)` before
registering tools, the binding uses that raw call (name, arguments, and `_meta`). Without it, the
binding uses the wrapper's validated arguments and the tool name from `resource.url`
(`mcp://tool/<name>`), so a paid tool whose schema adds defaults or strips keys refuses calls that
omit or add those arguments. Omitted arguments bind as `{}`; give such tools a schema that accepts
an empty object.

## Client

```typescript
import { x402Client } from "@x402/core/client";
import { httpRequestBinding } from "@x402/lnbtc";
import { ExactLnbtcScheme } from "@x402/lnbtc/exact/client";

client.register(
  "lnbtc:*",
  new ExactLnbtcScheme({
    payer,
    requestBinding: () =>
      httpRequestBinding({ method: "GET", url, boundHeaders: [], getHeader: () => undefined }),
  }),
);
```

`requestBinding` describes the request the client intends to pay for, computed from that
request, never from the challenge. The client refuses to pay an invoice bound to anything else,
an invoice not signed by `payTo`, or one whose amount, currency, or expiry differs from the
requirements. It also refuses amounts above the client's spend cap. Use `mcpToolCallBinding` for
MCP tool calls.

## Facilitator

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { LNBTC_MAINNET } from "@x402/lnbtc";
import { ExactLnbtcScheme } from "@x402/lnbtc/exact/facilitator";

facilitator.register(LNBTC_MAINNET, new ExactLnbtcScheme({ replayStore }));
```

`SettleResponse.transaction` is the payment hash. `payer` is omitted: Lightning does not reveal
one.

## Testing

```bash
pnpm --filter @x402/lnbtc test
```

The integration suite runs the full HTTP flow against two LND nodes on regtest:

```bash
test/regtest/setup.sh            # bitcoind + alice -> bob channel in Docker
pnpm --filter @x402/lnbtc test:integration
docker compose -f test/regtest/docker-compose.yml down -v
```

It reads `test/regtest/.data/env` written by `setup.sh` and skips when it is absent. The regtest
network id and `bcrt` currency are test-only; the specification defines mainnet and testnet.
