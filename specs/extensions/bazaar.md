# Extension: `bazaar`

## Summary

The `bazaar` extension enables **resource discovery and cataloging** for x402-enabled endpoints and MCP tools. Resource servers declare their endpoint specifications (HTTP method or MCP tool name, input parameters, and output format) so that facilitators can catalog and index them in a discovery service.

---

## `PaymentRequired`

A resource server advertises its endpoint specification by including the `bazaar` extension in the `extensions` object of the **402 Payment Required** response.

The extension follows the standard v2 pattern:
- **`info`**: Contains the actual discovery data (HTTP method or MCP tool name, input parameters, and output format)
- **`schema`**: JSON Schema that validates the structure of `info`

The `info.input` object uses a discriminated union type, distinguished by the `type` field:
- `input.type: "http"` — HTTP endpoints (further discriminated by `method` into query parameter methods vs body methods)
- `input.type: "mcp"` — MCP (Model Context Protocol) tools

### Example: GET Endpoint

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/weather",
    "description": "Weather data endpoint",
    "mimeType": "application/json"
  },
  "accepts": [ ... ],
  "extensions": {
    "bazaar": {
      "info": {
        "input": {
          "type": "http",
          "method": "GET",
          "queryParams": {
            "city": "San Francisco"
          }
        },
        "output": {
          "type": "json",
          "example": {
            "city": "San Francisco",
            "weather": "foggy",
            "temperature": 60
          }
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "input": {
            "type": "object",
            "properties": {
              "type": { "type": "string", "const": "http" },
              "method": { "type": "string", "enum": ["GET", "HEAD", "DELETE"] },
              "queryParams": {
                "type": "object",
                "properties": {
                  "city": { "type": "string" }
                },
                "required": ["city"]
              },
              "headers": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                }
              }
            },
            "required": ["type", "method"],
            "additionalProperties": false
          },
          "output": {
            "type": "object",
            "properties": {
              "type": { "type": "string" },
              "example": { "type": "object" }
            },
            "required": ["type"]
          }
        },
        "required": ["input"]
      }
    }
  }
}
```

### Example: POST Endpoint

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/search",
    "description": "Search endpoint",
    "mimeType": "application/json"
  },
  "accepts": [ ... ],
  "extensions": {
    "bazaar": {
      "info": {
        "input": {
          "type": "http",
          "method": "POST",
          "bodyType": "json",
          "body": {
            "query": "example"
          }
        },
        "output": {
          "type": "json",
          "example": {
            "results": []
          }
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "input": {
            "type": "object",
            "properties": {
              "type": { "type": "string", "const": "http" },
              "method": { "type": "string", "enum": ["POST", "PUT", "PATCH"] },
              "bodyType": { "type": "string", "enum": ["json", "form-data", "text"] },
              "body": { "type": "object" },
              "queryParams": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                }
              },
              "headers": {
                "type": "object",
                "additionalProperties": {
                  "type": "string"
                }
              }
            },
            "required": ["type", "method", "bodyType", "body"],
            "additionalProperties": false
          },
          "output": {
            "type": "object",
            "properties": {
              "type": { "type": "string" },
              "example": { "type": "object" }
            },
            "required": ["type"]
          }
        },
        "required": ["input"]
      }
    }
  }
}
```

