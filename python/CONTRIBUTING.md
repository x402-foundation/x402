# Python SDK Contributing Guide

Guide for developing and contributing to the x402 Python SDK.

## Contents

- [Repository Structure](#repository-structure)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Adding Features](#adding-features)
- [Testing](#testing)
- [Code Quality](#code-quality)
- [Changelog](#changelog)

## Repository Structure

The Python SDK is a single package using `uv` for dependency management.

```
python/
└── x402/
    ├── pyproject.toml
    ├── uv.lock
    ├── src/
    │   └── x402/
    │       ├── __init__.py
    │       ├── types.py           # Core types (Pydantic models)
    │       ├── encoding.py        # Base64 encoding utilities
    │       ├── exact.py           # Exact scheme implementation
    │       ├── facilitator.py     # Facilitator client
    │       ├── clients/
    │       │   ├── base.py        # Base client logic
    │       │   ├── httpx.py       # httpx client integration
    │       │   └── requests.py    # requests client integration
    │       ├── fastapi/
    │       │   └── middleware.py  # FastAPI middleware
    │       └── flask/
    │           └── middleware.py  # Flask middleware
    └── tests/
        ├── clients/
        ├── fastapi_tests/
        └── flask_tests/
```

## Development Setup

### Prerequisites

- Python >= 3.10
- [uv](https://docs.astral.sh/uv/) (recommended) or pip

### Installation with uv

```bash
cd python/x402

# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies
uv sync --all-extras --dev
```

### Installation with pip

```bash
cd python/x402
pip install -e ".[dev]"
```

## Development Workflow

### Common Commands

From the `python/x402/` directory:

| Command | Description |
|---------|-------------|
| `uv sync --dev` | Install/update dependencies |
| `uv run pytest` | Run tests |
| `uvx ruff check` | Lint code |
| `uvx ruff check --fix` | Lint and fix |
| `uvx ruff format` | Format code |

### Running the Package Locally

```bash
# Install in development mode
uv sync --dev

# Import and use
uv run python -c "from x402 import PaymentRequirements; print(PaymentRequirements)"
```

## Adding Features

### Adding a New HTTP Client

To add support for a new HTTP client library:

1. Create a new file in `src/x402/clients/`:

```python
# src/x402/clients/your_client.py
from x402.clients.base import BaseX402Client

class x402YourClient(BaseX402Client):
    """x402 client wrapper for your-library."""
    
    def __init__(self, account, **kwargs):
        super().__init__(account)
        # Initialize your client
    
    # Implement payment handling hooks
```

2. Export from `src/x402/clients/__init__.py`

3. Add tests in `tests/clients/test_your_client.py`

### Adding a New Framework Middleware

To add middleware for a new web framework:

1. Create a new directory in `src/x402/`:

```
src/x402/your_framework/
├── __init__.py
└── middleware.py
```

2. Implement the middleware pattern. Reference `src/x402/fastapi/middleware.py` or `src/x402/flask/middleware.py`.

3. Key responsibilities:
   - Check for payment header on protected routes
   - Return 402 with `PaymentRequiredResponse` if no/invalid payment
   - Call facilitator to verify and settle payments
   - Add `X-PAYMENT-RESPONSE` header on success

4. Add the dependency to `pyproject.toml`:

```toml
dependencies = [
    # ... existing deps
    "your-framework>=1.0.0",
]
```

5. Add tests in `tests/your_framework_tests/`

### Adding a New Chain Mechanism

See [New Chains](../CONTRIBUTING.md#new-chains) in the root contributing guide for protocol-level requirements.

To add support for a new blockchain in Python:

1. Create the mechanism file in `src/x402/your_chain.py`

```python
# src/x402/your_chain.py
from x402.types import PaymentPayload, PaymentRequirements

def sign_payload(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    signer: YourChainSigner
) -> PaymentPayload:
    """Sign a payment payload for your chain."""
    # Implement signing logic
    pass
```

2. Integrate with the client in `src/x402/clients/base.py`
3. Reference `src/x402/exact.py` for the existing EVM implementation pattern

## Testing

### Running Tests

```bash
# All tests
uv run pytest

# Specific test file
uv run pytest tests/test_types.py

# Specific test
uv run pytest tests/test_types.py::test_payment_requirements

# With verbose output
uv run pytest -v

# With coverage
uv run pytest --cov=x402
```

### Test Organization

```
tests/
├── clients/
│   ├── test_base.py
│   ├── test_httpx.py
│   └── test_requests.py
├── fastapi_tests/
│   └── test_middleware.py
├── flask_tests/
│   └── test_middleware.py
├── test_encoding.py
├── test_exact.py
├── test_paywall.py
└── test_types.py
```

### Async Tests

The package uses `pytest-asyncio` with auto mode. Async tests work automatically:

```python
async def test_async_operation():
    result = await some_async_function()
    assert result is not None
```

### Integration Tests

Tests under `tests/integrations/` exercise real RPC endpoints and require
test credentials. They are skipped automatically when the required
environment variables are not set, so a missing `.env` only disables those
tests — unit tests still run normally.

`tests/conftest.py` loads `.env` automatically, searching (in order):

1. `python/x402/.env`
2. the repository root `.env`

Create one and populate the variables for the chains you want to cover:

```bash
cd python/x402
cat > .env <<'EOF'
# EVM (Base Sepolia testnet by default)
EVM_CLIENT_PRIVATE_KEY=
EVM_FACILITATOR_PRIVATE_KEY=
EVM_RESOURCE_SERVER_ADDRESS=
# Optional: override the RPC endpoint
# EVM_RPC_URL=https://sepolia.base.org

# SVM (Solana)
SVM_CLIENT_PRIVATE_KEY=
SVM_FACILITATOR_PRIVATE_KEY=
SVM_FACILITATOR_ADDRESS=
SVM_RESOURCE_SERVER_ADDRESS=
SVM_RPC_URL=
EOF
```

See `tests/integrations/test_evm.py`, `test_mcp_evm.py`, and `test_svm.py`
for the authoritative list of variables each suite reads.

## Code Quality

### Linting

The project uses [Ruff](https://docs.astral.sh/ruff/) for linting:

```bash
# Check for issues
uvx ruff check

# Fix auto-fixable issues
uvx ruff check --fix
```

### Formatting

```bash
uvx ruff format
```

### Type Hints

The package uses Pydantic for runtime validation and includes `py.typed` for type checker support. All public APIs should have type hints:

```python
def create_payment(
    amount: str,
    pay_to: str,
    network: str = "eip155:8453"
) -> PaymentRequirements:
    ...
```

## Changelog

These instructions apply to the **`python/x402` package (v2)**.

For **user-facing changes** (behavior changes, bug fixes, new features, removals), add a Towncrier fragment:

- Location: `python/x402/changelog.d/<PR>.<type>.md`
- Naming convention: `<PR>.<type>.md` (for example, `123.bugfix.md`)
- Allowed types: `feature|bugfix|doc|removal|misc`

Create a fragment (from `python/x402/`):

```bash
uv run towncrier create --content "Fixed ..." 123.bugfix.md
```

### Building the Changelog (Maintainers)

During release, consolidate fragments:

```bash
uv run towncrier build --yes --version=X.Y.Z
```

## Examples

Examples live in `examples/python/`. When adding a new example:

1. Create a directory under the appropriate category (`clients/`, `servers/`, `fullstack/`)
2. Add a `pyproject.toml` with dependencies
3. Add a `README.md` with setup and run instructions

## Publishing

Package publishing to PyPI is handled by maintainers via GitHub Actions. Version bumps are made in `pyproject.toml`.

## Getting Help

- Open an issue on GitHub
- Check the [examples](../examples/python/) for usage patterns
- Reference the [README](x402/README.md) for API documentation
