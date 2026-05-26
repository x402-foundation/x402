"""Unit tests for batch-settlement storage utilities.

Mirrors go/mechanisms/evm/batch-settlement/storage_utils_test.go.
"""

from __future__ import annotations

from pathlib import Path

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.storage_utils import (
        delete_file,
        read_json_file,
        write_json_atomic,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


class TestReadJsonFile:
    def test_missing_returns_none(self, tmp_path: Path):
        assert read_json_file(tmp_path / "missing.json") is None

    def test_roundtrip(self, tmp_path: Path):
        path = tmp_path / "data.json"
        payload = {"k": "v", "n": 42, "nested": [1, 2, 3]}
        write_json_atomic(path, payload)
        assert read_json_file(path) == payload

    def test_malformed_raises(self, tmp_path: Path):
        path = tmp_path / "bad.json"
        path.write_text("not json{")
        import json

        with pytest.raises(json.JSONDecodeError):
            read_json_file(path)

    def test_accepts_str_and_path(self, tmp_path: Path):
        path = tmp_path / "data.json"
        write_json_atomic(str(path), {"x": 1})
        assert read_json_file(str(path)) == {"x": 1}


class TestWriteJsonAtomic:
    def test_creates_parent_dirs(self, tmp_path: Path):
        nested = tmp_path / "a" / "b" / "c" / "data.json"
        write_json_atomic(nested, {"x": 1})
        assert nested.exists()

    def test_overwrites_existing(self, tmp_path: Path):
        path = tmp_path / "data.json"
        write_json_atomic(path, {"v": 1})
        write_json_atomic(path, {"v": 2})
        assert read_json_file(path) == {"v": 2}

    def test_no_temp_files_leak(self, tmp_path: Path):
        path = tmp_path / "data.json"
        write_json_atomic(path, {"x": 1})
        entries = [p.name for p in tmp_path.iterdir()]
        assert entries == ["data.json"]

    def test_serializes_with_trailing_newline(self, tmp_path: Path):
        path = tmp_path / "data.json"
        write_json_atomic(path, {"x": 1})
        body = path.read_text(encoding="utf-8")
        assert body.endswith("\n")


class TestDeleteFile:
    def test_deletes_existing(self, tmp_path: Path):
        path = tmp_path / "data.json"
        path.write_text("{}")
        delete_file(path)
        assert not path.exists()

    def test_missing_is_noop(self, tmp_path: Path):
        # Should not raise
        delete_file(tmp_path / "missing.json")
