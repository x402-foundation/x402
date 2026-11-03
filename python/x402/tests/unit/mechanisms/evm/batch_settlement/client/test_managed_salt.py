"""Managed refund consent is part of the buyer's immutable channel identity."""

from types import SimpleNamespace

import pytest

from x402.mechanisms.evm.batch_settlement.client.channel import (
    BatchSettlementClientDeps,
    build_channel_config,
    recover_channel,
)
from x402.mechanisms.evm.batch_settlement.client.storage import InMemoryClientChannelStorage
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id

PAYER = "0x1111111111111111111111111111111111111111"
AUTHOR = "0x5555555555555555555555555555555555555555"


def requirements(mode="facilitator", authorizer=AUTHOR):
    return SimpleNamespace(
        network="eip155:8453",
        pay_to="0x3333333333333333333333333333333333333333",
        asset="0x4444444444444444444444444444444444444444",
        extra={
            "receiverAuthorizer": "0x2222222222222222222222222222222222222222",
            "withdrawDelay": 900,
            "voucherManager": mode,
            "refundAuthorizer": authorizer,
        },
    )


@pytest.mark.parametrize(
    "salt,entropy",
    [
        ("0x" + "00" * 31 + "01", "00" * 11 + "01"),
        ("1", "00" * 11 + "01"),
        ("0x01", "00" * 11 + "01"),
        (" 1 ", "00" * 11 + "01"),
        ("0X1", "00" * 11 + "01"),
        ("0x" + "00" * 32 + "01", "00" * 11 + "01"),
        ("", "00" * 12),
        ("0x" + "ab" * 32, "ab" * 12),
    ],
)
def test_managed_salt_matches_go_12_plus_20_layout(salt, entropy):
    deps = BatchSettlementClientDeps(
        SimpleNamespace(address=PAYER), InMemoryClientChannelStorage(), salt
    )
    config = build_channel_config(deps, requirements())
    assert config.salt == "0x" + entropy + AUTHOR[2:]
    assert deps.salt == salt


@pytest.mark.parametrize(
    "mode,authorizer",
    [
        ("server", AUTHOR),
        ("facilitator", None),
        ("facilitator", "0x" + "00" * 20),
    ],
)
def test_other_modes_keep_raw_salt(mode, authorizer):
    raw = "0x" + "ab" * 32
    deps = BatchSettlementClientDeps(
        SimpleNamespace(address=PAYER), InMemoryClientChannelStorage(), raw
    )
    assert build_channel_config(deps, requirements(mode, authorizer)).salt == raw


@pytest.mark.parametrize("salt", ["-1", "0x", "0xzz", str(1 << 256), str(2**53), "0x" + "ff" * 33])
def test_out_of_range_or_invalid_salt_rejected(salt):
    deps = BatchSettlementClientDeps(
        SimpleNamespace(address=PAYER), InMemoryClientChannelStorage(), salt
    )
    with pytest.raises(ValueError):
        build_channel_config(deps, requirements())


def test_changing_refund_authorizer_creates_new_channel_and_recovery_uses_same_identity():
    calls = []

    def read_contract(*args):
        calls.append(args[-1])
        return [1000, 100]

    deps = BatchSettlementClientDeps(
        SimpleNamespace(address=PAYER, read_contract=read_contract),
        InMemoryClientChannelStorage(),
        "1",
    )
    req = requirements()
    config = build_channel_config(deps, req)
    channel_id = compute_channel_id(config, req.network)
    other = build_channel_config(
        deps, requirements(authorizer="0x6666666666666666666666666666666666666666")
    )
    assert compute_channel_id(other, req.network) != channel_id
    recovered = recover_channel(deps, req)
    assert calls == [channel_id]
    assert deps.storage.get(channel_id.lower()) == recovered
