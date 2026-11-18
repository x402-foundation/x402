"""Tests for builder-code ERC-8021 Schema 2 CBOR encoding and parsing."""

from datetime import datetime

import pytest

from x402.extensions.builder_code import (
    BuilderCodeExtensionData,
    BuilderCodeSuffixData,
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
        assert parsed == BuilderCodeSuffixData(a=APP, w=WALLET, s=[SERVICE])

    def test_single_service_code_normalized_to_list(self) -> None:
        suffix = encode_builder_code_suffix(BuilderCodeExtensionData(s=SERVICE))
        parsed = parse_builder_code_suffix_from_calldata(f"0xdeadbeef{suffix[2:]}")
        assert parsed == BuilderCodeSuffixData(s=[SERVICE])

    def test_multiple_service_codes(self) -> None:
        suffix = encode_builder_code_suffix(
            BuilderCodeExtensionData(a=APP, w=WALLET, s=[SERVICE, "bc_other"])
        )
        parsed = parse_builder_code_suffix_from_calldata(f"0xdeadbeef{suffix[2:]}")
        assert parsed == BuilderCodeSuffixData(a=APP, w=WALLET, s=[SERVICE, "bc_other"])

    def test_no_prefix_calldata(self) -> None:
        suffix = encode_builder_code_suffix(BuilderCodeExtensionData(a=APP))
        parsed = parse_builder_code_suffix_from_calldata(f"deadbeef{suffix[2:]}")
        assert parsed == BuilderCodeSuffixData(a=APP)


class TestParseGuards:
    """Parsing rejects calldata without a valid suffix."""

    def test_no_marker(self) -> None:
        assert parse_builder_code_suffix_from_calldata("0xdeadbeef") is None

    def test_empty(self) -> None:
        assert parse_builder_code_suffix_from_calldata("0x") is None


def _calldata_with_cbor(cbor_hex: str) -> str:
    length = f"{len(cbor_hex) // 2:04x}"
    return f"0xdeadbeef{cbor_hex}{length}02{MARKER}"


def _round_trip(data: BuilderCodeSuffixData) -> BuilderCodeSuffixData | None:
    suffix = encode_builder_code_suffix(data)
    return parse_builder_code_suffix_from_calldata(f"0xdeadbeef{suffix[2:]}")


class TestSettlementMetadata:
    def test_matches_spec_vector(self) -> None:
        suffix = encode_builder_code_suffix(
            BuilderCodeSuffixData(
                a="bc_myapp",
                w="bc_myfacilitator",
                m={"x402Example": 7},
            )
        )
        assert suffix == (
            "0xa361616862635f6d7961707061777062635f6d79666163696c697461746f72"
            "616da16b783430324578616d706c6507002f0280218021802180218021802180218021"
        )

    def test_round_trips_nested_maps_arrays_text_and_uint_boundaries(self) -> None:
        metadata = {
            "zero": 0,
            "inline": 23,
            "oneByte": 24,
            "twoBytes": 2**16,
            "fourBytes": 2**32,
            "eightBytes": 2**63 + 5,
            "maxUint64": 2**64 - 1,
            "text": "hello",
            "list": [1, "two", [3], {"four": 4}],
            "nested": {"inner": {"deep": 1}},
        }
        parsed = _round_trip(BuilderCodeSuffixData(a=APP, w=WALLET, s=SERVICE, m=metadata))
        assert parsed is not None
        assert parsed.m == {
            "zero": 0,
            "inline": 23,
            "oneByte": 24,
            "twoBytes": 65536,
            "fourBytes": 2**32,
            "eightBytes": 2**63 + 5,
            "maxUint64": 2**64 - 1,
            "text": "hello",
            "list": [1, "two", [3], {"four": 4}],
            "nested": {"inner": {"deep": 1}},
        }

    def test_sorts_map_keys_bytewise_by_encoded_form(self) -> None:
        forward = encode_builder_code_suffix(BuilderCodeSuffixData(m={"aa": 1, "b": 2, "c": 3}))
        reversed_keys = encode_builder_code_suffix(
            BuilderCodeSuffixData(m={"c": 3, "b": 2, "aa": 1})
        )
        assert forward == reversed_keys
        sorted_keys = "a361620261630362616101"
        assert sorted_keys in forward

    def test_rejects_metadata_that_does_not_fit_in_65535_bytes(self) -> None:
        with pytest.raises(ValueError, match="maximum is 65535"):
            encode_builder_code_suffix(BuilderCodeSuffixData(m={"big": "x" * 0x10000}))

    def test_rejects_unsupported_numeric_metadata(self) -> None:
        with pytest.raises(ValueError):
            encode_builder_code_suffix(BuilderCodeSuffixData(m={"negative": -1}))
        with pytest.raises(ValueError, match="Unsupported CBOR"):
            encode_builder_code_suffix(BuilderCodeSuffixData(m={"float": 1.5}))
        with pytest.raises(ValueError, match="out of range"):
            encode_builder_code_suffix(BuilderCodeSuffixData(m={"tooLarge": 2**64}))

    @pytest.mark.parametrize(
        "bad",
        [
            True,
            False,
            None,
            b"\x01\x02",
            bytearray(b"\x01"),
            datetime.fromtimestamp(0),
            pytest.param(lambda: 1, id="function"),
            {1: 1},
            pytest.param(object(), id="instance"),
        ],
    )
    def test_rejects_unsupported_metadata_values(self, bad: object) -> None:
        with pytest.raises(ValueError, match="Unsupported CBOR"):
            encode_builder_code_suffix(BuilderCodeSuffixData(m={"bad": bad}))
        with pytest.raises(ValueError, match="Unsupported CBOR"):
            encode_builder_code_suffix(BuilderCodeSuffixData(m={"nested": {"list": [bad]}}))

    def test_rejects_unsupported_metadata_at_the_top_level_of_m(self) -> None:
        with pytest.raises(ValueError, match="Unsupported CBOR"):
            encode_builder_code_suffix(BuilderCodeSuffixData(m=True))

    @pytest.mark.parametrize(
        ("name", "cbor_hex"),
        [
            ("negative integer", "a1616d" + "a1616b20"),
            ("byte string", "a1616d" + "a1616b4100"),
            ("float", "a1616d" + "a1616bf90000"),
            ("tag", "a1616d" + "a1616bc101"),
            ("boolean", "a1616d" + "a1616bf5"),
            ("indefinite-length array", "a1616d" + "a1616b9fff"),
            ("non-text map key", "a1616d" + "a10100"),
            ("truncated value", "a1616d" + "a1616b1b00"),
            ("m that is not a map", "a1616d" + "01"),
        ],
    )
    def test_parser_rejects_unsupported_metadata(self, name: str, cbor_hex: str) -> None:
        assert parse_builder_code_suffix_from_calldata(_calldata_with_cbor(cbor_hex)) is None, name
