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
    from x402.mechanisms.evm.batch_settlement.errors import ERR_INVALID_CHANNEL_ID
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)

TEST_CH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


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
        assert s.get(TEST_CH) is None

    def test_set_then_get(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        upper = "0x" + "AB" * 32
        s.set(upper, _ctx("100"))
        got = s.get(upper)
        assert got is not None
        assert got.balance == "100"

    def test_persists_under_client_subdir_with_lowercase_filename(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        upper = "0x" + "AB" * 32
        s.set(upper, _ctx())
        assert (tmp_path / "client" / f"{upper.lower()}.json").exists()

    def test_lookup_is_case_insensitive(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        upper = "0x" + "AB" * 32
        s.set(upper, _ctx("100"))
        assert s.get(upper.lower()) is not None
        assert s.get(upper.upper().replace("X", "x", 1)) is not None

    def test_delete(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.set(TEST_CH, _ctx())
        s.delete(TEST_CH)
        assert s.get(TEST_CH) is None
        assert not (tmp_path / "client" / f"{TEST_CH}.json").exists()

    def test_delete_missing_is_noop(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.delete(TEST_CH)  # should not raise

    def test_overwrite_persists_latest(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        s.set(TEST_CH, _ctx("1"))
        s.set(TEST_CH, _ctx("999"))
        got = s.get(TEST_CH)
        assert got is not None and got.balance == "999"

    def test_directory_argument_accepts_str(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=str(tmp_path)))
        s.set(TEST_CH, _ctx())
        assert s.get(TEST_CH) is not None

    def test_malformed_raises(self, tmp_path: Path):
        s = FileClientChannelStorage(FileChannelStorageOptions(directory=tmp_path))
        with pytest.raises(ValueError, match=ERR_INVALID_CHANNEL_ID):
            s.set("../../evil", _ctx())
        assert not any(tmp_path.rglob("*.json"))
