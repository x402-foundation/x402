---
'@x402/extensions': patch
---

Fix `extractDiscoveryInfo` building a broken canonical URL (`"null/..."`) for resource URLs on schemes without a WHATWG-defined origin, such as `mcp://tool/{toolName}`. The canonical is now reconstructed from `protocol` + `host` + `pathname` for any opaque-origin scheme, not just `mcp://`, which strips the query string and fragment the same way the special-scheme path already does, instead of falling back to the raw resource URL unstripped.
