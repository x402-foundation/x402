# x402.mcp

MCP (Model Context Protocol) integration for the x402 payment protocol. This package enables paid tool calls in MCP servers and automatic payment handling in MCP clients.

## Installation

```bash
pip install x402
```

## Quick Start

### Server - Using Payment Wrapper

```python
from x402 import x402ResourceServerSync
from x402.mcp import create_payment_wrapper, PaymentWrapperConfig

# Create x402 resource server
facilitator_client = # ... create facilitator client
resource_server = x402ResourceServerSync(facilitator_client)
resource_server.register("eip155:84532", evm_server_scheme)

# Build payment requirements
accepts = resource_server.build_payment_requirements_from_config({
    "scheme": "exact",
    "network": "eip155:84532",
    "pay_to": "0x...",  # Your wallet address
    "price": "$0.10",
})

# Create payment wrapper
paid = create_payment_wrapper(
    resource_server,
    PaymentWrapperConfig(accepts=accepts),
)

# Register paid tool - wrap handler
@mcp_server.tool("financial_analysis", "Financial analysis", schema)
@paid
def handler(args, context):
    # Your tool logic here
    return {"content": [{"type": "text", "text": "Analysis result"}]}
```

### Client - Using Factory Function

```python
from x402.mcp import create_x402_mcp_client_from_config
from x402.mechanisms.evm.exact import ExactEvmClientScheme

# Create MCP client (from MCP SDK)
mcp_client = # ... create MCP client

# Create x402 MCP client with config
x402_mcp = create_x402_mcp_client_from_config(
    mcp_client,
    {
        "schemes": [
            {"network": "eip155:84532", "client": ExactEvmClientScheme(signer)},
        ],
        "auto_payment": True,
        "on_payment_requested": lambda ctx: True,  # Auto-approve
    },
)

# Connect to server
# x402_mcp.connect(transport)

# Call tools - payment handled automatically
result = x402_mcp.call_tool("get_weather", {"city": "NYC"})
```

## API Reference

### Client

#### `create_x402_mcp_client_from_config`

Creates a fully configured x402 MCP client from a config dictionary.

```python
x402_mcp = create_x402_mcp_client_from_config(
    mcp_client,
    {
        "schemes": [
            {"network": "eip155:84532", "client": evm_client_scheme},
        ],
        "auto_payment": True,
    },
)
```

Corrective payment retries require explicit recovery from the core payment
response hook and are limited to one retry. Like the Python HTTP client, MCP
reruns approval and signs the original approved terms; corrective terms are
provided to the core hook for state reconciliation, not substituted into the
next payment. Exact and upto payments are never retried solely because another
402 arrived.

A tool result's `payment_made` records that a payload was submitted, including
pending or failed settlement. It does not prove settlement. When a corrective
retry is denied, `x402MCPClientSync` returns the earlier result with
`payment_made=True`; the async `x402MCPClient` raises `PaymentRequiredError`.
`payment_response` and the async client's
`AfterPaymentContext.settle_response` contain only successful receipts after
core response processing. Failed receipt details remain in `raw_result` and
reach core response hooks for recovery.

`call_tool` and `call_tool_with_payment` raise `PaymentResponseError` when core
receipt processing fails. Its `result` retains the paid tool output and its
`__cause__` retains the processing error. After-payment observers still run, but
cannot mask that error. An observer's own exception keeps its original type
(for example, `KeyError`) and exposes the paid result as `mcp_result`. Resolve
an uncertain payment outcome before submitting another payment.

#### `wrap_mcp_client_with_payment`

Wraps an existing MCP client with x402 payment handling.

```python
from x402 import x402ClientSync

payment_client = x402ClientSync()
payment_client.register("eip155:84532", evm_client_scheme)

x402_mcp = wrap_mcp_client_with_payment(
    mcp_client,
    payment_client,
    auto_payment=True,
)
```

Derived read timeouts use accept `maxTimeoutSeconds` (default 300s), capped by `max_request_timeout_seconds` (default 600). Per-call `read_timeout_seconds` overrides both.

#### `wrap_mcp_client_with_payment_from_config`

