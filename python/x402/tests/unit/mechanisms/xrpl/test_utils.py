"""Unit tests for XRPL mechanism helpers.

The hash, invoice-id and signature fixtures below were produced by the
TypeScript ``@x402/xrpl`` implementation and asserted here verbatim, so the two
implementations cannot drift apart silently.
"""

from __future__ import annotations

import pytest

from x402.mechanisms.xrpl import utils
from x402.mechanisms.xrpl.constants import XRPL_MAINNET, XRPL_TESTNET
from x402.mechanisms.xrpl.types import resolve_asset_transfer_method
from x402.mechanisms.xrpl.utils import (
    decode_signed_transaction_blob,
    get_signed_transaction_hash,
    invoice_id_to_invoice_id_field,
    is_canonical_signing_pub_key,
    is_issued_currency_amount,
    is_xrpl_network,
    normalize_currency_code,
    parse_drops,
    parse_money_to_decimal,
    parse_xrpl_network_id,
    verify_signed_blob,
)

from .builders import reorder_adjacent_fields

# Signed by xrpl.js; hash and verification result asserted against it.
SIGNED_BLOB = (
    "12000022000000002400000007201B000DBBA05011AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6140000000000003E868400000000000000C73"
    "21EDA57EBBCB502C2009EFE17229E8DC865DCCB192C52D7888D624DC9EBADDB815F07440"
    "CF0D81DA44E81014EBC7133716EB2E6E206229A02419D4FC66CC04DF939B80F485262115"
    "91C0DC8E5B8A7F7A265CB967891828582118BDA6517C61BDD7100A038114A6070B8A1822"
    "E3322676A99F0C804EE2D15B82708314F667B0CA50CC7709A220B0561B85E53A48461FA8"
)
TS_TX_HASH = "A72113911D805AE3C2C456F47988F2EDDF6C456E6E827892F66F3F6BAE8405FC"
TS_INVOICE_FIELD = "CF03639FF20ACC1EEE9DACAEBE37536EF74420FF3FDA092024E943CB429F2311"


class TestNetworks:
    def test_recognises_supported_networks(self):
        assert is_xrpl_network(XRPL_MAINNET)
        assert is_xrpl_network(XRPL_TESTNET)

    def test_accepts_any_xrpl_network_id(self):
        # A private XRPL network or sidechain is a legitimate target given an
        # endpoint override, so the family is a grammar rather than a list.
        assert is_xrpl_network("xrpl:9")
        assert is_xrpl_network("xrpl:1440002")

    def test_rejects_other_chains_and_malformed_ids(self):
        assert not is_xrpl_network("eip155:1")
        assert not is_xrpl_network("xrpl:")
        assert not is_xrpl_network("xrpl:01")
        assert not is_xrpl_network("xrpl:-1")
        assert not is_xrpl_network("xrpl:1.5")
        assert not is_xrpl_network("xrpl:0x1")

    def test_parses_the_numeric_network_id(self):
        assert parse_xrpl_network_id(XRPL_MAINNET) == 0
        assert parse_xrpl_network_id(XRPL_TESTNET) == 1

    def test_parsing_a_malformed_network_raises(self):
        with pytest.raises(ValueError):
            parse_xrpl_network_id("eip155:1")

    def test_a_network_id_beyond_uint32_is_not_a_network(self):
        # NetworkID is a uint32, so a larger id could never be signed. The
        # grammar and the parser must agree: a checker that accepts what the
        # parser rejects reports a facilitator fault for bad input.
        assert is_xrpl_network(f"xrpl:{2**32}") is False
        with pytest.raises(ValueError, match="Unsupported XRPL network"):
            parse_xrpl_network_id(f"xrpl:{2**32}")


