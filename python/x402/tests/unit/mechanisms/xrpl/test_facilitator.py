"""Verification and settlement tests for the XRPL exact scheme."""

from __future__ import annotations

from decimal import Decimal

import pytest
from xrpl.core import binarycodec
from xrpl.wallet import Wallet

from x402.mechanisms.xrpl import settlement_cache as settlement_cache_module
from x402.mechanisms.xrpl.constants import XRPL_MAINNET, XRPL_TESTNET
from x402.mechanisms.xrpl.exact import ExactXrplClientScheme, ExactXrplFacilitatorScheme
from x402.mechanisms.xrpl.exact.facilitator import _decimal
from x402.mechanisms.xrpl.settlement_cache import (
    DEFAULT_SETTLEMENT_TTL_SECONDS,
    SettlementCache,
)
from x402.mechanisms.xrpl.utils import (
    ALLOWED_PAYMENT_FIELDS,
    decode_signed_transaction_blob,
    get_max_last_ledger_sequence,
    get_signed_transaction_hash,
    verify_signed_blob,
)

from .builders import (
    CURRENT_LEDGER,
    INVOICE_ID,
    MERCHANT,
    base_fields,
    make_client_options,
    make_options,
    make_payload,
    make_requirements,
    make_wallet,
    reorder_adjacent_fields,
    sign_payment,
    sign_raw,
)


def _scheme(**kwargs):
    return ExactXrplFacilitatorScheme(make_options(**kwargs))


class TestHappyPath:
    def test_accepts_a_well_formed_payment(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        result = _scheme().verify(payload, requirements)
        assert result.is_valid is True
        assert result.payer == wallet.address

    def test_accepts_a_payment_bound_to_an_invoice(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "invoiceId": INVOICE_ID}
        )
        payload = make_payload(sign_payment(wallet, invoice_id=INVOICE_ID), requirements)
        assert _scheme().verify(payload, requirements).is_valid is True

    def test_advertises_no_signers_and_no_fee_sponsorship(self):
        scheme = ExactXrplFacilitatorScheme()
        assert scheme.get_signers(XRPL_TESTNET) == []
        assert scheme.get_extra(XRPL_TESTNET) == {"areFeesSponsored": False}


class TestEnvelope:
    def test_rejects_a_scheme_mismatch(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        payload.accepted.scheme = "upto"
        assert _scheme().verify(payload, requirements).invalid_reason == "unsupported_scheme"

    def test_rejects_a_non_xrpl_network(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        requirements.network = "eip155:1"
        assert _scheme().verify(payload, requirements).invalid_reason == "invalid_network"

    def test_rejects_accepted_terms_on_a_different_network(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        payload.accepted.network = XRPL_MAINNET
        result = _scheme().verify(payload, requirements)
        assert result.invalid_reason == "invalid_exact_xrpl_network_mismatch"

    def test_rejects_accepted_terms_that_differ_from_required_terms(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(
            sign_payment(wallet),
            requirements,
            accepted_extra={"assetTransferMethod": "ticketSequence"},
        )
        result = _scheme().verify(payload, requirements)
        assert result.invalid_reason == "invalid_exact_xrpl_asset_transfer_method_mismatch"


class TestBlobMustBeCanonical:
    """XRPL's deserialiser accepts fields in any order, so one signed
    transaction has many valid encodings, each with a different blob hash
    and each with a valid signature, because the signature is checked over a
    canonical re-encoding. The duplicate-settlement guard is keyed on that
    hash, so accepting a re-ordered blob lets one payment settle once per
    ordering. rippled also assigns the id from its own canonical form, so the
    settlement would poll a transaction id the ledger never uses."""

    def test_a_reordered_blob_decodes_and_verifies_the_same_but_is_refused(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet)
        reordered = reorder_adjacent_fields(blob)

        # The two are the same transaction to the codec, and differ only in
        # the hash the settlement guard is keyed on, which is why the blob,
        # not the decoded fields, has to be what is checked.
        assert binarycodec.decode(reordered) == binarycodec.decode(blob)
        assert get_signed_transaction_hash(reordered) != get_signed_transaction_hash(blob)
        # The signature is valid over the re-ordered bytes too: it is checked
        # against a canonical re-encoding, so it cannot tell the two apart.
        assert verify_signed_blob(blob) is True

        assert _scheme().verify(make_payload(blob, requirements), requirements).is_valid is True
        assert _scheme().verify(
            make_payload(reordered, requirements), requirements
        ).invalid_reason == ("invalid_exact_xrpl_payload_blob")

    def test_one_payment_cannot_settle_twice_by_re_serialising_it(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet)
        scheme = _scheme()

        assert scheme.settle(make_payload(blob, requirements), requirements).success is True
        second = scheme.settle(
            make_payload(reorder_adjacent_fields(blob), requirements), requirements
        )
        assert second.success is False

    @pytest.mark.parametrize(
        "field", ["Signature", "MasterSignature", "CounterpartySignature", "BatchSigners"]
    )
    def test_an_extra_non_signing_field_cannot_mint_a_second_identity(self, field):
        # The signature covers only the signing fields, so anyone can append
        # another non-signing one to a validly signed blob: the signing payload
        # is unchanged, the blob is still its own canonical form, and the
        # transaction hash moves. The duplicate-settlement guard is keyed on
        # that hash, so this would mint unlimited identities for one payment.
        wallet = make_wallet()
        requirements = make_requirements()
        tx = binarycodec.decode(sign_payment(wallet))
        tx[field] = "AB" * 32 if field != "BatchSigners" else []
        try:
            variant = binarycodec.encode(tx)
        except Exception:
            pytest.skip(f"{field} is not encodable in this codec version")

        assert verify_signed_blob(variant) is False
        assert _scheme().verify(
            make_payload(variant, requirements), requirements
        ).invalid_reason == ("invalid_exact_xrpl_payload_blob")

    def test_one_payment_cannot_settle_twice_by_adding_a_non_signing_field(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet)
        scheme = _scheme()
        assert scheme.settle(make_payload(blob, requirements), requirements).success is True

        tx = binarycodec.decode(blob)
        tx["Signature"] = "CD" * 32
        second = scheme.settle(make_payload(binarycodec.encode(tx), requirements), requirements)
        assert second.success is False

    def test_a_trailing_newline_is_refused_rather_than_verified(self):
        # Python's $ matches before a trailing newline and bytes.fromhex
        # skips whitespace, so a guard anchored with $ accepts "<hex>\n" while
        # rippled refuses it at submission: a verify/settle disagreement any
        # client could trigger.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet) + "\n", requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_blob"
        )

    def test_an_oversized_blob_is_refused_before_it_is_decoded(self):
        # Decoding is super-linear in field count, so an unbounded blob is free
        # CPU for an unauthenticated client. The length cap runs before both
        # the hex scan and the decode, so the rejection costs one comparison
        # rather than growing with the input.
        requirements = make_requirements()
        payload = make_payload("2400000005" * 50_000, requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_blob"
        )


class TestPaymentFieldAllowlist:
    """Payments are held to rippled's own field template; the rationale for
    pinning acceptance there rather than to the codec's field classification
    is with ALLOWED_PAYMENT_FIELDS in utils.py."""

    @pytest.mark.parametrize(
        ("field", "value"),
        [("OfferSequence", 1), ("ClearFlag", 1), ("TicketCount", 1)],
    )
    def test_a_signing_field_foreign_to_payment_is_refused(self, field, value):
        # Signed by the payer over the foreign field, so neither the signature
        # check nor the non-signing guard objects first: the allowlist is the
        # sole rejector, as it will be for fields future amendments add.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(wallet, base_fields(wallet, **{field: value}))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_blob"
        )

    def test_tolerated_fields_still_verify(self):
        # Every field the ledger accepts on a Payment and the TypeScript
        # facilitator tolerates must stay accepted: the allowlist pins
        # today's acceptance, it does not narrow it. PreviousTxnID and
        # OperationLimit are the easy ones to lose, legacy optional fields
        # rippled's template still admits that no current SDK model emits.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(
            wallet,
            base_fields(
                wallet,
                SourceTag=7,
                AccountTxnID="AB" * 32,
                PreviousTxnID="BC" * 32,
                OperationLimit=1,
                DomainID="CD" * 32,
                CredentialIDs=["EF" * 32],
            ),
        )
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is True

    def test_a_non_payment_transaction_still_gets_the_type_reason(self):
        # The allowlist is a Payment rule. Holding every transaction type to
        # it would report an AccountSet as a malformed blob and leave the
        # transaction-type reason code unreachable.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(
            wallet,
            {
                "TransactionType": "AccountSet",
                "Account": wallet.address,
                "Fee": "12",
                "Flags": 0,
                "Sequence": 7,
                "LastLedgerSequence": CURRENT_LEDGER + 10,
                "ClearFlag": 1,
            },
        )
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_transaction_type"
        )


