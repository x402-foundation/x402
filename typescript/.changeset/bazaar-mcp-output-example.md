---
"@x402/extensions": patch
---

`declareDiscoveryExtension` for MCP tools no longer restricts `output.example` to a JSON object. A text, array or number example (for example the text an MCP tool returns) made the declared extension fail its own schema, so `validateDiscoveryExtension` rejected it. The output example schema is now unconstrained unless `output.schema` is given, as in the Python SDK and the bazaar spec's MCP schema, and falsy examples such as `0` are kept.