class TestDecoding:
    def test_decodes_the_fields_the_facilitator_needs(self):
        decoded = decode_signed_transaction_blob(SIGNED_BLOB)
        assert decoded["TransactionType"] == "Payment"
        assert decoded["Amount"] == "1000"
        assert decoded["Sequence"] == 7
        assert decoded["InvoiceID"] == "A" * 64

    def test_rejects_a_non_hex_blob(self):
        with pytest.raises(ValueError):
            decode_signed_transaction_blob("not-hex")


class TestPaymentFieldAllowlist:
    def test_every_allowlisted_field_is_known_to_the_codec(self):
        # A misspelt entry would never match a decoded field, silently
        # rejecting the payments it was meant to admit. get_field_instance
        # raises KeyError for an unknown name, failing the test with the
        # misspelt entry in the traceback.
        from xrpl.core.binarycodec.definitions import get_field_instance

        for field in utils.ALLOWED_PAYMENT_FIELDS:
            get_field_instance(field)

    def test_the_non_signing_guard_covers_every_transaction_type(self):
        # The Payment template check subsumes the non-signing rejection for
        # Payments, but the non-signing guard is the one that applies to every
        # type: hash identity must not be mintable on any decodable blob.
        from xrpl.core import binarycodec

        blob = binarycodec.encode(
            {
                "TransactionType": "AccountSet",
                "Account": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
                "Fee": "12",
                "Sequence": 7,
                "SigningPubKey": "ED" + "11" * 32,
                "TxnSignature": "AA" * 64,
                "Signature": "AB" * 32,
            }
        )
        with pytest.raises(ValueError, match="non-signing field"):
            decode_signed_transaction_blob(blob)


class TestSignatureVerification:
    """xrpl-py has no verifySignature equivalent, so this is reconstructed."""

    def test_accepts_a_genuine_signature(self):
        assert verify_signed_blob(SIGNED_BLOB) is True

    def test_rejects_a_tampered_blob(self):
        tampered = SIGNED_BLOB[:-2] + ("00" if SIGNED_BLOB[-2:] != "00" else "11")
        assert verify_signed_blob(tampered) is False

    def test_rejects_non_hex_rather_than_raising(self):
        assert verify_signed_blob("not-hex") is False

    def test_rejects_an_empty_blob(self):
        assert verify_signed_blob("") is False

    def test_recognises_canonical_signing_keys(self):
        assert is_canonical_signing_pub_key("ED" + "A" * 64)
        assert is_canonical_signing_pub_key("02" + "B" * 64)
        assert is_canonical_signing_pub_key("03" + "C" * 64)

    def test_rejects_malformed_signing_keys(self):
        assert not is_canonical_signing_pub_key("04" + "A" * 64)
        assert not is_canonical_signing_pub_key("ED" + "A" * 10)
        assert not is_canonical_signing_pub_key(None)


class TestCrossImplementationParity:
    def test_transaction_hash_matches_typescript(self):
        assert get_signed_transaction_hash(SIGNED_BLOB) == TS_TX_HASH

    def test_hashing_a_non_hex_blob_raises(self):
        with pytest.raises(ValueError):
            get_signed_transaction_hash("not-hex")

    def test_odd_length_hex_is_rejected_by_every_guard(self):
        # A serialised transaction is a byte string; bytes.fromhex would raise
        # anyway, and the guards keep the contract consistent.
        with pytest.raises(ValueError):
            get_signed_transaction_hash("ABC")
        with pytest.raises(ValueError):
            decode_signed_transaction_blob("ABC")
        assert verify_signed_blob("ABC") is False

    def test_invoice_id_derivation_matches_typescript(self):
        assert invoice_id_to_invoice_id_field("inv_abc123") == TS_INVOICE_FIELD

    def test_invoice_id_derivation_is_uppercase_hex(self):
        derived = invoice_id_to_invoice_id_field("anything")
        assert len(derived) == 64
        assert derived == derived.upper()