# Joint cross-implementation vectors: real Devnet transactions, validated
# on-ledger, published in whawk46/xls68-x402-fee-sponsoring
# (test-vectors/sponsoring-test-vectors.json) and re-derivable from public
# Devnet history via the tx method with binary: true. Asserted verbatim,
# like the TypeScript fixtures in test_utils.py.
SPONSORED_DEVNET_BLOB = (
    "120000240040414E201B0040417A204A0000000161D488E1BC9BF0400000000000000000"
    "000000000046434400000000000F8AE3322434A9F800DE6F3F8A3CE4571651C33D684000"
    "00000000000C7321EDA1EC51E363E86F50C845611412C6CB8F5736BA25EF9406DA516D5F"
    "8A543A394C7440EE1C0CED21D3794FBFBA5E61F4BC44B880BD3A591118138DDCF2007573"
    "1D355F8EEDF56EAD11F4A662E3B974BF7D3F4665CAEF4EAF61ACB4015B2E7C36CF110181"
    "14C226FF9458B8B0D6EEF1C504BC3178F68FD9E1BE83146E7807830BEA4C9D495B091E8C"
    "C2FFDB39BD0278801B146C92943ED80CB008FBC02B38EC7D35F74B8A3FE5E0267321EDE8"
    "70C1A491E87A212D41DBF634476D4A1E50AF3D7CE94CA9BFB8BD476F4CF9317440BCAA29"
    "225213CE6A1B85D85756A55B7C5B6F5FB9213D294190F9851BFA8CAD9BEF43BF1E2E47B0"
    "F472E042D986E0CB3B22446F1F8DB6B1E7B06F410CD8B86F07E1"
)
SPONSORED_DEVNET_HASH = "F306E3053CA5317F4464E62EA074B6DBE5F2CD53A7428AB6CC43C3615CDCB32A"
PLAIN_DEVNET_BLOB = (
    "120000240040414A201B0040417761D4C38D7EA4C6800000000000000000000000000046"
    "434400000000000F8AE3322434A9F800DE6F3F8A3CE4571651C33D68400000000000000C"
    "7321ED43DBB35E73B8FC96EC70B956E76CF4C3B4C9611BA9FDD290A90BD8831FD80D3274"
    "4009C627784FE8F420E459904E98E3AB7BAA6A216F7352F498848185C8B945861CB77225"
    "4695A2F1D98C47EB893C1705AC19575CA1D7F1294886F23CE68248730681140F8AE33224"
    "34A9F800DE6F3F8A3CE4571651C33D8314C226FF9458B8B0D6EEF1C504BC3178F68FD9E1"
    "BE"
)
PLAIN_DEVNET_HASH = "A13433C559E76157BEBF9965328C562F0FA571477760A14E9D6E21FB83870703"


class TestJointSponsorshipVectors:
    """The fee-sponsoring extension's joint vectors, checked against the same
    bytes the extension-aware implementation checks. The sponsored Payment
    carries XLS-68 fields outside the Payment allowlist, so a base facilitator
    must refuse it on the blob; the plain Payment is the acceptance control at
    the same layer."""

    def test_the_sponsored_payment_is_refused_on_the_bytes(self):
        # The exception type and the reason code are the stable contract; the
        # failing layer migrates from codec-unknown to the blob field guards
        # (this blob's SponsorSignature is non-signing on xrpl-py main) when
        # xrpl-py ships the XLS-68 definitions, with the same outcome.
        assert get_signed_transaction_hash(SPONSORED_DEVNET_BLOB) == SPONSORED_DEVNET_HASH
        with pytest.raises(ValueError):
            decode_signed_transaction_blob(SPONSORED_DEVNET_BLOB)

        requirements = make_requirements()
        payload = make_payload(SPONSORED_DEVNET_BLOB, requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_blob"
        )

    def test_the_plain_payment_is_accepted_at_the_same_layer(self):
        # Byte-level acceptance only: the vector's own claim is that every
        # field is in the allowlist, and its genuine Devnet signature verifies
        # offline. Full verification is out of the vector's scope; this blob
        # carries no SendMax, so the IOU SendMax rule would refuse it there.
        assert get_signed_transaction_hash(PLAIN_DEVNET_BLOB) == PLAIN_DEVNET_HASH
        decoded = decode_signed_transaction_blob(PLAIN_DEVNET_BLOB)
        assert decoded["TransactionType"] == "Payment"
        assert set(decoded) <= ALLOWED_PAYMENT_FIELDS
        assert verify_signed_blob(PLAIN_DEVNET_BLOB) is True


