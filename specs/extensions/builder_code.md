# Extension: `builder-code`

## Summary

The `builder-code` extension enables **on-chain attribution tracking** for x402 payments by appending [ERC-8021](https://eip.tools/eip/8021) Schema 2 builder codes to settlement transaction calldata. It attributes which application exposed the paid endpoint and which facilitator settled the payment.

This extension implements **Schema 2** (CBOR-encoded) of ERC-8021. The `m` (custom metadata) and `r` (custom registries) fields are not supported.

---

## ERC-8021 Schema 2 Overview

ERC-8021 defines a structured data suffix appended to transaction calldata for entity attribution. Schema 2 uses CBOR encoding for extensibility.

### Suffix Format

The complete suffix appended to calldata is (ordered end of calldata backwards):

| Component    | Size     | Description                                             |
| ------------ | -------- | ------------------------------------------------------- |
| `ercMarker`  | 16 bytes | Constant identifier: `80218021802180218021802180218021` |
| `schemaId`   | 1 byte   | `0x02` for Schema 2                                     |
| `cborLength` | 2 bytes  | Length of CBOR data (big-endian)                        |
| `cborData`   | variable | CBOR-encoded map of attribution fields                  |

Wire order: `[cborData][cborLength (2B)][schemaId (1B)][ercMarker (16B)]`

### CBOR Map Fields

| Key | Type            | Description                                                     |
| --- | --------------- | --------------------------------------------------------------- |
| `a` | string          | App code — the application that exposed the paid endpoint       |
| `w` | string          | Wallet code — the facilitator that settled the payment on-chain |
| `s` | string or array of strings | Service code(s) — client-provided attribution |

All fields are optional.

### Builder Code Format

Codes must match the pattern `^[a-z0-9_]{1,32}$`:

- **Length**: 1-32 characters
- **Characters**: lowercase alphanumeric and underscores only

---

## `PaymentRequired`

The application declares its builder code per-route in the payment middleware configuration.

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "accepts": [ ... ],
  "extensions": {
    "builder-code": {
      "info": {
        "a": "my_app"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "a": {
            "type": "string",
            "pattern": "^[a-z0-9_]{1,32}$",
            "description": "App builder code"
          },
          "w": {
            "type": "string",
            "pattern": "^[a-z0-9_]{1,32}$",
            "description": "Wallet builder code"
          },
          "s": {
            "type": "array",
            "items": {
              "type": "string",
              "pattern": "^[a-z0-9_]{1,32}$"
            },
            "description": "Service builder codes"
          }
        },
        "additionalProperties": false
      }
    }
  }
}
```

---

## `PaymentPayload`

The client attaches its own service code(s) (`s`) when the `BuilderCodeClientExtension` is registered. When the server declared `builder-code` in `PaymentRequired`, the client also echoes the server's app code (`a`).

```json
{
  "extensions": {
    "builder-code": {
      "a": "my_app",
      "s": "my_client"
    }
  }
}
```

When the server did not declare `builder-code`, the client still attaches `s` but MUST NOT set `a`:

```json
{
  "extensions": {
    "builder-code": {
      "s": "my_client"
    }
  }
}
```

Layered clients (e.g. an MCP server acting as middleware) can attribute multiple participants by listing several codes as an array:

```json
{
  "extensions": {
    "builder-code": {
      "a": "my_app",
      "s": ["base_mcp", "demo_app"]
    }
  }
}
```

The `w` (wallet) field is **not** set by the client. It is added by the facilitator at settlement time.

---

## Builder Code Fields

| Field | Set by                              | When                                       | Description                                              |
| ----- | ------------------------------------ | ------------------------------------------- | -------------------------------------------------------- |
| `a`   | Application                          | Per-route middleware configuration          | Identifies the application exposing the paid endpoint    |
| `w`   | Facilitator                          | Settlement                                  | Identifies the facilitator settling the payment on-chain |
| `s`   | Client, server, and/or facilitator   | Payment payload construction / settlement   | Identifies participants in the payment path              |

| Field | Server advertises `builder-code`? | Client behavior |
| ----- | --------------------------------- | --------------- |
| `a`   | Yes                               | Echo server value (via core merge) |
| `a`   | No                                | MUST NOT set |
| `s`   | Either                            | SHOULD attach when `BuilderCodeClientExtension` is registered; when the server also declares `s`, core merge concatenates client then server codes (deduped) |

`s` accepts a bare string or an array of strings on either side; a scalar on one side merges as a single-element array against an array on the other.

Each party that can contribute to `s` has its own dedicated, non-overlapping reservation so it cannot be crowded out by another party:

| Party       | Constant                       | Max entries |
| ----------- | ------------------------------- | ----------- |
| Client      | `MAX_CLIENT_SERVICE_CODES`      | 5           |
| Server      | `MAX_SERVER_SERVICE_CODES`      | 5           |
| Facilitator | `MAX_FACILITATOR_SERVICE_CODES` | 1           |
| **Total**   | `MAX_SERVICE_CODES`             | **11**      |

Declaring more than a party's own reservation at that layer MUST be rejected (see [Builder Code Validation](#builder-code-validation)).

---

## Facilitator Behavior

When a facilitator settles a payment containing the `builder-code` extension, it:

1. When the resource server declared `builder-code.info.a`, verifies that `PaymentPayload.extensions["builder-code"].a` matches `PaymentRequired.extensions["builder-code"].info.a`
2. Reads `a` (app code) and `s` (service codes) from the payment payload extensions
3. Adds its own builder code as the `w` (wallet) field
4. Optionally appends its own service code to `s` (deduped against the echoed entries), up to its `MAX_FACILITATOR_SERVICE_CODES` reservation
5. Encodes the combined data as an ERC-8021 Schema 2 CBOR suffix
6. Appends the suffix to the settlement transaction calldata

The facilitator's builder code and service code are configured at initialization and validated against the same `^[a-z0-9_]{1,32}$` pattern.

### Calldata Suffix Construction

The facilitator builds the suffix as follows:

1. CBOR-encode a map containing all present fields (`a`, `s`, `w`)
2. Compute `cborLength` as the byte length of the CBOR data (2 bytes, big-endian)
3. Append: `[cborData][cborLength][0x02][80218021802180218021802180218021]`
4. Return the hex-encoded result for the settlement mechanism to append to calldata

---

## Protocol Flow

```
Client (App)                   Resource Server                Facilitator
      |                              |                              |
  1.  |--- request ----------------->|                              |
      |                              |                              |
  2.  |<-- 402 PaymentRequired ------|                              |
      |   extensions.builder-code:   |                              |
      |     { a: "my_app" }         |                              |
      |                              |                              |
  3.  | (sign payment, echo extensions)                             |
      |                              |                              |
  4.  |--- request + payment ------->|                              |
      |   extensions.builder-code:   |                              |
      |     { a: "my_app",          |                              |
      |       s: "my_client" }      |                              |
      |                              |                              |
  5.  |                              |--- verify/settle ----------->|
      |                              |   extensions.builder-code:   |
      |                              |     { a: "my_app",          |
      |                              |       s: "my_client" }      |
      |                              |                              |
  6.  |                              |         Facilitator adds w,  |
      |                              |         encodes CBOR suffix, |
      |                              |         appends to calldata: |
      |                              |         [cbor({a:"my_app",   |
      |                              |          s:["my_client"],    |
      |                              |          w:"my_fac"})]       |
      |                              |         [cborLen][0x02][mark] |
      |                              |                              |
  7.  |<-- 200 OK + resource data ---|                              |
      |                              |                              |
