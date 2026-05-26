# Specs Contributing Guide

Guide for proposing and documenting new x402 specifications.

## Contents

- [Overview](#overview)
- [Specification Types](#specification-types)
- [Proposing a New Spec](#proposing-a-new-spec)
- [Spec Review Process](#spec-review-process)
- [Templates](#templates)

## Overview

The `specs/` directory contains the formal specifications for the x402 protocol. These documents define the standards that implementations must follow.

```
specs/
├── x402-specification.md      # Core protocol specification
├── schemes/
│   └── exact/
│       ├── scheme_exact.md    # Scheme overview
│       ├── scheme_exact_evm.md
│       ├── scheme_exact_svm.md
│       └── scheme_exact_sui.md
├── transports/
│   ├── http.md
│   ├── mcp.md
│   └── a2a.md
├── scheme_template.md         # Template for new schemes
├── scheme_impl_template.md    # Template for chain implementations
└── transport_template.md      # Template for new transports
```

## Specification Types

### Schemes

Schemes define how funds are transferred from client to server. Each scheme has:

1. **Scheme overview** (`scheme_<name>.md`) - Describes the scheme's purpose and behavior
2. **Chain implementations** (`scheme_<name>_<chain>.md`) - Network-specific implementation details

Current schemes:
- `exact` - Transfers a specific amount for resource access

### Transports

Transports define how x402 messages are transmitted over different protocols:

- `http.md` - HTTP transport (status codes, headers)
- `mcp.md` - Model Context Protocol transport
- `a2a.md` - Agent-to-Agent transport

### Core Specification

`x402-specification.md` defines the protocol fundamentals:
- Core types (`PaymentRequirements`, `PaymentPayload`, `SettlementResponse`)
- Facilitator interface
- Security considerations

## Proposing a New Spec

### Step 1: Open a Discussion

Before writing a spec, open a GitHub issue or discussion to propose the idea. Include:

- Problem being solved
- High-level approach
- Why existing schemes/transports don't suffice

### Step 2: Write the Spec

Use the appropriate template:

| Spec Type | Template |
|-----------|----------|
| New scheme overview | `scheme_template.md` |
| Chain implementation | `scheme_impl_template.md` |
| New transport | `transport_template.md` |

### Step 3: Submit PR

1. Create the spec file in the appropriate directory
2. For schemes: `specs/schemes/<scheme_name>/scheme_<name>.md`
3. For transports: `specs/transports/<name>.md`
4. Reference the core spec for shared types

## Templates

### Scheme Template

Use `scheme_template.md` for new scheme overviews:

```markdown
# Scheme: `<name>`

## Summary

Summarize the purpose and behavior of your scheme here. Include example use cases.

## Use Cases

## Appendix
```

### Scheme Implementation Template

Use `scheme_impl_template.md` for chain-specific implementations:

```markdown
# Scheme: `<name>` `<network kind>`

## Summary

Summarize the purpose and behavior of your scheme here. Include example use cases.

## Payment header payload

Document how to construct the payment header payload for your scheme.

## Verification

Document the steps needed to verify a payment for your scheme is valid.

## Settlement

Document how to settle a payment for your scheme.

## Appendix
```

### Transport Template

Use `transport_template.md` for new transports:

```markdown
# Transport: `<name>`

## Summary

## Payment Required Signaling

## Payment Payload Transmission

## Settlement Response Delivery

## Error Handling

## References
```

## Writing Guidelines

### Be Precise

Specs are implementation guides. Use precise language:

- "MUST", "MUST NOT" for requirements
- "SHOULD", "SHOULD NOT" for recommendations
- "MAY" for optional behavior

### Include Examples

Every section should include concrete examples:

```json
{
  "scheme": "exact",
  "network": "eip155:8453",
  "amount": "10000"
}
```

### Reference Core Types

Don't redefine types from the core spec. Reference them:

> See `PaymentRequirements` in [x402-specification.md](x402-specification.md#5-types)

### Document Security Considerations

For schemes, include a section on:

- Replay attack prevention
- Authorization scope
- Settlement atomicity

## Getting Help

- Open an issue for spec questions
- Reference existing specs for patterns
- Discuss in the proposal issue before extensive writing