class TestSignatureMustBeFullyCanonical:
    """A signature is malleable: an attacker holding no key can rewrite one
    into another that still verifies but hashes differently. rippled refuses
    those, so accepting them means verification passes for a transaction that
    can never settle: the resource handler runs, settlement fails, and the
    attacker repeats it for free."""

    SECP256K1_GROUP_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

    @staticmethod
    def _der(r_value: int, s_value: int) -> bytes:
        def encode(value: int) -> bytes:
            raw = value.to_bytes((value.bit_length() + 7) // 8 or 1, "big")
            return b"\x00" + raw if raw[0] & 0x80 else raw

        r_bytes, s_bytes = encode(r_value), encode(s_value)
        body = b"\x02" + bytes([len(r_bytes)]) + r_bytes
        body += b"\x02" + bytes([len(s_bytes)]) + s_bytes
        return b"\x30" + bytes([len(body)]) + body

    def _high_s_variant(self, blob: str) -> str:
        tx = binarycodec.decode(blob)
        signature = bytes.fromhex(tx["TxnSignature"])
        r_length = signature[3]
        r_value = int.from_bytes(signature[4 : 4 + r_length], "big")
        s_start = 4 + r_length + 2
        s_length = signature[4 + r_length + 1]
        s_value = int.from_bytes(signature[s_start : s_start + s_length], "big")
        tx["TxnSignature"] = self._der(r_value, self.SECP256K1_GROUP_ORDER - s_value).hex().upper()
        return binarycodec.encode(tx)

    def test_a_negated_secp256k1_signature_is_refused(self):
        # Negating s needs no private key and yields a second valid-looking
        # blob for the same payment, with its own transaction hash.
        wallet = Wallet.create(algorithm="secp256k1")
        requirements = make_requirements()
        blob = sign_payment(wallet)
        malleated = self._high_s_variant(blob)

        assert get_signed_transaction_hash(malleated) != get_signed_transaction_hash(blob)
        assert _scheme().verify(make_payload(blob, requirements), requirements).is_valid is True
        assert _scheme().verify(
            make_payload(malleated, requirements), requirements
        ).invalid_reason == ("invalid_exact_xrpl_payload_signature")

    def test_a_genuine_signature_of_either_algorithm_still_verifies(self):
        requirements = make_requirements()
        for algorithm in ("secp256k1", "ed25519"):
            wallet = Wallet.create(algorithm=algorithm)
            payload = make_payload(sign_payment(wallet), requirements)
            result = _scheme().verify(payload, requirements)
            assert result.is_valid is True, f"{algorithm}: {result.invalid_reason}"


class TestSignature:
    def test_a_blob_with_no_usable_account_is_bad_input_not_a_facilitator_fault(self):
        # A client can sign a Payment that simply omits Account: the signature
        # covers whatever fields are there, so it verifies. Raising on the
        # missing field would then report plainly bad client input under the
        # facilitator-error code every sibling field avoids.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(
            wallet,
            {
                "TransactionType": "Payment",
                "Destination": MERCHANT,
                "Amount": "1000",
                "Fee": "12",
                "Flags": 0,
                "Sequence": 7,
                "LastLedgerSequence": CURRENT_LEDGER + 10,
            },
        )
        assert verify_signed_blob(blob) is True
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_blob"
        )

    def test_rejects_a_signing_key_that_is_not_a_canonical_one(self):
        # rippled rejects a non-canonical key at preflight, so a payment
        # carrying one can never settle. The blob is otherwise well formed and
        # re-encodes canonically, so nothing before this check catches it.
        wallet = make_wallet()
        requirements = make_requirements()
        tx = binarycodec.decode(sign_payment(wallet))
        tx["SigningPubKey"] = "04" + "A" * 64
        blob = binarycodec.encode(tx)

        assert verify_signed_blob(blob) is False
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_signing_pub_key"
        )

    def test_rejects_a_blob_whose_only_fault_is_its_signature(self):
        # Corrupting a blob's trailing bytes changes a *field*, so the structural
        # checks reject it and signature verification is never exercised. Here
        # every field is intact and only TxnSignature is swapped for another
        # account's, so nothing but the signature check can catch it.
        wallet = make_wallet()
        impostor = make_wallet()
        requirements = make_requirements()

        genuine = binarycodec.decode(sign_payment(wallet))
        other = binarycodec.decode(sign_payment(impostor))
        genuine["TxnSignature"] = other["TxnSignature"]
        forged = binarycodec.encode(genuine)

        result = _scheme().verify(make_payload(forged, requirements), requirements)
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_exact_xrpl_payload_signature"

    def test_rejects_a_missing_payload(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        payload.payload = {}
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload"
        )

    def test_rejects_a_non_hex_blob(self):
        requirements = make_requirements()
        payload = make_payload("nothex", requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_blob"
        )

    def test_accepts_a_key_delegated_as_the_accounts_regular_key(self):
        # Account is the payer; the blob is signed by a different key that the
        # ledger reports as that account's regular key.
        payer = make_wallet()
        signer = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(signer, account=payer.address)
        payload = make_payload(blob, requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(regular_key=signer.address))
        result = scheme.verify(payload, requirements)
        assert result.is_valid is True
        assert result.payer == payer.address

    def test_rejects_a_key_that_is_not_the_accounts_regular_key(self):
        payer = make_wallet()
        signer = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(signer, account=payer.address)
        payload = make_payload(blob, requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(regular_key=make_wallet().address))
        assert scheme.verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_signer_not_authorized"
        )


class TestStructure:
    def test_rejects_a_wrong_destination(self):
        wallet = make_wallet()
        requirements = make_requirements()
        elsewhere = make_wallet().address
        payload = make_payload(sign_payment(wallet, destination=elsewhere), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_destination_mismatch"
        )

    def test_rejects_an_amount_that_does_not_match(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, amount="999"), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_amount_mismatch"
        )

    def test_rejects_an_issued_currency_when_xrp_is_required(self):
        wallet = make_wallet()
        requirements = make_requirements()
        iou = {"currency": "USD", "issuer": MERCHANT, "value": "1"}
        payload = make_payload(sign_payment(wallet, amount=iou), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_amount_xrp"
        )

    def test_rejects_a_partial_payment(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, flags=0x00020000), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_partial_payment_not_allowed"
        )

    def test_rejects_a_fee_above_the_ceiling(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, fee="99999999"), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_fee_too_high"
        )

    def test_rejects_a_signed_network_id_on_a_standard_network(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, network_id=1), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_network_id_for_standard_network"
        )

    def test_requires_the_destination_tag_when_one_is_demanded(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": 12345}
        )
        blob = sign_payment(wallet)  # no tag
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_destination_tag_mismatch"
        )

    def test_rejects_the_wrong_destination_tag(self):
        # The payment reaches the institution either way; the tag decides which
        # customer is credited.
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": 12345}
        )
        blob = sign_payment(wallet, destination_tag=99999)
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_destination_tag_mismatch"
        )

    def test_accepts_the_required_destination_tag(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": 12345}
        )
        blob = sign_payment(wallet, destination_tag=12345)
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is True, result.invalid_reason

    def test_an_unrequired_tag_is_harmless(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet, destination_tag=7)
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is True, result.invalid_reason

    def test_rejects_a_mismatched_invoice(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "invoiceId": INVOICE_ID}
        )
        payload = make_payload(sign_payment(wallet, invoice_id="different"), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_invoice_id_mismatch"
        )


