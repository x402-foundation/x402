# x402 Extensions

Optional extensions that enhance the x402 payment protocol with additional functionality.

## Installation

```bash
uv add x402[extensions]
```

## Bazaar Discovery Extension

Enables facilitators to automatically catalog and index x402-enabled resources by following server-declared discovery instructions.

### For Resource Servers

Declare endpoint discovery metadata in route configuration:

```python
from x402.extensions.bazaar import declare_discovery_extension

routes = {
    "GET /api/weather": {
        "accepts": {
            "scheme": "exact",
            "price": "$0.001",
            "network": "eip155:84532",
            "payTo": "0x...",
        },
        "extensions": {
            **declare_discovery_extension(
                input={"city": "San Francisco"},
                input_schema={
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
                output={"example": {"temp": 15, "weather": "foggy"}},
            ),
        },
    },
}
```

#### POST Endpoint with JSON Body

```python
routes = {
    "POST /api/translate": {
        "accepts": {...},
        "extensions": {
            **declare_discovery_extension(
                input={"text": "Hello", "targetLanguage": "es"},
                input_schema={
                    "properties": {
                        "text": {"type": "string"},
                        "targetLanguage": {"type": "string"},
                    },
                    "required": ["text", "targetLanguage"],
                },
                body_type="json",
                output={"example": {"translated": "Hola"}},
            ),
        },
    },
}
```

#### MCP Tool

For paid MCP tools, use `declare_mcp_discovery_extension` instead:

```python
from x402.mcp import create_payment_wrapper
from x402.extensions.bazaar import DeclareMcpDiscoveryConfig, declare_mcp_discovery_extension

weather_discovery = declare_mcp_discovery_extension(
    DeclareMcpDiscoveryConfig(
        tool_name="get_weather",
        description="Get current weather for a city",
        input_schema={
            "properties": {"city": {"type": "string", "description": "City name"}},
            "required": ["city"],
        },
        example={"city": "San Francisco"},
    )
)

weather_wrapper = create_payment_wrapper(
    resource_server,
    accepts=weather_accepts,
    resource=ResourceInfo(url="mcp://tool/get_weather"),
    extensions=weather_discovery,  # Bazaar metadata attached to PaymentRequired
)
```

### For Facilitators

Extract discovery information from payment requests:

```python
from x402.extensions.bazaar import extract_discovery_info

discovered = extract_discovery_info(payment_payload, payment_requirements)

if discovered:
    print(f"Resource: {discovered.resource_url}")
    print(f"Method: {discovered.method}")
    print(f"Input: {discovered.discovery_info.input}")
```

#### Validation

```python
from x402.extensions.bazaar import validate_discovery_extension

result = validate_discovery_extension(extension)
if not result.valid:
    print(f"Errors: {result.errors}")
```

### Server Extension Registration

Auto-enrich extensions with HTTP method from route:

```python
from x402.extensions.bazaar import bazaar_resource_server_extension

server = x402ResourceServer(facilitator)
server.register_extension(bazaar_resource_server_extension)
```

The middleware auto-registers this if routes declare bazaar extensions.

## API Reference

### `declare_discovery_extension()`

Creates a discovery extension for route configuration.

**Parameters:**
- `input` - Example input values (query params for GET, body for POST)
- `input_schema` - JSON Schema for input validation
- `body_type` - For POST/PUT/PATCH: `"json"`, `"form-data"`, or `"text"`
- `output` - Output specification with `example` field

**Returns:** `{"bazaar": {...}}`

### `extract_discovery_info()`

Extracts discovery info from a payment (for facilitators).

**Parameters:**
- `payment_payload` - Payment payload from client
- `payment_requirements` - Requirements from server
- `validate` - Whether to validate (default: True)

**Returns:** `DiscoveredResource` or `None`

```python
@dataclass
class DiscoveredResource:
    resource_url: str
    method: str
    x402_version: int
    discovery_info: DiscoveryInfo
```

### `validate_discovery_extension()`

Validates extension schema.

**Returns:** `ValidationResult(valid=bool, errors=list[str])`

## V1 Compatibility

V1 discovery info is stored in `PaymentRequirements.output_schema`. The `extract_discovery_info` function handles both V1 and V2 formats automatically.

