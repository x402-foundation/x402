"""Unit tests for the in-memory server-side channel storage.

Mirrors go/mechanisms/evm/batch-settlement/server/storage_test.go.
"""

from __future__ import annotations

import threading

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.server.storage import (
        Channel,
        InMemoryChannelStorage,
        PendingRequest,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


def _sample_channel(channel_id: str = "0xch", charged: str = "10") -> Channel:
    return Channel(
        channel_id=channel_id,
        channel_config=ChannelConfig(
            payer="0x" + "11" * 20,
            payer_authorizer="0x" + "00" * 20,
            receiver="0x" + "22" * 20,
            receiver_authorizer="0x" + "44" * 20,
            token="0x" + "55" * 20,
            withdraw_delay=900,
            salt="0x" + "00" * 31 + "01",
        ),
        charged_cumulative_amount=charged,
        signed_max_claimable="1000",
        signature="0xsig",
        balance="900",
        total_claimed="100",
        last_request_timestamp=1,
    )


class TestGet:
    def test_missing_returns_none(self):
        s = InMemoryChannelStorage()
        assert s.get("missing") is None

    def test_returns_a_copy(self):
        s = InMemoryChannelStorage()
        channel = _sample_channel()
        s.update_channel(channel.channel_id, lambda _: channel)

        got = s.get(channel.channel_id)
        assert got is not None
        got.balance = "9999"

        again = s.get(channel.channel_id)
        assert again is not None
        assert again.balance == "900"  # storage was not mutated


class TestList:
    def test_empty(self):
        assert InMemoryChannelStorage().list() == []

    def test_lists_all_channels(self):
        s = InMemoryChannelStorage()
        s.update_channel("0xa", lambda _: _sample_channel("0xa", "1"))
        s.update_channel("0xb", lambda _: _sample_channel("0xb", "2"))

        ids = sorted(c.channel_id for c in s.list())
        assert ids == ["0xa", "0xb"]


class TestUpdateChannel:
    def test_returns_updated_when_callback_returns_new(self):
        s = InMemoryChannelStorage()
        result = s.update_channel("0xch", lambda _: _sample_channel())
        assert result.status == "updated"
        assert result.channel is not None
        assert result.channel.channel_id == "0xch"

    def test_returns_unchanged_when_callback_returns_same_object(self):
        s = InMemoryChannelStorage()
        s.update_channel("0xch", lambda _: _sample_channel())
        result = s.update_channel("0xch", lambda current: current)
        assert result.status == "unchanged"

    def test_returns_deleted_when_callback_returns_none(self):
        s = InMemoryChannelStorage()
        s.update_channel("0xch", lambda _: _sample_channel())
        result = s.update_channel("0xch", lambda _: None)
        assert result.status == "deleted"
        assert s.get("0xch") is None

    def test_returns_unchanged_when_deleting_missing_channel(self):
        s = InMemoryChannelStorage()
        result = s.update_channel("0xmissing", lambda _: None)
        assert result.status == "unchanged"

    def test_callback_receives_current_snapshot(self):
        s = InMemoryChannelStorage()
        first = _sample_channel("0xch", "10")
        s.update_channel("0xch", lambda _: first)

        captured: list[Channel | None] = []

        def cb(current: Channel | None) -> Channel:
            captured.append(current)
            assert current is not None
            return _sample_channel("0xch", "20")

        s.update_channel("0xch", cb)
        assert len(captured) == 1
        assert captured[0] is not None
        assert captured[0].charged_cumulative_amount == "10"

    def test_callback_snapshot_is_a_copy(self):
        s = InMemoryChannelStorage()
        s.update_channel("0xch", lambda _: _sample_channel("0xch", "10"))

        def mutating_cb(current: Channel | None) -> Channel | None:
            assert current is not None
            current.balance = "9999"  # mutating the snapshot
            return current  # returning same identity → "unchanged"

        s.update_channel("0xch", mutating_cb)
        assert s.get("0xch").balance == "900"

    def test_channel_id_is_case_insensitive(self):
        s = InMemoryChannelStorage()
        s.update_channel("0xABC", lambda _: _sample_channel("0xABC", "10"))
        assert s.get("0xabc") is not None

    def test_concurrent_updates_do_not_deadlock(self):
        s = InMemoryChannelStorage()
        s.update_channel("0xch", lambda _: _sample_channel())

        def loop() -> None:
            for _ in range(50):
                s.update_channel("0xch", lambda c: _sample_channel("0xch", "20"))
                s.list()

        threads = [threading.Thread(target=loop) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert s.get("0xch") is not None


class TestChannelDataclass:
    def test_to_dict_uses_camel_case(self):
        ch = _sample_channel()
        d = ch.to_dict()
        assert "channelConfig" in d
        assert "chargedCumulativeAmount" in d
        assert "signedMaxClaimable" in d

    def test_round_trip(self):
        ch = _sample_channel()
        ch.pending_request = PendingRequest(
            pending_id="pid", signed_max_claimable="1000", expires_at=1000
        )
        ch.onchain_synced_at = 500
        d = ch.to_dict()
        assert "pendingRequest" in d
        assert "onchainSyncedAt" in d
        assert Channel.from_dict(d) == ch

    def test_copy_is_independent(self):
        ch = _sample_channel()
        c2 = ch.copy()
        c2.balance = "999"
        assert ch.balance == "900"


class TestPendingRequest:
    def test_round_trip(self):
        pr = PendingRequest(pending_id="p", signed_max_claimable="1000", expires_at=999)
        d = pr.to_dict()
        assert d == {
            "pendingId": "p",
            "signedMaxClaimable": "1000",
            "expiresAt": 999,
        }
        assert PendingRequest.from_dict(d) == pr
