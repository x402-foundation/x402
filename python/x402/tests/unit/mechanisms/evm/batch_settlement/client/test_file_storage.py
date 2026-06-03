"""Unit tests for the file-backed client channel storage."""

from __future__ import annotations

from pathlib import Path

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.client.file_storage import (
        FileChannelStorageOptions,
        FileClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


def _ctx(balance: str = "100") -> BatchSettlementClientContext:
    return BatchSettlementClientContext(
        charged_cumulative_amount="10",
        balance=balance,
        total_claimed="0",
        signed_max_claimable="10",
        signature="0xsig",
    )


class TestFileClientChannelStorage:
    def test_get_missing(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        assert s.get("0xmissing") is None

    def test_set_then_get(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.set("0xCh", _ctx("100"))
        got = s.get("0xCh")
        assert got is not None
        assert got.balance == "100"

    def test_persists_under_client_subdir_with_lowercase_filename(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.set("0xCh", _ctx())
        assert (tmp_path / "client" / "0xch.json").exists()

    def test_lookup_is_case_insensitive(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.set("0xCh", _ctx("100"))
        assert s.get("0xch") is not None
        assert s.get("0xCH") is not None

    def test_delete(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.set("0xch", _ctx())
        s.delete("0xch")
        assert s.get("0xch") is None
        assert not (tmp_path / "client" / "0xch.json").exists()

    def test_delete_missing_is_noop(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.delete("0xmissing")  # should not raise

    def test_overwrite_persists_latest(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.set("0xch", _ctx("1"))
        s.set("0xch", _ctx("999"))
        got = s.get("0xch")
        assert got is not None and got.balance == "999"

    def test_directory_argument_accepts_str(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.set("0xch", _ctx())
        assert s.get("0xch") is not None
