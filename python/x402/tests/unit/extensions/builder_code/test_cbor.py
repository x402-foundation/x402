"""Tests for builder-code ERC-8021 Schema 2 CBOR encoding and parsing."""

from x402.extensions.builder_code import (
    BuilderCodeExtensionData,
    encode_builder_code_suffix,
    parse_builder_code_suffix_from_calldata,
)

APP = "bc_my_app"
SERVICE = "bc_my_client"
WALLET = "bc_my_facilitator"

MARKER = "80218021802180218021802180218021"

# Spec vector: CBOR {"a": "bc_myapp"} + length 0x000c + schema 0x02 + marker
APP_ONLY_SUFFIX = "0x" + "a161616862635f6d79617070" + "000c" + "02" + MARKER

# Spec vector: CBOR {"a": "bc_myapp", "w": "bc_myfacilitator"} + 0x001f + 0x02 + marker
APP_FAC_SUFFIX = (
    "0x" + "a261616862635f6d7961707061777062635f6d79666163696c697461746f72" + "001f" + "02" + MARKER
)


class TestEncodeSpecVectors:
    """Exact hex vectors from the builder-code spec."""

    def test_app_only_vector(self) -> None:
        suffix = encode_builder_code_suffix(BuilderCodeExtensionData(a="bc_myapp"))
        assert suffix == APP_ONLY_SUFFIX

    def test_app_and_facilitator_vector(self) -> None:
        suffix = encode_builder_code_suffix(
            BuilderCodeExtensionData(a="bc_myapp", w="bc_myfacilitator")
        )
        assert suffix == APP_FAC_SUFFIX


class TestRoundTrip:
    """encode → parse round-trips."""

    def test_all_fields(self) -> None:
        suffix = encode_builder_code_suffix(BuilderCodeExtensionData(a=APP, w=WALLET, s=SERVICE))
        parsed = parse_builder_code_suffix_from_calldata(f"0xdeadbeef{suffix[2:]}")
        assert parsed == BuilderCodeExtensionData(a=APP, w=WALLET, s=[SERVICE])

    def test_single_service_code_normalized_to_list(self) -> None:
        suffix = encode_builder_code_suffix(BuilderCodeExtensionData(s=SERVICE))
        parsed = parse_builder_code_suffix_from_calldata(f"0xdeadbeef{suffix[2:]}")
        assert parsed == BuilderCodeExtensionData(s=[SERVICE])

    def test_multiple_service_codes(self) -> None:
        suffix = encode_builder_code_suffix(
            BuilderCodeExtensionData(a=APP, w=WALLET, s=[SERVICE, "bc_other"])
        )
        parsed = parse_builder_code_suffix_from_calldata(f"0xdeadbeef{suffix[2:]}")
        assert parsed == BuilderCodeExtensionData(a=APP, w=WALLET, s=[SERVICE, "bc_other"])

    def test_no_prefix_calldata(self) -> None:
        suffix = encode_builder_code_suffix(BuilderCodeExtensionData(a=APP))
        parsed = parse_builder_code_suffix_from_calldata(f"deadbeef{suffix[2:]}")
        assert parsed == BuilderCodeExtensionData(a=APP)


class TestParseGuards:
    """Parsing rejects calldata without a valid suffix."""

    def test_no_marker(self) -> None:
        assert parse_builder_code_suffix_from_calldata("0xdeadbeef") is None

    def test_empty(self) -> None:
        assert parse_builder_code_suffix_from_calldata("0x") is None
