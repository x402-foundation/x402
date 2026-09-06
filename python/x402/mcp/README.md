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

See the [examples directory](../../examples) for complete examples.
