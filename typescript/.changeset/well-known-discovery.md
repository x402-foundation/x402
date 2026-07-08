---
'@x402/core': minor
'@x402/express': minor
---

Add a per-origin discovery manifest served at `/.well-known/x402.json`.

The x402 HTTP middleware now auto-serves the manifest by default (opt out with the
`serveWellKnownDiscovery` flag), generated from the same route config that produces live
`402` responses, so it stays consistent with runtime behavior and requires no facilitator.

- `@x402/core`: adds `x402HTTPResourceServer.buildDiscoveryManifest(origin)` and the
  `DiscoveryManifest` / `DiscoveryManifestResource` / `DiscoveryInput` / `DiscoveryOutput`
  types. Each item carries a `resource` object, resolved `accepts`, a lifted `input`/`output`
  invocation contract, and a lightweight `requires` capability hint.
- `@x402/express`: intercepts `GET /.well-known/x402.json` and serves the manifest.