class TestAddressesAndAmounts:
    def test_recognises_a_valid_classic_address(self):
        assert utils.is_classic_address("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe") is True

    def test_rejects_a_malformed_or_non_string_address(self):
        assert utils.is_classic_address("not-an-address") is False
        assert utils.is_classic_address(None) is False

    def test_distinguishes_issued_currency_from_drops(self):
        assert is_issued_currency_amount({"currency": "USD", "issuer": "rIssuer", "value": "10"})
        assert not is_issued_currency_amount("1000")
        assert not is_issued_currency_amount({"currency": "USD"})

    def test_parses_well_formed_drops(self):
        assert parse_drops("0") == 0
        assert parse_drops("1000") == 1000

    def test_rejects_numerals_that_are_not_ascii_digits(self):
        # str.isdigit() is True for all of these. int() parses the Arabic-Indic
        # form and raises on the rest, so neither check is safe alone: without
        # an ASCII-only guard, "٣" would have been accepted as 3.
        for numeral in ("\u00b2", "\u0663", "\u2467", "\u00bd"):
            assert parse_drops(numeral) is None, numeral

    def test_rejects_signed_fractional_and_malformed_drops(self):
        # int() would accept several of these; amounts cross a trust boundary.
        assert parse_drops("-5") is None
        assert parse_drops("1.5") is None
        assert parse_drops("1_000") is None
        assert parse_drops(" 10 ") is None
        assert parse_drops("abc") is None
        assert parse_drops(1000) is None
        assert parse_drops(None) is None


class TestGuardsRejectTrailingNewlines:
    """Python's ``$`` also matches just before a trailing newline, and
    ``bytes.fromhex`` skips whitespace, so a guard anchored with ``$`` calls a
    value with a newline well formed while rippled refuses it."""

    def test_a_blob_with_a_trailing_newline_is_not_hex(self):
        with pytest.raises(ValueError):
            decode_signed_transaction_blob(SIGNED_BLOB + "\n")
        with pytest.raises(ValueError):
            get_signed_transaction_hash(SIGNED_BLOB + "\n")
        assert verify_signed_blob(SIGNED_BLOB + "\n") is False

    def test_the_remaining_guards_agree(self):
        assert parse_drops("100\n") is None
        assert is_xrpl_network("xrpl:1\n") is False
        assert utils.is_issued_currency_value("1.5\n") is False
        assert is_canonical_signing_pub_key("ED" + "A" * 64 + "\n") is False


