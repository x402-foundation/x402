# x402 Python Examples

Examples for the x402 Python SDK.

## Quick Start

```bash
cd clients/httpx
cp .env-local .env
# Edit .env with your EVM_PRIVATE_KEY and/or SVM_PRIVATE_KEY
uv sync
uv run python main.py
```

## V2 SDK (Recommended)

### Clients
- **[clients/httpx/](./clients/httpx/)** - Async HTTP client with httpx
- **[clients/requests/](./clients/requests/)** - Sync HTTP client with requests
- **[clients/custom/](./clients/custom/)** - Manual payment handling
- **[clients/advanced/](./clients/advanced/)** - Hooks, selectors, and builder patterns

### Servers
- **[servers/fastapi/](./servers/fastapi/)** - FastAPI server with payment middleware
- **[servers/flask/](./servers/flask/)** - Flask server with payment middleware
- **[servers/custom/](./servers/custom/)** - Manual payment handling
- **[servers/advanced/](./servers/advanced/)** - Dynamic pricing, hooks, and more

### Facilitator
- **[facilitator/](./facilitator/)** - Payment facilitator service

## Legacy SDK

- **[legacy/](./legacy/)** - V1 SDK examples (for backward compatibility)

## Learn More

- [Python SDK](../../python/x402/)
- [x402 Protocol](https://x402.org)
