---
"@x402/extensions": patch
---

Bazaar discovery no longer emits a `routeTemplate` for bare wildcard (`*`) route patterns. Previously the auto-generated `:var1` template failed CDP's required `matches_resource` check, so Next.js resources using the default `withX402()` wildcard registration were never indexed.
