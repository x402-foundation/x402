"""Shared fixtures for ERC-8004 extension tests.

Factory fixtures so a single definition serves every test file: callers pass the
network (8453 vs 31337) or config overrides instead of redefining the builders.
"""

from __future__ import annotations

from typing import Any

import pytest

from x402.extensions.erc8004.types import EXTENSION_KEY, ERC8004Config
from x402.schemas.payments import PaymentPayload, PaymentRequirements


@pytest.fixture
def make_requirements():
    def _make(network: str = "eip155:8453") -> PaymentRequirements:
        return PaymentRequirements(
            scheme="exact",
            network=network,
            asset="0x" + "01" * 20,
            amount="1000000",
            pay_to="0x" + "03" * 20,
            max_timeout_seconds=60,
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


@pytest.fixture
def make_payload_with_agent(make_payload):
    def _make(
        agent_id: int = 42,
        network: str = "eip155:31337",
        info: dict | None = None,
        payload: dict | None = None,
    ) -> PaymentPayload:
        return make_payload(
            network=network,
            payload=payload if payload is not None else {"authorization": {"from": "0x" + "02" * 20}},
            extensions={EXTENSION_KEY: {"info": info or {"agentId": agent_id}}},
        )

    return _make