class TestExpiry:
    def test_rejects_a_missing_last_ledger_sequence(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, last_ledger_sequence=None), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_lastledgersequence_missing"
        )

    def test_rejects_an_already_expired_transaction(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(
            sign_payment(wallet, last_ledger_sequence=CURRENT_LEDGER - 1), requirements
        )
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_expired"
        )

    def test_rejects_an_expiry_far_beyond_the_timeout(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(
            sign_payment(wallet, last_ledger_sequence=CURRENT_LEDGER + 10_000), requirements
        )
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_lastledgersequence_too_large"
        )


class TestSequencing:
    def test_rejects_a_sequence_that_does_not_match_the_account(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, sequence=99), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_sequence_not_current"
        )

    def test_rejects_a_ticket_under_the_sequence_method(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, ticket_sequence=42), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_ticket_sequence_not_allowed"
        )

    def test_accepts_a_ticket_under_the_ticket_method(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        payload = make_payload(sign_payment(wallet, ticket_sequence=42), requirements)
        assert _scheme().verify(payload, requirements).is_valid is True

    def test_rejects_a_ticket_that_is_already_spent(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        payload = make_payload(sign_payment(wallet, ticket_sequence=42), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(ticket_available=False))
        assert scheme.verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_ticket_not_available"
        )


class TestSettlement:
    def test_settles_a_valid_payment(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet)
        result = _scheme().settle(make_payload(blob, requirements), requirements)
        assert result.success is True
        # The reported id is the blob's own hash, not whatever a node said.
        assert result.transaction == get_signed_transaction_hash(blob)

    def test_refuses_to_settle_an_invalid_payment(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet, amount="999"), requirements)
        result = _scheme().settle(payload, requirements)
        assert result.success is False
        assert result.error_reason == "invalid_exact_xrpl_payload_amount_mismatch"

    def test_rejects_a_duplicate_settlement(self):
        # Submission is idempotent on the transaction hash, so without a guard
        # a client could obtain the resource repeatedly for one payment.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = _scheme()
        assert scheme.settle(payload, requirements).success is True
        second = scheme.settle(payload, requirements)
        assert second.success is False
        assert second.error_reason == "duplicate_settlement"

    def test_reports_a_ledger_rejection(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(settlement_code="tecUNFUNDED_PAYMENT"))
        result = scheme.settle(payload, requirements)
        assert result.success is False
        assert result.error_reason == "transaction_failed: tecUNFUNDED_PAYMENT"

    def test_a_shared_cache_blocks_duplicates_across_scheme_instances(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        cache = SettlementCache()
        first = ExactXrplFacilitatorScheme(make_options(), cache)
        second = ExactXrplFacilitatorScheme(make_options(), cache)
        assert first.settle(payload, requirements).success is True
        assert second.settle(payload, requirements).error_reason == "duplicate_settlement"

    def test_any_object_with_is_duplicate_can_be_the_guard(self):
        # The spec requires deduplication across every process serving
        # /settle, so the shared-store deployment shape must not require
        # subclassing the in-process cache: the constructor takes anything
        # satisfying SettlementCacheLike.
        class RecordingGuard:
            def __init__(self) -> None:
                self.calls: list[tuple[str, float]] = []

            def is_duplicate(self, key: str, ttl_seconds: float) -> bool:
                self.calls.append((key, ttl_seconds))
                return len(self.calls) > 1

        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet)
        payload = make_payload(blob, requirements)
        guard = RecordingGuard()
        scheme = ExactXrplFacilitatorScheme(make_options(), guard)

        assert scheme.settle(payload, requirements).success is True
        assert scheme.settle(payload, requirements).error_reason == "duplicate_settlement"
        # The guard receives the identity and the retention the spec derives:
        # the blob's own hash, held past the payment's validity window.
        assert guard.calls[0] == (
            get_signed_transaction_hash(blob),
            requirements.max_timeout_seconds + DEFAULT_SETTLEMENT_TTL_SECONDS,
        )

    def test_an_empty_shared_guard_is_not_discarded_for_being_falsy(self):
        # A store may define emptiness, and an empty store is falsy; `or`
        # would silently replace it with a fresh per-process cache, splitting
        # the deduplication the caller wired up to be shared.
        class SizedGuard:
            def __len__(self) -> int:
                return 0

            def is_duplicate(self, key: str, ttl_seconds: float) -> bool:
                return False

        guard = SizedGuard()
        assert ExactXrplFacilitatorScheme(make_options(), guard).settlement_cache is guard


USD = "USD"
ISSUER = "rLNaPoKeeBjZe2qs6x52yVPZpZ8td4dc6w"


def _iou(value: str, issuer: str = ISSUER, currency: str = USD) -> dict[str, str]:
    return {"currency": currency, "issuer": issuer, "value": value}


def _iou_requirements(amount: str = "1.5"):
    return make_requirements(
        asset=USD,
        amount=amount,
        extra={"assetTransferMethod": "sequence", "issuer": ISSUER},
    )


class TestIssuedCurrency:
    def test_accepts_an_amount_that_is_decimally_equal(self):
        # XRPL normalises "1.50" to "1.5", so a string comparison would reject a
        # payment for exactly the requested amount.
        wallet = make_wallet()
        requirements = _iou_requirements("1.50")
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.5"))
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is True, result.invalid_reason

    def test_rejects_a_different_amount(self):
        wallet = make_wallet()
        requirements = _iou_requirements("1.5")
        blob = sign_payment(wallet, amount=_iou("1.6"), send_max=_iou("1.6"))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_iou_value_mismatch"
        )

    def test_requires_send_max(self):
        # Without SendMax the payment can take a cross-currency path.
        wallet = make_wallet()
        requirements = _iou_requirements()
        blob = sign_payment(wallet, amount=_iou("1.5"))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_sendmax_required"
        )

    def test_allows_send_max_above_amount_for_transfer_fees(self):
        wallet = make_wallet()
        requirements = _iou_requirements()
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.6"))
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is True, result.invalid_reason

    def test_rejects_send_max_below_amount(self):
        wallet = make_wallet()
        requirements = _iou_requirements()
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.4"))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_sendmax_too_low"
        )

    def test_rejects_send_max_in_a_different_currency(self):
        wallet = make_wallet()
        requirements = _iou_requirements()
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.5", currency="EUR"))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_sendmax_iou_mismatch"
        )

    def test_requires_a_matching_issuer(self):
        wallet = make_wallet()
        requirements = _iou_requirements()
        other = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"
        blob = sign_payment(
            wallet, amount=_iou("1.5", issuer=other), send_max=_iou("1.5", issuer=other)
        )
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_iou_issuer_mismatch"
        )