### Example: MCP Tool

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://api.example.com/mcp",
    "description": "Advanced AI-powered financial tools",
    "mimeType": "application/json"
  },
  "accepts": [ ... ],
  "extensions": {
    "bazaar": {
      "info": {
        "input": {
          "type": "mcp",
          "tool": "financial_analysis",
          "description": "Advanced AI-powered financial analysis",
          "inputSchema": {
            "type": "object",
            "properties": {
              "ticker": { "type": "string" },
              "analysis_type": { "type": "string", "enum": ["quick", "deep"] }
            },
            "required": ["ticker"]
          },
          "example": {
            "ticker": "AAPL",
            "analysis_type": "deep"
          }
        },
        "output": {
          "type": "json",
          "example": {
            "summary": "Strong fundamentals...",
            "score": 8.5
          }
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "input": {
            "type": "object",
            "properties": {
              "type": { "type": "string", "const": "mcp" },
              "tool": { "type": "string" },
              "description": { "type": "string" },
              "transport": { "type": "string", "enum": ["streamable-http", "sse"] },
              "inputSchema": { "type": "object" },
              "example": { "type": "object" }
            },
            "required": ["type", "tool", "inputSchema"],
            "additionalProperties": false
          },
          "output": {
            "type": "object",
            "properties": {
              "type": { "type": "string" },
              "example": { "type": "object" }
            },
            "required": ["type"]
          }
        },
        "required": ["input"]
      }
    }
  }
}
```

---

## Discovery Info Structure

### Input Types

The `info.input` object describes how to call the endpoint or tool.

#### Query Parameter Methods (GET, HEAD, DELETE)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Always `"http"` |
| `method` | string | Yes | One of `"GET"`, `"HEAD"`, `"DELETE"` |
| `queryParams` | object | No | Query parameter examples |
| `headers` | object | No | Custom header examples |

#### Body Methods (POST, PUT, PATCH)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Always `"http"` |
| `method` | string | Yes | One of `"POST"`, `"PUT"`, `"PATCH"` |
| `bodyType` | string | Yes | One of `"json"`, `"form-data"`, `"text"` |
| `body` | object/string | Yes | Request body example |
| `queryParams` | object | No | Query parameter examples |
| `headers` | object | No | Custom header examples |

#### MCP Tools

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Always `"mcp"` |
| `tool` | string | Yes | MCP tool name (matches what's passed to `tools/call`) |
| `description` | string | No | Human-readable description of the tool |
| `inputSchema` | object | Yes | JSON Schema for the tool's `arguments`, following the MCP [`Tool.inputSchema`](https://spec.modelcontextprotocol.io/) format (a JSON Schema subset with `type: "object"`, `properties`, and `required`). Servers should reuse the same schema their MCP tool already declares. |
| `transport` | string | No | MCP transport protocol. One of `"streamable-http"` or `"sse"`. Defaults to `"streamable-http"` if omitted. |
| `example` | object | No | Example `arguments` object |

> **Note:** For MCP tools, the unique resource identifier is the tuple (`resource.url`, `input.tool`). Since MCP multiplexes multiple tools over a single server endpoint, `resource.url` alone may not be unique. Facilitators **must** use both fields when cataloging MCP tools.

### Output Types

The `info.output` object (optional) describes the expected response format:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Response content type (e.g., `"json"`, `"text"`) |
| `format` | string | No | Additional format information |
| `example` | any | No | Example response value |

> **Note:** For MCP tools, if `output` is omitted, facilitators should assume arbitrary text content (MCP's default response type).

### Input Type Discriminator

The `input.type` field acts as a discriminator for the discovery info structure:

| `input.type` | Structure | Description |
|--------------|-----------|-------------|
| `"http"` | QueryDiscoveryInfo | HTTP GET/HEAD/DELETE with query parameters |
| `"http"` | BodyDiscoveryInfo | HTTP POST/PUT/PATCH with request body (has `bodyType`) |
| `"mcp"` | MCPDiscoveryInfo | MCP tool invocation |

Facilitators should use `input.type` to determine which validation rules apply. For HTTP inputs, the presence of `bodyType` further distinguishes between query and body methods.

---

## Schema Validation

The `schema` field contains a JSON Schema (Draft 2020-12) that validates the structure of `info`.

**Requirements:**
- Must use JSON Schema Draft 2020-12
- Must define an `input` property (required)
- May define an `output` property (optional)
- Must validate that `input.type` equals `"http"` (for HTTP endpoints) or `"mcp"` (for MCP tools)
- For HTTP endpoints: Must validate the appropriate `method` enum based on operation type
- For MCP tools: Must require `tool` and `inputSchema` fields

Facilitators **must** validate `info` against `schema` before cataloging.

### MCP Schema Example

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "input": {
      "type": "object",
      "properties": {
        "type": { "type": "string", "const": "mcp" },
        "tool": { "type": "string" },
        "description": { "type": "string" },
        "transport": { "type": "string", "enum": ["streamable-http", "sse"] },
        "inputSchema": { "type": "object" },
        "example": { "type": "object" }
      },
      "required": ["type", "tool", "inputSchema"],
      "additionalProperties": false
    },
    "output": {
      "type": "object",
      "properties": {
        "type": { "type": "string" },
        "example": {}
      },
      "required": ["type"]
    }
  },
  "required": ["input"]
}
```

---

## Facilitator Behavior

When a facilitator receives a `PaymentPayload` containing the `bazaar` extension, it should:

1. **Validate** the `info` field against the provided `schema`
2. **Extract** the discovery information (resource URL, HTTP method or MCP tool name, input/output specs)

How a facilitator stores, indexes, and exposes discovered resources is an implementation detail. Facilitators may choose to catalog resources in a database, expose them via a discovery API, or process them in any manner they see fit.

### Settlement Response Header

After processing a `PaymentPayload`, a facilitator **MAY** append an `EXTENSION-RESPONSES` HTTP header to the settlement response to communicate extension-specific outcomes to the client.

**Header name:** `EXTENSION-RESPONSES`