class TestSignatureCanonicality:
    """Every rejection branch of the DER parser, exercised directly. It is a
    hand-rolled parser on a trust boundary: a branch no test reaches is where
    an accepted malleation would hide."""

    SECP = "02" + "A" * 64
    ED = "ED" + "A" * 64
    ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

    @staticmethod
    def _der(
        r_bytes: bytes, s_bytes: bytes, *, seq: int = 0x30, length: int | None = None
    ) -> bytes:
        body = b"\x02" + bytes([len(r_bytes)]) + r_bytes + b"\x02" + bytes([len(s_bytes)]) + s_bytes
        return bytes([seq, len(body) if length is None else length]) + body

    def _valid_parts(self) -> tuple[bytes, bytes]:
        return (b"\x11" + b"\x22" * 31, b"\x33" + b"\x44" * 31)

    def test_a_well_formed_low_s_signature_is_accepted(self):
        r, s = self._valid_parts()
        assert utils._is_fully_canonical_signature(self._der(r, s), self.SECP) is True

    @pytest.mark.parametrize(
        ("label", "signature"),
        [
            ("too short", b"\x30\x06\x02\x01\x01\x02"),
            ("not a sequence", b"\x31" + b"\x00" * 9),
            ("length byte disagrees", b"\x30\x63\x02\x01\x01\x02\x01\x01\x00"),
            ("r not an integer", b"\x30\x08\x03\x01\x01\x02\x01\x01\x00\x00"),
        ],
    )
    def test_malformed_framing_is_rejected(self, label, signature):
        assert utils._is_fully_canonical_signature(signature, self.SECP) is False, label

    def test_a_zero_length_integer_is_rejected(self):
        r, s = self._valid_parts()
        assert utils._is_fully_canonical_signature(self._der(b"", s), self.SECP) is False
        assert utils._is_fully_canonical_signature(self._der(r, b""), self.SECP) is False

    def test_an_r_length_running_past_the_buffer_is_rejected(self):
        # A length byte the attacker chooses must not index outside the blob.
        assert (
            utils._is_fully_canonical_signature(
                b"\x30\x08\x02\x40\x01\x02\x01\x01\x00\x00", self.SECP
            )
            is False
        )

    def test_a_second_integer_marker_that_is_not_02_is_rejected(self):
        assert (
            utils._is_fully_canonical_signature(
                b"\x30\x08\x02\x01\x01\x03\x01\x01\x00\x00", self.SECP
            )
            is False
        )

    def test_trailing_bytes_after_the_signature_are_rejected(self):
        r, s = self._valid_parts()
        assert utils._is_fully_canonical_signature(self._der(r, s) + b"\x00", self.SECP) is False

    def test_a_negative_integer_is_rejected(self):
        # A leading high bit makes the value negative in DER.
        r, s = self._valid_parts()
        assert (
            utils._is_fully_canonical_signature(self._der(b"\x80" + r[1:], s), self.SECP) is False
        )
        assert (
            utils._is_fully_canonical_signature(self._der(r, b"\x80" + s[1:]), self.SECP) is False
        )

    def test_a_non_minimal_leading_zero_is_rejected(self):
        # Padding is the cheapest malleation: same value, different bytes.
        r, s = self._valid_parts()
        assert utils._is_fully_canonical_signature(self._der(b"\x00" + r, s), self.SECP) is False
        assert utils._is_fully_canonical_signature(self._der(r, b"\x00" + s), self.SECP) is False

    def test_a_leading_zero_that_is_required_is_accepted(self):
        # ...but a zero that keeps a high-bit value positive is correct DER.
        r, s = self._valid_parts()
        assert (
            utils._is_fully_canonical_signature(self._der(b"\x00\x80" + r[2:], s), self.SECP)
            is True
        )

    @pytest.mark.parametrize("value", [0, ORDER])
    def test_an_integer_outside_the_group_is_rejected(self, value):
        r, s = self._valid_parts()
        raw = value.to_bytes(32, "big")
        encoded = b"\x00" + raw if raw[0] & 0x80 else raw
        assert utils._is_fully_canonical_signature(self._der(encoded, s), self.SECP) is False
        assert utils._is_fully_canonical_signature(self._der(r, encoded), self.SECP) is False

    def test_the_high_half_of_the_signature_space_is_rejected(self):
        # s and n-s are both valid signatures; rippled accepts only the lower.
        r, _ = self._valid_parts()
        low = self.ORDER // 2 - 1
        high = self.ORDER - low

        def enc(v):
            raw = v.to_bytes(32, "big")
            return b"\x00" + raw if raw[0] & 0x80 else raw

        assert utils._is_fully_canonical_signature(self._der(r, enc(low)), self.SECP) is True
        assert utils._is_fully_canonical_signature(self._der(r, enc(high)), self.SECP) is False

    @pytest.mark.parametrize("length", [63, 65, 0])
    def test_an_ed25519_signature_of_the_wrong_length_is_rejected(self, length):
        assert utils._is_fully_canonical_signature(b"\x01" * length, self.ED) is False

    def test_an_ed25519_scalar_at_or_above_the_group_order_is_rejected(self):
        order = 2**252 + 27742317777372353535851937790883648493
        below = b"\x00" * 32 + (order - 1).to_bytes(32, "little")
        at = b"\x00" * 32 + order.to_bytes(32, "little")
        assert utils._is_fully_canonical_signature(below, self.ED) is True
        assert utils._is_fully_canonical_signature(at, self.ED) is False