```

---

## Examples

### Single App Attribution

Application declares its builder code:

```json
{
  "extensions": {
    "builder-code": {
      "info": {
        "a": "bc_myapp"
      },
      "schema": { ... }
    }
  }
}
```

Settlement calldata suffix (hex):

```
{original_calldata} a161616862635f6d79617070 000c 02 80218021802180218021802180218021
```

Decoded:

- CBOR: `{"a": "bc_myapp"}`
- cborLength: `0x000c` (12 bytes)
- schemaId: `0x02`
- marker: `80218021802180218021802180218021`

### App + Facilitator Attribution

After facilitator adds its `w` code at settlement:

```
{original_calldata} a261616862635f6d7961707061777062635f6d79666163696c697461746f72 001f 02 80218021802180218021802180218021
```

Decoded:

- CBOR: `{"a": "bc_myapp", "w": "bc_myfacilitator"}`
- cborLength: `0x001f` (31 bytes)
- schemaId: `0x02`
- marker: `80218021802180218021802180218021`

---

## Validation

### Builder Code Validation

All builder codes (`a`, `w`, and each entry in `s`) must:

- Match `^[a-z0-9_]{1,32}$`
- Be 1-32 characters long
- Contain only lowercase letters, digits, and underscores

Invalid codes must be rejected at declaration time (application), at construction time (client), and at construction or first-use (settlement) time (facilitator). The facilitator validates each entry in `s` for format only — `s` is client self-reported and cannot be verified against any authoritative source. Declaring or attaching more service codes than a party's own reservation (`MAX_CLIENT_SERVICE_CODES`, `MAX_SERVER_SERVICE_CODES`, or `MAX_FACILITATOR_SERVICE_CODES`) must be rejected at that layer.

The resource server MUST also reject the payment (`extension_echo_mismatch`) before verification/settlement when the client-echoed `s` array exceeds the combined client+server budget (`MAX_CLIENT_SERVICE_CODES + MAX_SERVER_SERVICE_CODES`), even if it still contains every server-declared entry as a subset — this prevents a hand-crafted payload from padding `s` with extra entries that could later crowd out a legitimately declared entry once truncated further downstream. As a further defensive backstop for facilitators invoked without that resource-server validation (e.g. a hand-crafted payload sent directly to a facilitator), the facilitator additionally truncates the echoed client+server `s` entries to that same combined budget before appending its own service code, capping the final encoded `s` at `MAX_SERVICE_CODES` entries.

### App Code Echo Validation

When the resource server declared `builder-code` in `PaymentRequired`, the facilitator MUST verify that the `a` field echoed by the client in `PaymentPayload.extensions["builder-code"]` exactly matches the `a` field declared by the application in `PaymentRequired.extensions["builder-code"].info`. A mismatch indicates the client tampered with the attribution and the payment MUST be rejected.


### Schema Validation

The `schema` field uses JSON Schema Draft 2020-12. Facilitators should validate `info` against the provided schema.

---

## Parsing

Off-chain parsers can extract builder code attribution from settlement calldata using the ERC-8021 parsing algorithm:

1. Extract the last 16 bytes and verify they match the ERC-8021 marker (`80218021...`)
2. Extract the preceding byte as `schemaId` and verify it equals `0x02`
3. Extract the preceding 2 bytes as `cborLength` (big-endian)
4. Extract the preceding `cborLength` bytes as `cborData`
5. Decode `cborData` as a CBOR map
6. Read `a` (app code), `w` (wallet code), and `s` (service codes array) from the map

---

## Responsibilities

| Role            | Responsibility                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Application** | Declares `a` (app code) per-route in the payment middleware configuration, and optionally up to `MAX_SERVER_SERVICE_CODES` of its own service code(s) as `s` (e.g. attribution for a server-side SDK) |
| **Client**      | Attaches up to `MAX_CLIENT_SERVICE_CODES` service code(s) as `s` when `BuilderCodeClientExtension` is registered; echoes `a` only when the server declared `builder-code` |
| **Facilitator** | Adds `w` (wallet code) at settlement, optionally appends up to `MAX_FACILITATOR_SERVICE_CODES` of its own service code(s) to `s`, encodes the full CBOR suffix (`a`, `s`, `w`), appends to calldata |
