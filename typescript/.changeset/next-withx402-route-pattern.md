---
"@x402/next": minor
---

`withX402` now accepts a `RoutesConfig`, so the route's path pattern can be given explicitly (e.g. `{ "/api/users/[id]": config }`) instead of always registering a wildcard route. This fixes bazaar discovery for Next.js resources: the hardcoded `*` pattern produced an auto-generated `routeTemplate` (`:var1`) that fails discovery validation, so resources were never indexed. Passing a bare route config remains supported and unchanged. When a pattern-keyed config matches no request path, the handler runs without payment and a warning is logged once per wrapper.
