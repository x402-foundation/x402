"""Guards the mcp import path x402.mcp.server depends on.

mcp 2.x removed mcp.server.fastmcp in favour of mcp.server.mcpserver. The
x402[mcp] extra is bounded to mcp<2 so installs keep resolving a major that
provides it; this fails if that bound is dropped.
"""

from __future__ import annotations


def test_fastmcp_import_path_available() -> None:
    """mcp.server.fastmcp must provide the names x402.mcp.server imports."""
    from mcp.server.fastmcp import Context, FastMCP

    assert Context is not None
    assert FastMCP is not None
