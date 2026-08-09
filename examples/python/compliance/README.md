# x402 Compliance Scanner

A reference implementation for validating x402 endpoint compliance against the protocol specification. This tool checks that an x402 gateway implements the 402 Payment Required response correctly — field shapes, types, required headers, and settlement flow.

Part of the [x402](https://github.com/x402-foundation/x402) open standard for internet-native payments.

**Addresses:** [Issue #2823 — Payment-integrity verifier for 402 responses](https://github.com/x402-foundation/x402/issues/2823)

## What it checks

| Check | What it validates |
|-------|------------------|
| HTTP 402 | Endpoint returns `402 Payment Required` |
| Required fields | `status`, `x402version`, `accepts`, `network`, `asset`, `amount`, `payment_address` |
| accepts[] schema | Each payment option has `type`, `scheme`, `network`, `amount`, `asset`, `payTo` |
| x402 version | Must be `2`, `"2"`, or `"x402-v2"` |
| Amount format | Positive integer string |
| CORS | `Access-Control-Allow-Origin` header present |
| Settlement flow | 402 → payment → 200 resource (requires valid auth) |

## Usage

```bash
# Scan a single endpoint
python3 scanner.py scan https://api.example.com/v1/resource

# Auto-discover and scan all x402-gated endpoints
python3 scanner.py scan-all https://api.example.com

# Validate a settlement receipt
python3 scanner.py validate <receipt-id>
```

Exit code `0` means all checks pass. `1` means one or more checks failed.

## Example output

```
==================================================
x402 Compliance Scanner v0.1.0
==================================================
Endpoint: https://api.gentechlabs.net/v1/wallet/analyze
Duration: 2.1s

  ✅ http_402: Responded 402 Payment Required
  ✅ field_status: 'status' present
  ✅ field_x402version: 'x402version' present
  ✅ x402version: x402version = x402-v2
  ✅ amount_format: amount = 25000
  ✅ payment_address: payment_address = 0x7EBff1Db...
  ✅ accepts_nonempty: 1 payment option(s)
  ✅ accepts[0].type: = x402
  ✅ accepts[0].scheme: = exact
  ...

  Summary: 20/20 checks passed
  Result: ✅ ALL CHECKS PASSED
==================================================
```

## Integration

Use as a standalone CLI or import `scan_endpoint()`:

```python
from scanner import scan_endpoint

results = scan_endpoint("https://api.example.com/v1/resource")
if results["passed"]:
    print("Endpoint is compliant!")
```

## Extending

New checks are `Check` objects with a `name`, `passed` bool, and `detail` string. The scanner is stack-agnostic and works with any x402-compatible server.
