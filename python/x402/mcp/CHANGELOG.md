# Changelog

All notable changes to the `x402.mcp` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial implementation of MCP transport integration for x402 payment protocol
- `x402MCPClient` - Client wrapper with automatic payment handling
- `create_payment_wrapper` - Server-side payment wrapper for tool handlers
- Factory functions: `wrap_mcp_client_with_payment`, `wrap_mcp_client_with_payment_from_config`, `create_x402_mcp_client_from_config`
- Utility functions: `extract_payment_from_meta`, `attach_payment_to_meta`, `extract_payment_response_from_meta`, `attach_payment_response_to_meta`, `extract_payment_required_from_result`, `create_tool_resource_url`
- Error utilities: `create_payment_required_error`, `is_payment_required_error`, `extract_payment_required_from_error`
- Type guards: `is_object`
- Advanced types: `DynamicPayTo`, `DynamicPrice`, `MCPToolPaymentConfig`, `MCPPaymentProcessResult`, `MCPPaymentError`, `MCPToolResultWithPayment`, `MCPRequestParamsWithMeta`, `MCPResultWithMeta`, `MCPMetaWithPayment`, `MCPMetaWithPaymentResponse`, `ToolContentItem`
- Comprehensive hook system: `PaymentRequiredHook`, `BeforePaymentHook`, `AfterPaymentHook`, `BeforeExecutionHook`, `AfterExecutionHook`, `AfterSettlementHook`
- All 19 MCP passthrough methods for full protocol compatibility
- Unit tests for client, server, and utilities
- Convenience re-exports from `x402` core package (`PaymentPayload`, `PaymentRequired`, `PaymentRequirements`, `SettleResponse`, `Network`, `SchemeNetworkClient`, `SchemeNetworkServer`)
- README.md with examples and API documentation

### Features
- Automatic payment detection and retry on 402 errors
- Dual format payment extraction (structuredContent and content[0].text)
- Payment verification and settlement integration
- Hook system for custom payment handling, logging, and rate limiting
- Factory functions for easy client creation
- Complete MCP protocol passthrough (all 19 methods)
- Convenience re-exports for easier imports

## [0.1.0] - 2025-02-05

### Added
- Initial alpha release
