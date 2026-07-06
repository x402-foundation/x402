"""Tests for ERC-8004 extension schema."""

from x402.extensions.erc8004.schema import declare_erc8004_extension, erc8004_schema


def test_declare_extension_is_presence_marker() -> None:
    decl = declare_erc8004_extension()
    # Presence marker only — no agentId on the wire (it is server-sourced at settle).
    assert decl["info"] == {}
    assert "agentId" not in decl["info"]
    assert decl["schema"]["$schema"] == "https://json-schema.org/draft/2020-12/schema"


def test_schema_structure() -> None:
    assert erc8004_schema["type"] == "object"
    assert erc8004_schema["properties"] == {}
    assert "required" not in erc8004_schema
