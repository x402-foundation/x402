# Discovery: `/.well-known/x402.json`

> **Status:** Draft / Work in progress

## What we're adding

A **per-origin discovery manifest** served at `https://<origin>/.well-known/x402.json`
that lets agents discover an origin's x402 resources **directly from the origin** — no
facilitator required, no prior payment. It is the self-hosted counterpart to a
facilitator's `GET /discovery/resources`.

The x402 HTTP middleware **serves it automatically** (default-on): adopting x402 payments
yields the manifest for free, generated from the same route config that produces live
`402` responses — so it can't drift from runtime behavior. Opt out with a single flag.

## Manifest shape

```jsonc
{
  "x402Version": 2,
  "lastUpdated": 1781555511,
  "items": [
    {
      "resource": { "url": "https://api.example.com/weather/:city",
                    "description": "…", "mimeType": "application/json",
                    "serviceName": "…", "tags": ["…"] },     // optional fields omitted when absent
      "type": "http",                                          // http | mcp
      "accepts": [ /* PaymentRequirements[] — advisory; live 402 is authoritative */ ],
      "input": {                                               // how to call it
        "method": "GET",
        "routeTemplate": "/weather/:city",                     // dynamic routes
        "pathParams": { /* JSON Schema, when declared */ }
        // body/bodyType/queryParams (HTTP) · toolName/inputSchema/transport (MCP)
      },
      "output": { "mimeType": "application/json", "example": {…} },  // when declared
      "requires": ["sign-in-with-x"]                            // capability hint (extension keys), when present
    }
  ]
}
```

### Design decisions
- **Generate, don't maintain.** Items are a projection of the route config (same path as
  the live `402`), so there is no separate artifact to keep in sync.
- **Graceful degradation.** Only `resource`, `type`, `accepts`, and an `input` *skeleton*
  (`method` + `routeTemplate`, auto-derived from the route) are guaranteed. Richer fields
  (`pathParams`/`body`/`output` schemas, descriptions) appear only when the server declared
  them. Nothing is mandated.
- **Lifted contract, no envelope.** The invocation contract is lifted to top-level
  `input`/`output`; the verbose bazaar meta-schema envelope is dropped (it only matters for
  facilitator-relayed metadata, which a self-hosted origin doesn't have).
- **Extensions are runtime, not discovery.** Full extension payloads (SIWX challenges,
  session tokens) are **not** in the manifest — those come from the live `402`. The manifest
  carries only a lightweight `requires` capability hint so agents can decide before paying.
- **Advisory precedence.** `accepts` and schemas are advisory; the live `402` remains
  authoritative for payment.
- **Resolved once, served cached.** The route configuration is static (it only changes on a
  server restart), so the heavy resolution — turning each route's `price` into concrete
  `accepts` via the scheme + facilitator, and lifting the `bazaar` contract — runs **once** and
  is cached. The cached entries are **origin-independent**; only `resource.url` is filled in
  per request (`origin` + route path), so the manifest stays correct when the server is reached
  via multiple hostnames. `lastUpdated` reflects the one-time resolution. (Dynamic `price`
  functions resolve against an empty context to their default branch — the live `402` carries
  the per-call price; consistent with advisory precedence.)

## Implementation

| Piece | Location |
|-------|----------|
| Types (`DiscoveryManifest`, `DiscoveryManifestResource`, `DiscoveryInput`, `DiscoveryOutput`) | `typescript/packages/core/src/types/discovery.ts` |
| Manifest generator + cache (`buildDiscoveryManifest` / `resolveDiscoveryEntries`) | `typescript/packages/core/src/http/x402HTTPResourceServer.ts` |
| Auto-serve middleware + `serveWellKnownDiscovery` opt-out | `typescript/packages/http/express/src/index.ts` |
| Example server (offline, zero-config) | `examples/typescript/servers/well-known/` |

`buildDiscoveryManifest(origin)` memoizes the resolved entries (`resolveDiscoveryEntries`)
and only substitutes `origin` per call, so the per-request cost is a cheap cache read. Other
adapters (Hono/Next/Fastify) can serve the route by calling it from the same interception
point.

## Notes / open items
- Canonical location is `/.well-known/x402.json` (RFC 8615).
