---
"@x402/extensions": minor
---

Require a configured `origin` for SIWX server integration. Challenge issuance and proof validation now bind to this operator-defined public origin instead of deriving trust from request headers, route resources, or per-route declaration fields.

**Migration:** pass `origin` when creating the resource server extension or request hook:

```typescript
createSIWxResourceServerExtension({
  storage,
  origin: "https://api.example.com",
});
```

Remove `domain` and `resourceUri` from `declareSIWxExtension()` — configure the public origin once at the server level. Behind TLS-terminating reverse proxies, set `origin` to the browser-visible URL (for example `https://api.example.com`), not the upstream listener address.