class TestCrossCurrencyPaths:
    def test_rejects_a_payment_carrying_paths(self):
        # Paths permit delivery in an asset other than the one required. xrpl-py
        # refuses to build an XRP payment with paths at all, so the realistic
        # vector is an issued currency, and a hand-built blob could carry them
        # regardless of what a well-behaved client would produce.
        wallet = make_wallet()
        requirements = _iou_requirements()
        blob = sign_payment(
            wallet,
            amount=_iou("1.5"),
            send_max=_iou("1.5"),
            paths=[[{"currency": "EUR", "issuer": ISSUER}]],
        )
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_paths_not_allowed"
        )


class TestValidatedSettlement:
    def test_refuses_to_report_success_on_an_unvalidated_submission(self):
        # Submission returns a provisional result. Treating it as final would
        # release the resource for a payment that may never land.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(settled=False))
        result = scheme.settle(payload, requirements)
        assert result.success is False
        assert result.error_reason == "transaction_not_validated: tesSUCCESS"


class TestAcceptedTermsMustMatchRequirements:
    """The payload restates the terms it is paying. A client that restates
    different terms would otherwise be judged against its own."""

    def _mismatch(self, field: str, value):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        setattr(payload.accepted, field, value)
        return _scheme().verify(payload, requirements).invalid_reason

    def test_rejects_a_different_asset(self):
        assert self._mismatch("asset", "USD") == "invalid_exact_xrpl_asset_mismatch"

    def test_rejects_a_different_amount(self):
        assert self._mismatch("amount", "1") == "invalid_exact_xrpl_amount_mismatch"

    def test_rejects_a_different_recipient(self):
        other = make_wallet().address
        assert self._mismatch("pay_to", other) == "invalid_exact_xrpl_pay_to_mismatch"

    def test_rejects_a_different_timeout(self):
        assert self._mismatch("max_timeout_seconds", 9999) == (
            "invalid_exact_xrpl_max_timeout_mismatch"
        )

    def test_rejects_a_different_invoice(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "invoiceId": INVOICE_ID}
        )
        payload = make_payload(
            sign_payment(wallet, invoice_id=INVOICE_ID),
            requirements,
            accepted_extra={"assetTransferMethod": "sequence", "invoiceId": "other"},
        )
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_invoice_mismatch"
        )

    def test_rejects_a_claim_that_fees_are_sponsored(self):
        # The payer funds the fee inside the signed transaction, always.
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "areFeesSponsored": True}
        )
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_fees_sponsored_unsupported"
        )


class TestForbiddenTransactionShapes:
    def test_rejects_a_multisigned_transaction(self):
        # No single SigningPubKey to bind to the account.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet)
        decoded = binarycodec.decode(blob)
        decoded["Signers"] = [
            {
                "Signer": {
                    "Account": make_wallet().address,
                    "SigningPubKey": "ED" + "A" * 64,
                    "TxnSignature": "AB" * 32,
                }
            }
        ]
        payload = make_payload(binarycodec.encode(decoded), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_multisig_not_supported"
        )

    def test_rejects_a_delegated_transaction(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet, delegate=make_wallet().address)
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_delegate_not_allowed"
        )

    def test_rejects_memos(self):
        # Unbounded payer-controlled data, and not the invoice binding
        # mechanism the spec requires.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet, memos=[{"memo": {"memo_data": "68656C6C6F"}}])
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_memos_not_allowed"
        )

    def test_rejects_send_max_on_an_xrp_payment(self):
        # xrpl-py will not build this, but a hostile client need not use it.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(wallet, base_fields(wallet, SendMax="2000"))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_sendmax_not_allowed"
        )


class TestSimulation:
    def test_refuses_a_payment_that_would_fail_on_ledger(self):
        # Nothing static reveals an unfunded payer. Without simulation the
        # resource server does the work, then settlement fails.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(simulation="tecUNFUNDED_PAYMENT"))
        assert scheme.verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_simulation_failed: tecUNFUNDED_PAYMENT"
        )

    def test_a_deployment_that_accepts_the_risk_can_inject_a_stub(self):
        # There is deliberately no off switch: the scheme requires verification
        # to check the payment would currently succeed. Opting out is done the
        # same way as any other transport choice: by injection.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        options = make_options()
        options.simulate_signed_transaction = lambda _blob, _net: "tesSUCCESS"
        assert ExactXrplFacilitatorScheme(options).verify(payload, requirements).is_valid is True


class TestIssuedCurrencyAmountShape:
    def test_rejects_drops_where_an_issued_amount_is_required(self):
        wallet = make_wallet()
        requirements = _iou_requirements()
        blob = sign_payment(wallet, amount="1000")
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_iou_amount"
        )

    def test_rejects_a_different_currency_code(self):
        wallet = make_wallet()
        requirements = _iou_requirements()
        blob = sign_payment(wallet, amount={"currency": "EUR", "issuer": ISSUER, "value": "1.5"})
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_iou_currency_mismatch"
        )

    def test_a_requirement_written_in_the_hex_form_of_a_standard_code_is_payable(self):
        # The spec lists both spellings, and the codec normalises the 160-bit
        # form of a three-character code back to the ISO code when decoding --
        # so comparing the spellings directly would make "USD written as hex"
        # unpayable while "USD" works.
        wallet = make_wallet()
        hex_usd = "0000000000000000000000005553440000000000"
        requirements = make_requirements(
            asset=hex_usd,
            amount="1.5",
            extra={"assetTransferMethod": "sequence", "issuer": ISSUER},
        )
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.5"))
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is True, result.invalid_reason

    def test_a_currency_that_only_looks_like_usd_cannot_be_paid_with_usd(self):
        # The codec reads a 3-character code out of bytes 12-14 and ignores
        # bytes 15-19, but the ledger keys separate trust lines on all 20 --
        # so normalising alone would let plain USD satisfy a requirement for a
        # different token whose tail bytes happen to differ. No decoded blob
        # can name this token unambiguously, so the requirements are at fault,
        # never the payment.
        wallet = make_wallet()
        requirements = make_requirements(
            asset="0000000000000000000000005553440000000001",
            amount="1.5",
            extra={"assetTransferMethod": "sequence", "issuer": ISSUER},
        )
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.5"))
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.invalid_reason == "invalid_exact_xrpl_facilitator_error"
        assert result.invalid_message and "requirements.asset" in result.invalid_message

    def test_a_currency_code_the_ledger_cannot_express_is_a_requirements_fault(self):
        # No payment can satisfy such a requirement, so the payload is not to
        # blame; the TypeScript facilitator throws for the same input.
        wallet = make_wallet()
        requirements = make_requirements(
            asset="TOOLONG",
            amount="1.5",
            extra={"assetTransferMethod": "sequence", "issuer": ISSUER},
        )
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.5"))
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.invalid_reason == "invalid_exact_xrpl_facilitator_error"
        assert result.invalid_message and "requirements.asset" in result.invalid_message

    def test_an_unparseable_value_is_rejected_rather_than_raised(self):
        # Unreachable through a blob (the binary codec refuses to encode such
        # a value), so the guard is checked directly rather than left unproven.
        assert _decimal("1.5e") is None
        assert _decimal(None) is None
        assert _decimal(Decimal("1.5")) is None