**Header value:** A base64-encoded JSON object keyed by extension name. The `bazaar` key contains the bazaar extension's response:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bazaar.status` | string | Yes | One of `"success"`, `"processing"`, or `"rejected"` |
| `bazaar.rejectedReason` | string | No | Human-readable explanation. Only present when `status` is `"rejected"` |

**Status values:**

| Value | Meaning |
|-------|---------|
| `"success"` | The discovery info was validated and successfully cataloged |
| `"processing"` | The discovery info was accepted and is being cataloged asynchronously |
| `"rejected"` | The discovery info was rejected (e.g., failed schema validation). See `rejectedReason` for details |

**Example (success):**

```
EXTENSION-RESPONSES: eyJiYXphYXIiOnsic3RhdHVzIjoic3VjY2VzcyJ9fQ==
```
*(base64 of `{"bazaar":{"status":"success"}}`)*

**Example (rejected):**

```
EXTENSION-RESPONSES: eyJiYXphYXIiOnsic3RhdHVzIjoicmVqZWN0ZWQiLCJyZWplY3RlZFJlYXNvbiI6ImluZm8gZmFpbGVkIHNjaGVtYSB2YWxpZGF0aW9uIn19
```
*(base64 of `{"bazaar":{"status":"rejected","rejectedReason":"info failed schema validation"}}`)*

Clients that understand the `bazaar` extension SHOULD read the `bazaar` key of this header to confirm cataloging succeeded and surface any rejection reason for debugging.

---

## Client Behavior

Clients are expected to echo the `bazaar` extension from `PaymentRequired` into their `PaymentPayload`. If the extension is omitted, discovery cataloging will not occur.

---

## Dynamic Routes and `routeTemplate`

HTTP endpoints can use parameterized route patterns (e.g. `/users/[userId]`). When a route has
parameter segments, the server extension enriches the extension with two additional fields:

- **`info.input.pathParams`** — concrete parameter values for this specific request (e.g. `{ "userId": "123" }`)
- **`routeTemplate`** — the canonical template with `:param` syntax (e.g. `/users/:userId`)

The `routeTemplate` field at the **top level** of the extension object is the catalog key contract between
server and facilitator. Facilitators use it to map all concrete requests (e.g. `/users/123`, `/users/456`)
to a single canonical catalog entry.

### `routeTemplate` Wire Format

- The server writes patterns using `[paramName]` syntax internally (matches the route framework convention).
- The extension delivers `routeTemplate` externally using `:paramName` syntax, consistent with REST conventions.
- The field is **absent** for static routes; facilitators MUST treat an absent `routeTemplate` as "use the concrete URL path".

Example of an enriched extension for a dynamic route:

```json
{
  "info": {
    "input": {
      "type": "http",
      "method": "GET",
      "pathParams": { "userId": "123" }
    }
  },
  "schema": { ... },
  "routeTemplate": "/users/:userId"
}
```

### `routeTemplate` Validation Rules

The facilitator MUST validate `routeTemplate` before using it as a catalog key. The expected format
uses colon-prefixed parameter identifiers (e.g. `/users/:userId`, `/weather/:country/:city`).
All SDK implementations use the function `isValidRouteTemplate` (TypeScript, Go) or
`_is_valid_route_template` (Python) which applies the following rules identically.
**All three copies must stay in sync.**

| Rule | Reason |
|------|--------|
| Must be a non-empty string | Empty/absent means "no template" |
| Must start with `/` | Prevents relative paths and external URLs |
| Must match `^/[a-zA-Z0-9_/:.\-~%]+$` | Only allows safe URL path characters and `:param` identifiers |
| Must not contain `..` | Prevents path traversal (`/users/../admin`) |
| Must not contain `://` | Prevents URL injection (`http://evil.com`) |

All implementations decode percent-encoding (e.g. `%2e%2e` -> `..`) before applying the traversal
and scheme checks. A value that fails any rule is discarded; the facilitator falls back to the
concrete URL path for cataloging.

> **SDK implementers:** If you add a fourth SDK, copy these validation rules exactly, including
> the percent-decoding step before the `..` and `://` checks.

---

## Backwards Compatibility

The `bazaar` extension was formalized in x402 v2. Discovery functionality unofficially existed in x402 v1 through the `outputSchema` field.

Facilitators are **not expected** to support v1. If v1 support is desired:

| V1 Location | V2 Location |
|-------------|-------------|
| `accepts[0].outputSchema` | `extensions.bazaar` |
| `accepts[0].resource` | `resource.url` |
| `accepts[0].description` | `description` (top-level) |
| `accepts[0].mimeType` | `mimeType` (top-level) |

V1 had no formal schema validation.
