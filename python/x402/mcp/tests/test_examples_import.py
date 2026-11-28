"""The MCP server examples import, and an unpaid tool call returns payment required."""

import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

EXAMPLES_DIR = Path(__file__).resolve().parents[4] / "examples" / "python" / "servers" / "mcp"

pytestmark = pytest.mark.skipif(
    not EXAMPLES_DIR.is_dir(),
    reason="examples are not shipped in the installed package",
)


def _load_example(monkeypatch: pytest.MonkeyPatch, name: str) -> types.ModuleType:
    """Import one example module from the checkout without starting a server."""
    # The examples read .env through python-dotenv; loading a missing file is a no-op.
    monkeypatch.setenv("EVM_ADDRESS", "0x0000000000000000000000000000000000000001")

    path = EXAMPLES_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"_example_{name}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("name", "entrypoint"),
    [
        ("simple", "run_simple"),
        ("advanced", "run_advanced"),
        ("existing_server", "run_existing"),
    ],
)
def test_examples_import(monkeypatch: pytest.MonkeyPatch, name: str, entrypoint: str) -> None:
    """Each example imports and exposes its entry point."""
    module = _load_example(monkeypatch, name)
    assert callable(getattr(module, entrypoint))


def test_examples_do_not_import_the_removed_sync_bridge() -> None:
    """``wrap_fastmcp_tool_sync`` is not an ``x402.mcp`` export."""
    import x402.mcp

    assert not hasattr(x402.mcp, "wrap_fastmcp_tool_sync")


def test_async_server_has_no_broken_fastmcp_bridge() -> None:
    """``server_async`` does not export ``wrap_fastmcp_tool``."""
    from x402.mcp import server_async

    assert not hasattr(server_async, "wrap_fastmcp_tool")


def test_simple_example_answers_unpaid_call_with_payment_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unpaid ``get_weather`` call returns the wrapper's payment-required result."""
    from mcp.server.fastmcp import FastMCP

    built: dict[str, FastMCP] = {}
    monkeypatch.setattr(FastMCP, "run", lambda self, *a, **k: built.setdefault("mcp", self))

    module = _load_example(monkeypatch, "simple")
    module.run_simple()
    server = built["mcp"]
    tool = server._tool_manager.get_tool("get_weather")  # type: ignore[attr-defined]
    assert tool is not None

    context = SimpleNamespace(
        request_context=SimpleNamespace(meta=SimpleNamespace(model_extra={})),
    )
    result = tool.fn(city="SF", ctx=context)

    assert result.isError is True
    assert result.structuredContent["error"] == "Payment required to access this tool"
    requirement = result.structuredContent["accepts"][0]
    assert requirement["amount"] == "1000"
    assert requirement["network"] == "eip155:84532"


def test_readme_documented_utility_is_importable() -> None:
    """``is_payment_required_error`` is documented in the README utility section."""
    from x402.mcp import is_payment_required_error

    assert callable(is_payment_required_error)