class TestCurrencyNormalisation:
    def test_the_hex_form_of_a_standard_code_normalises_to_the_iso_code(self):
        assert normalize_currency_code("0000000000000000000000005553440000000000") == "USD"
        assert normalize_currency_code("USD") == "USD"

    def test_a_nonstandard_hex_code_keeps_its_hex_spelling(self):
        rlusd = "524C555344000000000000000000000000000000"
        assert normalize_currency_code(rlusd) == rlusd

    @pytest.mark.parametrize("asset", ["TOOLONG", "", None, 7, "XR"])
    def test_a_code_the_ledger_cannot_express_has_no_normal_form(self, asset):
        assert normalize_currency_code(asset) is None


class TestBlobSizeIsBounded:
    def test_a_blob_larger_than_any_transaction_is_refused(self):
        # Decoding is super-linear in field count, so an unbounded blob is a
        # free denial of service for an unauthenticated client.
        oversized = "24" + "0" * utils.MAX_SIGNED_TX_BLOB_HEX
        with pytest.raises(ValueError, match="larger than"):
            decode_signed_transaction_blob(oversized)
        with pytest.raises(ValueError, match="larger than"):
            get_signed_transaction_hash(oversized)


class TestCanonicalSerialisation:
    def test_a_blob_that_is_not_its_own_canonical_form_is_refused(self):
        # Field order is not enforced by the deserialiser, so the same signed
        # transaction has many encodings; only the canonical one is accepted.
        with pytest.raises(ValueError, match="canonical"):
            decode_signed_transaction_blob(reorder_adjacent_fields(SIGNED_BLOB))


class TestMoneyParsing:
    """Feeds the server's money-parser chain; mirrors the sibling mechanisms."""

    @pytest.mark.parametrize(
        ("money", "expected"),
        [("$1.50", 1.5), ("1.50", 1.5), (1.5, 1.5), (2, 2.0), ("$0.01 USD", 0.01)],
    )
    def test_parses_the_formats_the_siblings_accept(self, money, expected):
        assert parse_money_to_decimal(money) == expected

    @pytest.mark.parametrize("money", ["abc", "", "-1", -1, float("nan"), float("inf"), True])
    def test_rejects_what_no_ledger_amount_can_hold(self, money):
        with pytest.raises(ValueError, match="money format"):
            parse_money_to_decimal(money)


class TestSignatureVerificationContainsLibraryFailures:
    def test_a_raising_verifier_yields_false_not_an_exception(self, monkeypatch):
        # An exception escaping here is a facilitator 500 on attacker-supplied
        # input, so the guard must hold even if the crypto library raises.
        blob = SIGNED_BLOB

        def boom(*_args, **_kwargs):
            raise RuntimeError("library failure")

        monkeypatch.setattr(utils.keypairs, "is_valid_message", boom)
        assert utils.verify_signed_blob(blob) is False


class TestAssetTransferMethodResolution:
    """Both sides declare the method. Validating only one side would let a
    client name a method the facilitator never checks."""

    def test_an_invalid_method_on_either_side_is_rejected(self):
        valid = {"assetTransferMethod": "sequence"}
        bad = {"assetTransferMethod": "carrierPigeon"}
        assert resolve_asset_transfer_method(bad, valid)[1] == (
            "invalid_exact_xrpl_asset_transfer_method"
        )
        assert resolve_asset_transfer_method(valid, bad)[1] == (
            "invalid_exact_xrpl_asset_transfer_method"
        )

    @pytest.mark.parametrize(
        "extra",
        [None, {}, {"assetTransferMethod": None}, {"assetTransferMethod": 7}, {"other": [1]}],
    )
    def test_resolution_always_sets_exactly_one_of_method_and_error(self, extra):
        method, error = resolve_asset_transfer_method(extra, extra)
        assert (method is None) != (error is None)
