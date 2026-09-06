"""Unit tests for the file-backed server channel storage."""

from __future__ import annotations

from pathlib import Path

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.errors import ERR_INVALID_CHANNEL_ID
    from x402.mechanisms.evm.batch_settlement.server.file_storage import (
        FileChannelStorage,
        FileChannelStorageOptions,
    )
    from x402.mechanisms.evm.batch_settlement.server.storage import Channel
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)

TEST_CH_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TEST_CH_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def _sample_channel(channel_id: str = TEST_CH_A, balance: str = "100") -> Channel:
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
        balance=balance,
    )


class TestFileChannelStorage:
    def test_get_missing_returns_none(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        assert s.get(TEST_CH_A) is None

    def test_set_then_get_round_trips(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        ch = _sample_channel(TEST_CH_A, "100")
        s.update_channel(TEST_CH_A, lambda _: ch)

        got = s.get(TEST_CH_A)
        assert got is not None
        assert got.channel_id == TEST_CH_A
        assert got.balance == "100"

    def test_files_are_stored_under_server_subdir(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        upper = "0x" + "AB" * 32
        s.update_channel(upper, lambda _: _sample_channel(upper))
        expected = tmp_path / "server" / f"{upper.lower()}.json"
        assert expected.exists()

    def test_list_returns_all_channels(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.update_channel(TEST_CH_A, lambda _: _sample_channel(TEST_CH_A))
        s.update_channel(TEST_CH_B, lambda _: _sample_channel(TEST_CH_B))

        ids = sorted(c.channel_id for c in s.list())
        assert ids == [TEST_CH_A, TEST_CH_B]

    def test_list_on_missing_directory_returns_empty(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path / "nope")))
        assert s.list() == []

    def test_delete_via_update(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.update_channel(TEST_CH_A, lambda _: _sample_channel(TEST_CH_A))
        result = s.update_channel(TEST_CH_A, lambda _: None)
        assert result.status == "deleted"
        assert s.get(TEST_CH_A) is None
        assert not (tmp_path / "server" / f"{TEST_CH_A}.json").exists()

    def test_str_directory_argument(self, tmp_path: Path):
        # Constructor accepts a bare string in addition to FileChannelStorageOptions.
        s = FileChannelStorage(str(tmp_path))  # type: ignore[arg-type]
        s.update_channel(TEST_CH_A, lambda _: _sample_channel(TEST_CH_A))
        assert s.get(TEST_CH_A) is not None

    def test_overwrite_persists_latest_value(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.update_channel(TEST_CH_A, lambda _: _sample_channel(TEST_CH_A, "100"))
        s.update_channel(TEST_CH_A, lambda _: _sample_channel(TEST_CH_A, "999"))

        got = s.get(TEST_CH_A)
        assert got is not None and got.balance == "999"

    def test_malformed_id_raises(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        with pytest.raises(ValueError, match=ERR_INVALID_CHANNEL_ID):
            s.update_channel("../../evil", lambda _: _sample_channel())
        assert list((tmp_path).rglob("*")) == [] or not any(
            p.suffix == ".json" for p in tmp_path.rglob("*")
        )
