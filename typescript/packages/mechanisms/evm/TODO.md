# @x402/evm

## Overview

The `@x402/evm` package provides EVM blockchain implementations for x402 payment schemes. It serves as the **reference implementation** for how mechanism packages should be structured, providing scheme clients, facilitators, and resource servers for EVM-compatible chains.

## Current Implementation Status

### Completed ✅
- **EIP-3009 Support**: Full implementation for gasless token transfers
  - Supports both v1 and v2 protocol versions
- **Exact Scheme**: Complete implementation for exact-value payments
- **Multi-chain Support**: Works with any EVM-compatible chain via network identifiers (e.g., `eip155:*`)

### Architecture
The package exports three core classes following the x402 pattern:
- `ExactEvmClient`: Client-side payment creation and signing
- `ExactEvmFacilitator`: Facilitator for payment settlement
- `ExactEvmResourceServer`: Server-side payment verification

## Planned Expansions

### 1. Permit2 Integration
**Goal**: Implement Uniswap's Permit2 for more efficient token approvals and transfers

**Benefits**:
- Single approval for multiple transfers
- Improved gas efficiency
- Better security through expiring approvals
- Reduced transaction count for users

**Implementation Notes**:
- Maintain backward compatibility with EIP-3009
- Allow configuration to choose between EIP-3009 and Permit2
- Consider auto-detection based on token contract capabilities

### 2. Up-To Scheme Implementation
**Goal**: Support payments "up to" a maximum value, enabling flexible pricing models

**Use Cases**:
- Metered API usage
- Variable-cost operations
- Pay-per-use services with caps

**Requirements**:
- Define schema for up-to payment requirements
- Implement partial payment settlement
- Support refunds for unused amounts
- Handle edge cases around maximum values

## Contributing Guidelines

Before implementing these expansions:

1. **Open a GitHub Issue** to discuss the approach
   - Outline the implementation plan
   - Consider backward compatibility
   - Discuss any protocol changes needed

2. **Follow the Reference Pattern**
   - Review how the exact scheme is implemented
   - Maintain consistency with the three-class export pattern
   - Ensure compatibility with `@x402/core` abstractions

3. **Testing Requirements**
   - Unit tests for all new functionality
   - Integration tests with `@x402/core`
   - E2E test implementation in `/e2e`

## Technical Notes

- This package serves as the reference for other mechanism implementations (Solana, etc.)
- All exports should extend the base classes from `@x402/core/types`
- Maintain support for both x402 v1 and v2 protocols where applicable