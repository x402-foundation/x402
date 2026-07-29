# Builder Code extension (ERC-8021)

Import from `x402.extensions.builder_code`.

The Builder Code extension enables **onchain attribution tracking** for x402 payments. At settlement time, the facilitator appends an [ERC-8021](https://eip.tools/eip/8021) Schema 2 CBOR suffix to the transaction calldata that records which application exposed the paid endpoint (`a`), which client/intermediary participated (`s`), and which facilitator settled the payment (`w`).

This package implements ERC-8021 **Schema 2** (CBOR-encoded). See the [protocol spec](../../../../specs/extensions/builder_code.md) for the full wire format.

## How it works

1. **Servers** declare their app code (`a`) in the 402 `PaymentRequired.extensions`.
2. **Clients** echo the server's `a` and attach their own service code(s) (`s`) to `PaymentPayload.extensions`.
3. **Facilitators** add their wallet code (`w`) at settlement, CBOR-encode the combined fields, and append the ERC-8021 suffix to the settlement calldata.

All codes must match `^[a-z0-9_]{1,32}$` (1-32 characters, lowercase alphanumeric and underscores). Invalid codes raise at construction/declaration time.

## For resource servers

Declare the app code in your payment requirements. The helper returns an `{ "info", "schema" }` dict keyed by `BUILDER_CODE`.

```python
from x402.extensions.builder_code import declare_builder_code_extension, BUILDER_CODE

extensions = {BUILDER_CODE: declare_builder_code_extension("bc_my_service")}
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

The client never sets `w` — that is added by the facilitator. The core client merge preserves the server-declared `a` and schema after enrichment.

## For facilitators

Register the facilitator extension to encode the ERC-8021 suffix at settlement. Provide your own wallet code (`w`) to record which facilitator settled the payment; it is optional.

```python
from x402.extensions.builder_code import BuilderCodeFacilitatorExtension

facilitator.register_extension(BuilderCodeFacilitatorExtension(builder_code="bc_my_facilitator"))
```

At settlement the extension reads `a` and `s` from the client payment payload, adds its configured `w`, CBOR-encodes the present fields, and returns the hex suffix for the settlement mechanism to append to calldata. It returns `None` when no attribution is present.

Facilitators SHOULD truncate `s` to the first 5 valid entries at settlement to bound calldata size.

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

### `declare_builder_code_extension(app_code)`

Creates the `{ "info": { "a" }, "schema" }` declaration for `PaymentRequired.extensions`. Raises `ValueError` if `app_code` is not a valid builder code.

### `BuilderCodeClientExtension`

Client extension that attaches the client's service code(s) as `s`. Constructor accepts a single string or a list of strings; raises on any invalid code.

### `BuilderCodeFacilitatorExtension`

`FacilitatorExtension` that builds the ERC-8021 Schema 2 calldata suffix at settlement. Constructor takes an optional `builder_code` for the wallet code (`w`); raises when the provided code is invalid.

### `encode_builder_code_suffix(data)` / `parse_builder_code_suffix_from_calldata(calldata)`

Low-level CBOR helpers to encode a `BuilderCodeExtensionData` into an ERC-8021 suffix and to parse the suffix back out of settlement calldata.

### Constants and types

- `BUILDER_CODE` — extension identifier (`"builder-code"`)
- `BUILDER_CODE_PATTERN` — `^[a-z0-9_]{1,32}$`
- `MAX_SERVICE_CODES` — `5` (on-chain cap for `s`; facilitators truncate excess entries)
- `ERC_8021_MARKER`, `SCHEMA_2_ID`, `BUILDER_CODE_SCHEMA`
- Types: `BuilderCodeExtensionData`, `BuilderCodeFacilitatorConfig`

## Related resources

- [Builder Code protocol spec](../../../../specs/extensions/builder_code.md)
- [ERC-8021](https://eip.tools/eip/8021)
