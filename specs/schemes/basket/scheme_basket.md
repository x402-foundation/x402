# Scheme: `basket`

## Summary

The `basket` field is an optional protocol extension that provides a structured, machine-readable representation of itemized line items in a payment request. It enables clients to render detailed invoices, receipts, and shopping carts without custom parsing logic, aligning x402 with modern payment APIs.

Each item in the basket array includes:
- **id**: Optional unique identifier for the line item (for inventory tracking, refunds, correlation)
- **name**: Human-readable item description
- **price**: Amount in the smallest unit of the asset (e.g., wei, satoshis)
- **quantity**: Number of units (default: 1)
- **tax**: Optional tax amount per item
- **discount**: Optional discount amount per item
- **metadata**: Optional extensible object for additional item data

The basket field complements the existing `extra` field and is compatible with x402 v2.

## Use Cases

### E-commerce Checkout
A merchant selling multiple digital or physical products can provide a detailed breakdown:
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

### SaaS Subscriptions
Service providers can itemize subscription components, add-ons, and usage-based charges:
```json
{
  "basket": [
    {
      "name": "Pro Plan (Monthly)",
      "price": "50000000000000000000",
      "quantity": 1
    },
    {
      "name": "Additional User Seats",
      "price": "10000000000000000000",
      "quantity": 3
    },
    {
      "name": "Overage Charges",
      "price": "5000000000000000000",
      "quantity": 1,
      "metadata": {
        "billing_period": "2025-10",
        "usage_gb": 25.5
      }
    }
  ]
}
```

### Tax & Discount Transparency
Financial applications requiring tax and discount breakdowns per item:
```json
{
  "basket": [
    {
      "name": "Software License",
      "price": "100000000000000000000",
      "quantity": 1,
      "tax": "8000000000000000000",
      "metadata": {
        "tax_rate": "0.08",
        "jurisdiction": "CA"
      }
    }
  ]
}
```

### Grocery Shopping
On-chain grocery payments with itemized receipts showing quantities, prices, and applicable taxes:
```json
{
  "basket": [
    {
      "id": "item_bananas_001",
      "name": "Organic Bananas (lb)",
      "price": "1990000",
      "quantity": 3,
      "metadata": {
        "unit": "lb",
        "upc": "4011"
      }
    },
    {
      "id": "item_milk_002",
      "name": "Milk - Whole (1 gal)",
      "price": "4990000",
      "quantity": 2,
      "tax": "350000",
      "metadata": {
        "upc": "041303001264",
        "category": "dairy"
      }
    },
    {
      "id": "item_bread_003",
      "name": "Bread - Sourdough",
      "price": "5490000",
      "quantity": 1,
      "metadata": {
        "upc": "041130563652",
        "organic": true
      }
    },
    {
      "id": "item_coffee_004",
      "name": "Coffee Beans - Ethiopia (12oz)",
      "price": "14990000",
      "quantity": 1,
      "discount": "2000000",
      "metadata": {
        "upc": "853045006247",
        "member_discount": true
      }
    }
  ]
}
```

### Agent-to-Agent Payments
LLM agents purchasing tool access or resources can track itemized costs:
```json
{
  "basket": [
    {
      "name": "GPT-4 API Call",
      "price": "200000000000000",
      "quantity": 15,
      "metadata": {
        "tokens_used": 4500,
        "model": "gpt-4-turbo"
      }
    }
  ]
}
```

## Schema Definition

**Schema URI**: `https://x402.org/spec/v2/basket.schema.json`

### Validation Rules

1. **Type**: Array of objects
2. **Required fields per item**: `name`, `price`
3. **Optional fields per item**: `id`, `quantity`, `tax`, `discount`, `metadata`
4. **Price format**: String representation of amount in smallest unit
5. **Quantity**: Integer >= 1 (default: 1)
6. **Item ID**: Optional string for tracking and correlation (follows Stripe pattern)
7. **No additional properties**: Items cannot have fields beyond the defined schema

### Integration with PaymentRequirements

When constructing a `PaymentRequirements` response, include the `basket` field alongside the existing `extra` field:

```typescript
{
  "asset": "0x...",
  "amount": "25000000000000000",
  "extra": "2 items: Premium Article + API Credits",
  "basket": [
    {
      "name": "Premium Article Access",
      "price": "5000000000000000",
      "quantity": 1
    },
    {
      "name": "API Credits (100 calls)",
      "price": "10000000000000000",
      "quantity": 2
    }
  ]
}
```

### Implementation Notes
- Sum of `(price + tax - discount) * quantity` for all items should equal the total `amount`
- Servers should validate basket totals match the requested amount before returning payment requirements
