"""Shared fixtures for ERC-8004 extension tests.

Factory fixtures so a single definition serves every test file: callers pass the
network (8453 vs 31337), config overrides, or a server-set agentId instead of
redefining the builders.
"""

from __future__ import annotations

from typing import Any

import pytest

from x402.extensions.erc8004.types import ERC8004Config
from x402.schemas.payments import PaymentPayload, PaymentRequirements


@pytest.fixture
def make_requirements():
    def _make(
        network: str = "eip155:8453",
        agent_id: int | None = None,
        extra: dict | None = None,
    ) -> PaymentRequirements:
        req_extra = dict(extra or {})
        if agent_id is not None:
            # Server-sourced agentId lives in requirements.extra (never client-echoed).
            req_extra["agentId"] = int(agent_id)
        return PaymentRequirements(
            scheme="exact",
            network=network,
            asset="0x" + "01" * 20,
            amount="1000000",
            pay_to="0x" + "03" * 20,
            max_timeout_seconds=60,
            extra=req_extra,
        )

    return _make


@pytest.fixture
def make_config():
    def _make(**overrides: Any) -> ERC8004Config:
        params: dict[str, Any] = {
            "network": "eip155:8453",
            "reputation_registry": "0x" + "00" * 20,
            "identity_registry": "0x" + "00" * 20,
            "rpc_url": "http://localhost:8545",
        }
        params.update(overrides)
        return ERC8004Config(**params)

    return _make


@pytest.fixture
def make_payload(make_requirements):
    def _make(
        network: str = "eip155:8453",
        payload: dict | None = None,
        extensions: dict | None = None,
    ) -> PaymentPayload:
        return PaymentPayload(
            x402_version=2,
            payload={} if payload is None else payload,
            accepted=make_requirements(network),
            extensions=extensions,
        )

    return _make
