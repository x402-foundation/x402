# Builder Code extension (ERC-8021)

Import from `x402.extensions.builder_code`.

The Builder Code extension enables **onchain attribution tracking** for x402 payments. At settlement time, the facilitator appends an [ERC-8021](https://eip.tools/eip/8021) Schema 2 CBOR suffix to the transaction calldata that records which application exposed the paid endpoint (`a`), which client/intermediary participated (`s`), and which facilitator settled the payment (`w`).

This package implements ERC-8021 **Schema 2** (CBOR-encoded). See the [protocol spec](../../../../specs/extensions/builder_code.md) for the full wire format.

## How it works

1. **Servers** declare their app code (`a`), and optionally up to `MAX_SERVER_SERVICE_CODES` of their own service code(s) (`s`), in the 402 `PaymentRequired.extensions`.
2. **Clients** attach up to `MAX_CLIENT_SERVICE_CODES` of their own service code(s) (`s`) to `PaymentPayload.extensions` whenever `BuilderCodeClientExtension` is registered. When the server declared `builder-code`, the core client merge preserves the server's `a` and concatenates any server-declared `s` with the client's (client first, deduped) — a bare string on either side is treated as a single-element list. Each side's reservation is independent, so neither can crowd out the other.
3. **Facilitators** add their wallet code (`w`) and, optionally, their own service code (up to `MAX_FACILITATOR_SERVICE_CODES`) at settlement, CBOR-encode the combined fields, and append the ERC-8021 suffix to the settlement calldata.

All codes must match `^[a-z0-9_]{1,32}$` (1-32 characters, lowercase alphanumeric and underscores). Invalid codes raise at construction/declaration time.

## For resource servers

Declare the app code in your payment requirements. The helper returns an `{ "info", "schema" }` dict keyed by `BUILDER_CODE`.

```python
from x402.extensions.builder_code import declare_builder_code_extension, BUILDER_CODE

extensions = {BUILDER_CODE: declare_builder_code_extension("bc_my_service")}
```

Pass an optional second argument to also declare the application's own service code(s) (e.g. attribution for a server-side SDK the service depends on):

```python
declare_builder_code_extension("bc_my_service", "bc_server_sdk")
```

## For clients

Register the client extension so your service code(s) (`s`) are attached to every payment. Pass a single code or a list of codes so layered clients (e.g. an MCP middleware) can attribute multiple participants.

```python
from x402.extensions.builder_code import BuilderCodeClientExtension

# Single service code
client.register_extension(BuilderCodeClientExtension("bc_my_client"))

# Multiple codes (layered attribution)
client.register_extension(BuilderCodeClientExtension(["bc_mcp", "bc_demo_app"]))
```

The client never sets `w` — that is added by the facilitator. When the server declared `builder-code` in the 402 response, the core client merge preserves the server-declared `a` and schema after enrichment, and merges any server-declared `s` with the client's. When the server did not declare `builder-code`, only `s` is attached.

## For facilitators

Register the facilitator extension to encode the ERC-8021 suffix at settlement. Provide your own wallet code (`w`) to record which facilitator settled the payment, and optionally your own service code (`s`); both are optional.

```python
from x402.extensions.builder_code import BuilderCodeFacilitatorExtension

facilitator.register_extension(
    BuilderCodeFacilitatorExtension(
        builder_code="bc_my_facilitator",  # optional
        service_code="bc_my_facilitator_sdk",  # optional
    )
)
```

At settlement the extension reads `a` and `s` from the client payment payload, adds its configured `w`, appends its own `service_code` to `s` (deduped), CBOR-encodes the present fields, and returns the hex suffix for the settlement mechanism to append to calldata. It returns `None` when no attribution is present.

Each side reserves its own slice of `s` (`MAX_CLIENT_SERVICE_CODES`, `MAX_SERVER_SERVICE_CODES`, `MAX_FACILITATOR_SERVICE_CODES`) so none can crowd out another; facilitators additionally truncate the echoed client+server codes to that combined budget as a defensive backstop against a malformed payload.

## Parsing attribution from calldata

Off-chain parsers can recover the attribution fields from settlement calldata:

```python
from x402.extensions.builder_code import parse_builder_code_suffix_from_calldata

data = parse_builder_code_suffix_from_calldata(calldata)
if data:
    # BuilderCodeExtensionData(a="bc_my_service", w="bc_my_facilitator", s=["bc_my_client"])
    ...
```

## API reference

### `declare_builder_code_extension(app_code, service_codes=None)`

Creates the `{ "info": { "a", "s"? }, "schema" }` declaration for `PaymentRequired.extensions`. Raises `ValueError` if `app_code` or any `service_codes` entry is not a valid builder code, or if more than `MAX_SERVER_SERVICE_CODES` service codes are given.

### `BuilderCodeClientExtension`

Client extension that attaches the client's service code(s) as `s`. Constructor accepts a single string or a list of strings; raises on any invalid code or on more than `MAX_CLIENT_SERVICE_CODES` codes.

### `BuilderCodeFacilitatorExtension`

`FacilitatorExtension` that builds the ERC-8021 Schema 2 calldata suffix at settlement. Constructor takes optional `builder_code` (wallet code `w`) and `service_code` (the facilitator's own service code) kwargs; raises when either provided code is invalid.

### `encode_builder_code_suffix(data)` / `parse_builder_code_suffix_from_calldata(calldata)`

Low-level CBOR helpers to encode a `BuilderCodeExtensionData` into an ERC-8021 suffix and to parse the suffix back out of settlement calldata.

### Constants and types

- `BUILDER_CODE` — extension identifier (`"builder-code"`)
- `BUILDER_CODE_PATTERN` — `^[a-z0-9_]{1,32}$`
- `MAX_CLIENT_SERVICE_CODES` — `5` (client's dedicated `s` reservation)
- `MAX_SERVER_SERVICE_CODES` — `5` (server's dedicated `s` reservation)
- `MAX_FACILITATOR_SERVICE_CODES` — `1` (facilitator's dedicated `s` reservation)
- `MAX_SERVICE_CODES` — `11` (on-chain cap for `s`; the sum of each side's reservation)
- `ERC_8021_MARKER`, `SCHEMA_2_ID`, `BUILDER_CODE_SCHEMA`
- Types: `BuilderCodeExtensionData`, `BuilderCodeFacilitatorConfig`

## Related resources

- [Builder Code protocol spec](../../../../specs/extensions/builder_code.md)
- [ERC-8021](https://eip.tools/eip/8021)