class TestTimeoutIsBoundedByPolicy:
    """The expiry window and the duplicate guard's retention are both derived
    from maxTimeoutSeconds, so an unbounded one lets whoever wrote the
    requirements decide how long a signed blob stays replayable and how long
    the facilitator must remember it."""

    def test_a_timeout_beyond_the_facilitator_policy_is_refused(self):
        wallet = make_wallet()
        requirements = make_requirements(max_timeout_seconds=10**9)
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_max_timeout_too_large"
        )

    def test_the_ceiling_is_configurable(self):
        wallet = make_wallet()
        requirements = make_requirements(max_timeout_seconds=7200)
        payload = make_payload(sign_payment(wallet), requirements)
        options = make_options()
        options.max_timeout_seconds = 7200
        assert ExactXrplFacilitatorScheme(options).verify(payload, requirements).is_valid is True

    def test_a_negative_timeout_is_refused(self):
        wallet = make_wallet()
        requirements = make_requirements(max_timeout_seconds=-1)
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_max_timeout_invalid"
        )


class TestRemainingEnvelopeChecks:
    def test_rejects_an_unsupported_protocol_version(self):
        requirements = make_requirements()
        payload = make_payload(sign_payment(make_wallet()), requirements)
        payload.x402_version = 1
        assert _scheme().verify(payload, requirements).invalid_reason == "invalid_x402_version"

    def test_rejects_a_different_destination_tag(self):
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": 42}
        )
        payload = make_payload(
            sign_payment(wallet, destination_tag=42),
            requirements,
            accepted_extra={"assetTransferMethod": "sequence", "destinationTag": 43},
        )
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_destination_tag_mismatch"
        )

    def test_rejects_a_different_issuer(self):
        wallet = make_wallet()
        requirements = _iou_requirements()
        payload = make_payload(
            sign_payment(wallet, amount={"currency": "USD", "issuer": ISSUER, "value": "1.5"}),
            requirements,
            accepted_extra={"assetTransferMethod": "sequence", "issuer": MERCHANT},
        )
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_iou_issuer_mismatch"
        )


class TestNonPaymentTransactions:
    def test_rejects_a_transaction_that_is_not_a_payment(self):
        # Signature-valid, but an AccountSet moves no funds.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(
            wallet,
            {
                "TransactionType": "AccountSet",
                "Account": wallet.address,
                "Fee": "12",
                "Flags": 0,
                "Sequence": 7,
            },
        )
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_transaction_type"
        )

    def test_rejects_deliver_min(self):
        # DeliverMin only has meaning alongside a partial payment.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(wallet, base_fields(wallet, DeliverMin="1"))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_delivermin_not_allowed"
        )

    def test_deliver_min_wins_over_the_partial_payment_flag(self):
        # On the ledger DeliverMin requires tfPartialPayment, so a real
        # DeliverMin transaction carries both faults. The TypeScript test
        # suite pins the DeliverMin code for that compound; answering with the
        # flag code instead would give a client different reasons for the
        # same blob depending on which facilitator it hit.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(wallet, base_fields(wallet, DeliverMin="1", Flags=0x00020000))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_delivermin_not_allowed"
        )


class TestSequenceAndTicketShape:
    def test_a_ticket_payment_must_zero_its_sequence(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        blob = sign_raw(wallet, base_fields(wallet, Sequence=7, TicketSequence=5))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_sequence_must_be_zero"
        )

    def test_a_ticket_payment_must_name_a_ticket(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        blob = sign_raw(wallet, base_fields(wallet, Sequence=0))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_ticket_sequence_missing"
        )

    def test_a_sequence_payment_must_carry_a_positive_sequence(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_raw(wallet, base_fields(wallet, Sequence=0))
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_sequence_missing"
        )


class TestNetworkIdRule:
    """XRPL requires a signed NetworkID only above 1024, which binds a payment
    to one chain. The three well-known networks are all below the ceiling; a
    private network or sidechain is where the rule bites. The accept case and
    the standard-network rejection are proven elsewhere through the public
    round trip; these are the remaining rejections, also via the public path."""

    HIGH_ID = "xrpl:2000"

    def test_a_network_id_for_another_chain_is_rejected(self):
        # Without this, a payment signed for one high-id chain replays on another.
        wallet = make_wallet()
        requirements = make_requirements(network=self.HIGH_ID)
        blob = sign_payment(wallet, network_id=1999)
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_network_id_mismatch"
        )

    def test_an_absent_network_id_is_rejected(self):
        wallet = make_wallet()
        requirements = make_requirements(network=self.HIGH_ID)
        blob = sign_payment(wallet)
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_network_id_mismatch"
        )


class TestUnsatisfiableRequirements:
    """Requirements the payer could not have satisfied are the server's fault,
    not the payer's, and must be reported as such rather than blamed on the
    transaction."""

    def test_an_xrp_amount_no_payment_can_match_is_a_requirements_fault(self):
        # "1000.0" is not a drops amount, so every payment would otherwise be
        # answered with amount_mismatch while the fault is the requirements'.
        wallet = make_wallet()
        requirements = make_requirements(amount="1000.0")
        payload = make_payload(sign_payment(wallet), requirements)
        result = _scheme().verify(payload, requirements)
        assert result.invalid_reason == "invalid_exact_xrpl_facilitator_error"
        assert result.invalid_message and "requirements.amount" in result.invalid_message

    def test_an_issued_currency_without_an_issuer_is_rejected(self):
        # "USD" alone names no asset: the payer cannot know whose USD.
        wallet = make_wallet()
        requirements = make_requirements(
            asset="USD", amount="1.5", extra={"assetTransferMethod": "sequence"}
        )
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_iou_issuer_missing"
        )

    def test_an_issuer_that_is_not_an_address_is_rejected(self):
        wallet = make_wallet()
        requirements = make_requirements(
            asset="USD",
            amount="1.5",
            extra={"assetTransferMethod": "sequence", "issuer": "not-an-address"},
        )
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_iou_issuer_missing"
        )

    @pytest.mark.parametrize("tag", [-1, 2**32, 1.5, True, "7"])
    def test_a_destination_tag_the_ledger_cannot_hold_is_rejected(self, tag):
        # DestinationTag is a uint32. Comparing against an unrepresentable
        # value would reject every payment and blame the payer for it.
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "destinationTag": tag}
        )
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_destination_tag_malformed"
        )

    def test_an_empty_invoice_id_is_rejected(self):
        wallet = make_wallet()
        requirements = make_requirements(extra={"assetTransferMethod": "sequence", "invoiceId": ""})
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_invoice_missing"
        )


