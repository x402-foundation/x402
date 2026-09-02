---
"@x402/next": minor
---

`withX402` now accepts a `RoutesConfig`, so the route's path pattern can be given explicitly (e.g. `{ "/api/users/[id]": config }`) instead of always registering a wildcard route. Passing a bare route config remains supported and unchanged. When a pattern-keyed config matches no request path, the handler runs without payment and a warning is logged once per wrapper.
