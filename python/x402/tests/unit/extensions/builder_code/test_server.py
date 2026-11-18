"""Tests for builder-code resource server declaration."""

import pytest

from x402.extensions.builder_code import (
    BUILDER_CODE_SCHEMA,
    MAX_SERVER_SERVICE_CODES,
    declare_builder_code_extension,
)


class TestDeclareBuilderCodeExtension:
    def test_declares_info_and_schema(self) -> None:
        declaration = declare_builder_code_extension("bc_my_service")
        assert declaration == {
            "info": {"a": "bc_my_service"},
            "schema": BUILDER_CODE_SCHEMA,
        }

    def test_rejects_uppercase(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("INVALID")

    def test_rejects_hyphen(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("bad-code")

    def test_rejects_too_long(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("a" * 33)

    def test_rejects_empty(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("")

    def test_declares_service_codes(self) -> None:
        declaration = declare_builder_code_extension("bc_my_service", ["bc_server_sdk", "bc_other"])
        assert declaration == {
            "info": {"a": "bc_my_service", "s": ["bc_server_sdk", "bc_other"]},
            "schema": BUILDER_CODE_SCHEMA,
        }

    def test_declares_a_single_service_code_from_a_string(self) -> None:
        declaration = declare_builder_code_extension("bc_my_service", "bc_server_sdk")
        assert declaration["info"] == {"a": "bc_my_service", "s": ["bc_server_sdk"]}

    def test_rejects_invalid_service_code(self) -> None:
        with pytest.raises(ValueError, match="Invalid builder code"):
            declare_builder_code_extension("bc_my_service", "Bad-Code")

    def test_rejects_too_many_service_codes(self) -> None:
        too_many = [f"bc_{i}" for i in range(MAX_SERVER_SERVICE_CODES + 1)]
        with pytest.raises(ValueError, match="Too many service codes"):
            declare_builder_code_extension("bc_my_service", too_many)

    def test_accepts_exactly_max_server_service_codes(self) -> None:
        at_max = [f"bc_{i}" for i in range(MAX_SERVER_SERVICE_CODES)]
        declaration = declare_builder_code_extension("bc_my_service", at_max)
        assert declaration["info"] == {"a": "bc_my_service", "s": at_max}