class TestMissingRequiredFields:
    def test_a_payment_that_omits_a_required_invoice_is_rejected(self):
        # Distinguished from committing to the wrong invoice: the transaction
        # is not bound to any invoice at all.
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence", "invoiceId": INVOICE_ID}
        )
        payload = make_payload(sign_payment(wallet), requirements)
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_invoice_missing"
        )

    def test_a_payment_carrying_no_fee_is_rejected(self):
        wallet = make_wallet()
        requirements = make_requirements()
        fields = base_fields(wallet)
        del fields["Fee"]
        blob = sign_raw(wallet, fields)
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_fee_missing"
        )


class TestSettlementGuardUsesAClockThatCannotStep:
    def test_retention_is_measured_on_the_monotonic_clock(self, monkeypatch):
        # Retention is a duration, so a wall-clock jump forward (a VM
        # snapshot restore, a container's first NTP sync) must not evict an
        # entry whose transaction can still land, which would silently reopen
        # the replay window.
        # The module's own `time` reference is replaced, not the attributes of
        # the stdlib module: patching those freezes the clock for pytest and
        # every library in the process, which surfaces as an unrelated test
        # failing at random.
        class FrozenClock:
            def __init__(self) -> None:
                self.monotonic_seconds = 1_000.0
                self.wall_seconds = 1_000.0

            def monotonic(self) -> float:
                return self.monotonic_seconds

            def time(self) -> float:
                return self.wall_seconds

        clock = FrozenClock()
        monkeypatch.setattr(settlement_cache_module, "time", clock)
        cache = SettlementCache()

        assert cache.is_duplicate("TX", 3720.0) is False
        # The wall clock jumps two hours; the monotonic clock does not.
        clock.wall_seconds += 7200.0
        assert cache.is_duplicate("TX", 3720.0) is True


class TestCrossImplementationAgreement:
    """Facts the TypeScript mechanism also depends on. A payment is built by one
    implementation's client and judged by whichever facilitator the resource
    server runs, so these are not internal choices."""

    def test_the_expiry_bound_matches_the_typescript_formula(self):
        # ceil(maxTimeoutSeconds / 5) + 2. Deriving a different window is how a
        # client builds payments its own facilitator accepts and another
        # implementation's rejects as lastledgersequence_too_large.
        assert get_max_last_ledger_sequence(1000, 60) == 1000 + 12 + 2
        assert get_max_last_ledger_sequence(1000, 61) == 1000 + 13 + 2
        assert get_max_last_ledger_sequence(1000, 0) == 1000 + 0 + 2

    def test_the_client_builds_exactly_the_bound_the_facilitator_enforces(self):
        wallet = make_wallet()
        requirements = make_requirements()
        blob = ExactXrplClientScheme(wallet, make_client_options()).create_payment_payload(
            requirements
        )["signedTxBlob"]
        built = binarycodec.decode(blob)["LastLedgerSequence"]
        assert built == get_max_last_ledger_sequence(
            CURRENT_LEDGER, requirements.max_timeout_seconds
        )
        assert _scheme().verify(make_payload(blob, requirements), requirements).is_valid is True

    def test_one_ledger_beyond_the_bound_is_rejected(self):
        wallet = make_wallet()
        requirements = make_requirements()
        too_far = get_max_last_ledger_sequence(CURRENT_LEDGER, 60) + 1
        blob = sign_payment(wallet, last_ledger_sequence=too_far)
        assert _scheme().verify(make_payload(blob, requirements), requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_lastledgersequence_too_large"
        )

    def test_the_settlement_entry_outlives_the_payment_it_guards(self):
        # The retention handed to the guard must cover the transaction's
        # landable window plus the full margin: 120s of ledger-close variance
        # and clock skew, asserted literally so shrinking it cannot pass.
        # Evicting sooner lets a duplicate pass re-verification and settle
        # again.
        recorded: list[float] = []

        class RecordingCache(SettlementCache):
            def is_duplicate(self, key, ttl_seconds=DEFAULT_SETTLEMENT_TTL_SECONDS, now=None):
                recorded.append(ttl_seconds)
                return super().is_duplicate(key, ttl_seconds, now)

        wallet = make_wallet()
        requirements = make_requirements(max_timeout_seconds=60)
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(), settlement_cache=RecordingCache())
        assert scheme.settle(payload, requirements).success is True
        assert recorded == [60 + 120.0]


class TestIssuedCurrencyValueGrammar:
    """XRPL issued-currency values are plain decimals. Decimal() would also
    accept forms the ledger cannot hold, and NaN silently fails every
    comparison it takes part in, including the SendMax floor."""

    @pytest.mark.parametrize(
        "value", ["1e5", "1E5", "Infinity", "-Infinity", "NaN", "+1.5", ".5", "1.", "0x10", ""]
    )
    def test_values_the_ledger_cannot_hold_are_rejected(self, value):
        assert _decimal(value) is None

    @pytest.mark.parametrize("value", ["0", "1", "1.5", "1.50", "0.000001", "100000000000"])
    def test_plain_decimals_are_accepted(self, value):
        assert _decimal(value) == Decimal(value)

    def test_a_nan_requirement_is_a_requirements_fault_not_a_payload_one(self):
        # NaN also silently fails every comparison, so answering "mismatch"
        # would be an accident of the operator used.
        wallet = make_wallet()
        requirements = _iou_requirements("NaN")
        blob = sign_payment(wallet, amount=_iou("1.5"), send_max=_iou("1.5"))
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.invalid_reason == "invalid_exact_xrpl_facilitator_error"
        assert result.invalid_message and "requirements.amount" in result.invalid_message


class TestLegacyRegularKeyEqualToAccount:
    """rippled resolves the regular key before the master key. An account whose
    RegularKey is its own address can no longer be created (the ledger answers
    temBAD_REGKEY), but accounts configured before fixMasterKeyAsRegularKey
    activated still hold that state, and the ledger still honours it."""

    def test_the_master_key_pair_is_authorised_as_the_regular_key(self):
        # Checking the master key first would refuse a payment the ledger
        # accepts, because the master key is disabled.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(
            make_options(regular_key=wallet.address, master_key_disabled=True)
        )
        result = scheme.verify(payload, requirements)
        assert result.is_valid is True, result.invalid_reason
        assert result.payer == wallet.address

    def test_a_disabled_master_key_alone_is_still_refused(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(master_key_disabled=True))
        assert scheme.verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_payload_master_key_disabled"
        )


class TestFeeSponsorshipMustBeDeclared:
    """The field is how a payer acknowledges it funds the fee. The TypeScript
    client refuses requirements that omit it, so accepting the omission here
    would make the two implementations disagree about the same requirements."""

    def test_requirements_that_omit_it_are_rejected(self):
        # The accepted terms declare it, so only the requirements side can be
        # what rejects this; otherwise the other check would mask it.
        wallet = make_wallet()
        requirements = make_requirements(
            extra={"assetTransferMethod": "sequence"}, fees_sponsored=None
        )
        payload = make_payload(sign_payment(wallet), requirements)
        payload.accepted.extra = {"assetTransferMethod": "sequence", "areFeesSponsored": False}
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_fees_sponsored_unsupported"
        )

    def test_requirements_claiming_sponsored_fees_are_rejected(self):
        wallet = make_wallet()
        requirements = make_requirements(fees_sponsored=True)
        payload = make_payload(sign_payment(wallet), requirements)
        payload.accepted.extra = {"assetTransferMethod": "sequence", "areFeesSponsored": False}
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_fees_sponsored_unsupported"
        )

    def test_accepted_terms_that_omit_it_are_rejected(self):
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        payload.accepted.extra = {"assetTransferMethod": "sequence"}
        assert _scheme().verify(payload, requirements).invalid_reason == (
            "invalid_exact_xrpl_fees_sponsored_unsupported"
        )


