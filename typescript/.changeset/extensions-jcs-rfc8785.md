---
"@x402/extensions": patch
---

Fixed `canonicalize` (offer-receipt JCS) to match RFC 8785. Strings now use ECMAScript `JSON.stringify` escaping, so `\b \t \n \f \r` are emitted as short escapes instead of `\u00XX` (previously any offer or receipt string containing a tab or newline produced different signed bytes than other RFC 8785 implementations). Lone surrogates and top-level `undefined` are now rejected, sparse array holes serialize as `null` instead of producing invalid JSON, and `toJSON` and boxed primitives are honored the way `JSON.stringify` honors them.
