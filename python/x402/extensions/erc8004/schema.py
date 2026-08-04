"""JSON Schema for the ERC-8004 extension declaration."""

from typing import Any

# Presence marker only. agentId is sourced server-side at settle (requirements.extra),
# never sent to or echoed by the client, so the declaration carries no fields.
erc8004_schema: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {},
}


def declare_erc8004_extension() -> dict[str, Any]:
    """Declare the erc8004 extension for inclusion in PaymentRequired.extensions.

    A presence marker so clients/aggregators can discover that the agent supports
    ticket-gated feedback. Carries no ``agentId`` — that is server-sourced at settle.
    """
    return {
        "info": {},
        "schema": erc8004_schema,
    }
