# Extension: `terms`

## Summary

The `terms` extension can be used by any network or scheme to communicate the terms of the payment commitment.

## Purpose

Describes the usage rights, obligations, and settlement terms of a payment commitment.

## Extension Definition

```json
{
  "terms": {
    "schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "format": {
          "type": "string",
          "enum": ["uri", "markdown", "plaintext", "json"],
          "description": "Format identifier describing how to interpret the terms field"
        },
        "terms": {
          "type": "string",
          "description": "Terms as a string (URL, markdown, plaintext, or JSON)"
        },
        "version": {
          "type": "string",
          "description": "Version identifier for change detection"
        }
      },
      "required": ["format", "terms"]
    },
    "info": {
      "format": "uri",
      "terms": "https://example.com/terms.md",
      "version": "2026-01-15"
    }
  }
}
```

## Fields

- **`format`** (required): Format identifier describing how to interpret the `terms` field
  - `"uri"`: Terms field contains a URL or data URI to the terms document
  - `"markdown"`: Terms field contains Markdown formatted text
  - `"plaintext"`: Terms field contains plain text
  - `"json"`: Terms field contains JSON-stringified structured data

- **`terms`** (required): Terms as a string
  - If `format` is `"uri"`: An HTTPS URL or data URI pointing to the terms document
  - If `format` is `"markdown"` or `"plaintext"`: The actual terms text
  - If `format` is `"json"`: JSON string containing structured terms data

- **`version`** (optional): Identifier for change detection. Allows clients to detect when terms have changed without fetching the full document. Can be a date, semantic version, hash, or any string that changes when terms are updated.

**Schema Omission**: The `schema` field is optional and may be omitted from responses to reduce header size. When omitted, clients should reference this specification for field definitions.

## Examples

```json
// URI format with version for change detection
{ "format": "uri", "terms": "https://example.com/terms.md", "version": "2026-01-15" }

// Markdown format
{ "format": "markdown", "terms": "# Terms of Use\n\nThis content is provided under the following terms..." }

// Plaintext format
{ "format": "plaintext", "terms": "Licensed for non-commercial use only. Attribution required." }
```

## Usage

This extension can be used across different payment schemes and networks to communicate:

- **Content licensing**: Rights for LLM training, inference, or redistribution
- **Subscription agreements**: Terms of service for ongoing access
- **Usage restrictions**: Limitations on how the resource can be used
- **Legal obligations**: Compliance requirements or liability terms

Networks may specify terms alongside authentication extensions (like `http-message-signatures`), in order to create a complete framework where the network knows both who is paying and what terms govern the usage of the accessed resource.

## Example Use Cases

- **batch-settlement scheme**: Communicating usage rights for content accessed through batched payment
- **exact scheme**: Specifying terms for blockchain-settled payments
- **Any scheme**: Describing legal terms for resource access
