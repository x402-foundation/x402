# Builder Code extension (ERC-8021)

Part of [`@x402/extensions`](../README.md). Import from `@x402/extensions/builder-code`.

The Builder Code extension enables **on-chain attribution tracking** for x402 payments. At settlement time, the facilitator appends an [ERC-8021](https://eip.tools/eip/8021) Schema 2 CBOR suffix to the transaction calldata that records which application exposed the paid endpoint (`a`), which client/intermediary participated (`s`), and which facilitator settled the payment (`w`).

This package implements ERC-8021 **Schema 2** (CBOR-encoded). See the [protocol spec](../../../../../specs/extensions/builder_code.md) for the full wire format.

## How it works

1. **Servers** declare their app code (`a`) in the 402 `PaymentRequired.extensions`.
2. **Clients** echo the server's `a` and attach their own service code(s) (`s`) to `PaymentPayload.extensions`.
3. **Facilitators** add their wallet code (`w`) at settlement, CBOR-encode the combined fields, and append the ERC-8021 suffix to the settlement calldata.

All codes must match `^[a-z0-9_]{1,32}$` (1-32 characters, lowercase alphanumeric and underscores). Invalid codes throw at construction/declaration time.

## For resource servers

Declare the app code in your payment requirements. The helper returns an `{ info, schema }` object keyed by `BUILDER_CODE`.

```typescript
import { declareBuilderCodeExtension, BUILDER_CODE } from "@x402/extensions/builder-code";

const paymentRequired = {
  x402Version: 2,
  resource: { ... },
  accepts: [...],
  extensions: {
    [BUILDER_CODE]: declareBuilderCodeExtension("bc_my_service"),
  },
};
```

## For clients

Register the client extension so your service code(s) (`s`) are attached to every payment. Pass a single code or an array of codes so layered clients (e.g. an MCP middleware) can attribute multiple participants.

```typescript
import { BuilderCodeClientExtension } from "@x402/extensions/builder-code";

const client = new x402Client();

// Single service code
client.registerExtension(new BuilderCodeClientExtension("bc_my_client"));

// Multiple codes (layered attribution)
client.registerExtension(new BuilderCodeClientExtension(["bc_mcp", "bc_demo_app"]));
```

The client never sets `w` — that is added by the facilitator. The core client merge preserves the server-declared `a` and schema after enrichment.

## For facilitators

Register the facilitator extension to encode the ERC-8021 suffix at settlement. Provide your own wallet code (`w`) to record which facilitator settled the payment; it is optional.

```typescript
import { BuilderCodeFacilitatorExtension } from "@x402/extensions/builder-code";

const facilitator = new x402Facilitator();
facilitator.registerExtension(
  new BuilderCodeFacilitatorExtension({
    builderCode: "bc_my_facilitator", // optional
  }),
);
```

At settlement the extension reads `a` and `s` from the client payment payload, adds its configured `w`, CBOR-encodes the present fields, and returns the hex suffix for the settlement mechanism to append to calldata. It returns `undefined` when no attribution is present.

Facilitators SHOULD truncate `s` to the first 5 valid entries at settlement to bound calldata size.

## Parsing attribution from calldata

Off-chain parsers can recover the attribution fields from settlement calldata:

```typescript
import { parseBuilderCodeSuffixFromCalldata } from "@x402/extensions/builder-code";

const data = parseBuilderCodeSuffixFromCalldata(calldata);
if (data) {
  // { a?: "bc_my_service", w?: "bc_my_facilitator", s?: ["bc_my_client"] }
}
```

## API reference

### `declareBuilderCodeExtension(appCode)`

Creates the `{ info: { a }, schema }` declaration for `PaymentRequired.extensions`. Throws if `appCode` is not a valid builder code.

### `BuilderCodeClientExtension`

`ClientExtension` that attaches the client's service code(s) as `s`. Constructor accepts a single string or a string array; throws on any invalid code.

### `BuilderCodeFacilitatorExtension`

`FacilitatorExtension` that builds the ERC-8021 Schema 2 calldata suffix at settlement. Constructor takes an optional `{ builderCode }` config for the wallet code (`w`); throws when the provided code is invalid.

### `encodeBuilderCodeSuffix(data)` / `parseBuilderCodeSuffixFromCalldata(calldata)`

Low-level CBOR helpers to encode a `BuilderCodeExtensionData` object into an ERC-8021 suffix and to parse the suffix back out of settlement calldata.

### Constants and types

- `BUILDER_CODE` — extension identifier (`"builder-code"`)
- `BUILDER_CODE_PATTERN` — `/^[a-z0-9_]{1,32}$/`
- `MAX_SERVICE_CODES` — `5` (on-chain cap for `s`; facilitators truncate excess entries)
- `ERC_8021_MARKER`, `SCHEMA_2_ID`, `BUILDER_CODE_SCHEMA`
- Types: `BuilderCodeExtensionData`, `BuilderCodeFacilitatorConfig`, `BuilderCodeRequiredExtension`, `DataSuffixContext`

See [`index.ts`](./index.ts) for the full list of exports.

## Related resources

- [Builder Code protocol spec](../../../../../specs/extensions/builder_code.md)
- [ERC-8021](https://eip.tools/eip/8021)
- [`@x402/extensions` overview](../README.md)
