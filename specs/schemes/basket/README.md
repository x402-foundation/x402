# Basket Protocol Extension

This directory contains the specification and schema for the `basket` protocol extension in x402 v2.

## Files

- **[scheme_basket.md](scheme_basket.md)**: Full specification with use cases and integration guide
- **[basket.schema.json](basket.schema.json)**: JSON Schema (draft-07) definition

## Overview

The `basket` field enables structured, itemized line items in payment requests, allowing clients to render detailed invoices without custom parsing logic.

### Example

```json
{
  "basket": [
    {
      "name": "Premium Article Access",
      "price": "5000000000000000",
      "quantity": 1
    },
    {
      "name": "API Credits (100 calls)",
      "price": "10000000000000000",
      "quantity": 2,
      "discount": "1000000000000000"
    }
  ]
}
```

## Schema Fields

Each basket item supports:
- `id` (optional): Unique identifier for the line item (string)
- `name` (required): Human-readable item description
- `price` (required): Amount in smallest asset unit (string)
- `quantity` (optional): Number of units, default 1
- `tax` (optional): Tax amount per item (string)
- `discount` (optional): Discount amount per item (string)
- `metadata` (optional): Extensible object for additional data

## Validation

Use the JSON schema to validate basket data:

```bash
# Example with ajv-cli
ajv validate -s basket.schema.json -d example-basket.json
```