Wraps an MCP client using scheme registrations directly.

```python
x402_mcp = wrap_mcp_client_with_payment_from_config(
    mcp_client,
    schemes=[
        {"network": "eip155:84532", "client": evm_client_scheme},
    ],
    auto_payment=True,
)
```

### Server

#### `create_payment_wrapper`

Creates a payment wrapper for MCP tool handlers.

```python
from x402.mcp import PaymentWrapperHooks

paid = create_payment_wrapper(
    resource_server,
    PaymentWrapperConfig(
        accepts=accepts,
        hooks=PaymentWrapperHooks(
            on_before_execution=lambda ctx: True,  # Return False to abort
            on_after_execution=lambda ctx: None,
            on_after_settlement=lambda ctx: None,
        ),
    ),
)
```

`on_before_execution` and `on_after_execution` may set the request's settlement
amount within its verified ceiling. Amounts accept ASCII decimal strings or
nonnegative integers; integers become decimal strings. Booleans, floats,
negative amounts, and amounts above the ceiling are rejected. Only the amount
is applied: other verified terms and advertised accepts remain unchanged.
Invalid amounts use the same cancellation and error handling in either hook.
Cancellation hooks receive the original verified terms, even when the
settlement amount was reduced by a metering hook.

Execution-hook aborts, metering failures, and explicit pre-submission settlement
aborts dispatch cancellation with `after_verify_aborted`. Handler exceptions
use `handler_threw`; error results use `handler_failed`. Pending settlements and
uncertain settlement exceptions do not trigger cancellation. Invalid metering
never falls back to charging the ceiling. Generic wrappers preserve completed
upfront receipts when cancellation fails; failed cancellation receipts remain
in the error body with deposit recovery details, never in success metadata.

Failed `settle_on_cancel` receipts are returned in `structuredContent` and a
text fallback. Python clients read both for recovery. The current TypeScript
MCP client reads receipts only from `_meta`, so it does not automatically
process these failed cancellation receipts from third-party schemes.

### Utilities

#### Error Handling

```python
from x402.mcp import (
    create_payment_required_error,
    is_payment_required_error,
    extract_payment_required_from_error,
)

# Create payment required error
error = create_payment_required_error(payment_required, "Payment required")
raise error

# Check if error is payment required
if is_payment_required_error(error):
    # Handle payment required
    pass

# Extract PaymentRequired from JSON-RPC error
pr = extract_payment_required_from_error(json_rpc_error)
```

#### Type Guards

```python
from x402.mcp import is_object

# Check if value is an object
if is_object(value):
    # Use value as dict
    pass
```

## Constants

- `MCP_PAYMENT_REQUIRED_CODE` - JSON-RPC error code for payment required (402)
- `MCP_PAYMENT_META_KEY` - MCP _meta key for payment payload ("x402/payment")
- `MCP_PAYMENT_RESPONSE_META_KEY` - MCP _meta key for payment response ("x402/payment-response")

## Types

### Client Types

- `x402MCPClient` - x402-enabled MCP client
- `MCPToolCallResult` - Result of a tool call with payment metadata
- `PaymentRequiredContext` - Context provided to payment required hooks
- `PaymentRequiredHookResult` - Result from payment required hook
- `PaymentRequiredError` - Error indicating payment is required
- `PaymentResponseError` - Receipt-processing error carrying the returned tool result

### Server Types

- `PaymentWrapperConfig` - Configuration for payment wrapper
- `ServerHookContext` - Context provided to server-side hooks
- `AfterExecutionContext` - Context for after execution hook
- `SettlementContext` - Context for settlement hooks
- `PaymentWrapperHooks` - Server-side hooks configuration

### Hook Types

- `PaymentRequiredHook` - Hook called when payment is required
- `BeforePaymentHook` - Hook called before payment creation
- `AfterPaymentHook` - Hook called after payment submission
- `BeforeExecutionHook` - Hook called before tool execution
- `AfterExecutionHook` - Hook called after tool execution
- `AfterSettlementHook` - Hook called after settlement

## Examples

See the [examples directory](../../../examples/python/) for complete examples.
