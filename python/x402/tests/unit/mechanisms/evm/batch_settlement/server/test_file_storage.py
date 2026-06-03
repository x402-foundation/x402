"""Unit tests for the file-backed server channel storage."""

from __future__ import annotations

from pathlib import Path

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.server.file_storage import (
        FileChannelStorage,
        FileChannelStorageOptions,
    )
    from x402.mechanisms.evm.batch_settlement.server.storage import Channel
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


def _sample_channel(channel_id: str = "0xch", balance: str = "100") -> Channel:
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
        assert s.get("0xmissing") is None

    def test_set_then_get_round_trips(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        ch = _sample_channel("0xch", "100")
        s.update_channel("0xch", lambda _: ch)

        got = s.get("0xch")
        assert got is not None
        assert got.channel_id == "0xch"
        assert got.balance == "100"

    def test_files_are_stored_under_server_subdir(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.update_channel("0xCh", lambda _: _sample_channel("0xCh"))
        # Filenames are lowercased.
        expected = tmp_path / "server" / "0xch.json"
        assert expected.exists()

    def test_list_returns_all_channels(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.update_channel("0xa", lambda _: _sample_channel("0xa"))
        s.update_channel("0xb", lambda _: _sample_channel("0xb"))

        ids = sorted(c.channel_id for c in s.list())
        assert ids == ["0xa", "0xb"]

    def test_list_on_missing_directory_returns_empty(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path / "nope")))
        assert s.list() == []

    def test_delete_via_update(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.update_channel("0xch", lambda _: _sample_channel("0xch"))
        result = s.update_channel("0xch", lambda _: None)
        assert result.status == "deleted"
        assert s.get("0xch") is None
        assert not (tmp_path / "server" / "0xch.json").exists()

    def test_str_directory_argument(self, tmp_path: Path):
        # Constructor accepts a bare string in addition to FileChannelStorageOptions.
        s = FileChannelStorage(str(tmp_path))  # type: ignore[arg-type]
        s.update_channel("0xch", lambda _: _sample_channel("0xch"))
        assert s.get("0xch") is not None

    def test_overwrite_persists_latest_value(self, tmp_path: Path):
        s = FileChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.update_channel("0xch", lambda _: _sample_channel("0xch", "100"))
        s.update_channel("0xch", lambda _: _sample_channel("0xch", "999"))

        got = s.get("0xch")
        assert got is not None and got.balance == "999"