class TestSettlementFailuresCarryDetail:
    """Settlement failures are the ones an operator has to act on, so they
    carry the same reason-stable-detail-in-message contract as verification.
    The EVM and TypeScript mechanisms both populate the message field here."""

    def test_a_failed_verification_keeps_its_message_through_settle(self):
        # verify() puts the detail of an unexpected failure in invalid_message;
        # settle() reporting the same fault must not drop it.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        options = make_options()

        def boom(_account, _net):
            raise ConnectionError("node unreachable")

        options.get_account_sequence = boom
        result = ExactXrplFacilitatorScheme(options).settle(payload, requirements)

        assert result.success is False
        assert result.error_reason == "invalid_exact_xrpl_facilitator_error"
        assert result.error_message and "node unreachable" in result.error_message

    def test_a_submission_failure_reports_the_payer_and_the_detail(self):
        # The payer is known once verification passes, and the exception is the
        # only clue to what went wrong. A bare "transaction_failed" with no
        # payer leaves a node outage indistinguishable from a ledger rejection.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        options = make_options()

        def down(_blob, _net):
            raise ConnectionError("submit refused")

        options.submit_signed_transaction = down
        blob = payload.payload["signedTxBlob"]
        result = ExactXrplFacilitatorScheme(options).settle(payload, requirements)

        assert result.success is False
        assert result.error_reason == "transaction_failed"
        assert result.payer == wallet.address
        assert result.error_message and "submit refused" in result.error_message
        # The transaction id was computed before submission, so the failure
        # report names the transaction it concerns.
        assert result.transaction == get_signed_transaction_hash(blob)


class TestVerifyIsTotal:
    """Nothing a client can send may crash the facilitator: every input yields
    a response with a reason, never an exception."""

    @pytest.mark.parametrize(
        "payload_dict",
        [
            {},
            {"signedTxBlob": None},
            {"signedTxBlob": 7},
            {"signedTxBlob": ""},
            {"signedTxBlob": "   "},
            {"signedTxBlob": ["12"]},
            {"signedTxBlob": {"nested": "00"}},
            {"unexpected": {"deep": [None, {"deeper": 1.5}]}},
        ],
    )
    def test_arbitrary_payloads_yield_a_response_rather_than_an_exception(self, payload_dict):
        requirements = make_requirements()
        payload = make_payload("00", requirements)
        payload.payload = payload_dict
        result = _scheme().verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason

    @pytest.mark.parametrize("blob", ["00", "FF" * 40, "1200", "not-hex", "ABC", "٣٣"])
    def test_junk_blobs_are_rejected_not_raised(self, blob):
        requirements = make_requirements()
        result = _scheme().verify(make_payload(blob, requirements), requirements)
        assert result.is_valid is False
        assert result.invalid_reason

    @pytest.mark.parametrize("amount", ["", "NaN", "1e5", "-1", "0x10", "١٢٣"])
    def test_junk_required_amounts_are_rejected_not_raised(self, amount):
        requirements = make_requirements(amount=amount)
        result = _scheme().verify(make_payload("00", requirements), requirements)
        assert result.is_valid is False
        assert result.invalid_reason


class TestUnexpectedFailuresCarryDetail:
    def test_the_reason_stays_stable_and_the_detail_goes_in_the_message(self):
        # A caller matches on the reason; an operator needs the detail. Folding
        # the detail into the reason would give every failure a distinct code.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        options = make_options()

        def boom(_account, _net):
            raise ConnectionError("node unreachable")

        options.get_account_sequence = boom
        result = ExactXrplFacilitatorScheme(options).verify(payload, requirements)

        assert result.invalid_reason == "invalid_exact_xrpl_facilitator_error"
        assert result.invalid_message
        assert "node unreachable" in result.invalid_message

    def test_a_misconfigured_fee_ceiling_is_a_facilitator_fault_not_a_payer_one(self):
        # An unparseable max_fee_drops would otherwise reject every payment
        # with fee_too_high, blaming the payer for the operator's typo.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        options = make_options()
        options.max_fee_drops = "ten thousand"

        result = ExactXrplFacilitatorScheme(options).verify(payload, requirements)

        assert result.invalid_reason == "invalid_exact_xrpl_facilitator_error"
        assert result.invalid_message
        assert "max_fee_drops" in result.invalid_message


class TestANodeThatMisreportsTheTransaction:
    """A facilitator believes whatever its node says. Most lies can only cause
    a rejection, and the ledger refuses anything wrongly accepted at
    settlement. The transaction id is the exception: it is derivable from the
    blob, so it never has to be taken on trust."""

    def test_a_hash_for_a_different_transaction_is_refused(self):
        # Reporting success under someone else's transaction id would have the
        # resource server record that id as proof of this payment.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        scheme = ExactXrplFacilitatorScheme(make_options(settlement_hash="DE" * 32))
        result = scheme.settle(payload, requirements)
        assert result.success is False
        assert result.error_reason == "transaction_failed: hash_mismatch"

    def test_an_omitted_hash_does_not_settle_without_an_id(self):
        # No hostility needed: a node that simply omits it left the settlement
        # reporting success with an empty transaction id.
        wallet = make_wallet()
        requirements = make_requirements()
        blob = sign_payment(wallet)
        scheme = ExactXrplFacilitatorScheme(make_options(settlement_hash=""))
        result = scheme.settle(make_payload(blob, requirements), requirements)
        assert result.success is True
        assert result.transaction == get_signed_transaction_hash(blob)

    @pytest.mark.parametrize(
        ("label", "options"),
        [
            ("ledger index in the past", {"ledger_index": 1}),
            ("ledger index in the future", {"ledger_index": CURRENT_LEDGER + 10**6}),
            ("wrong account sequence", {"sequence": 999}),
            ("master key falsely disabled", {"master_key_disabled": True}),
        ],
    )
    def test_a_lying_read_can_only_cause_a_rejection(self, label, options):
        # These are the reads where a wrong answer is safe: it costs the payer
        # a retry, never the resource server a payment.
        wallet = make_wallet()
        requirements = make_requirements()
        payload = make_payload(sign_payment(wallet), requirements)
        result = ExactXrplFacilitatorScheme(make_options(**options)).verify(payload, requirements)
        assert result.is_valid is False, f"{label} produced an accept"
