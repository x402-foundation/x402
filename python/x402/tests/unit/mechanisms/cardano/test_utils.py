"""Cardano wire and signed transaction checks."""

import base64
import hashlib

import pytest


@pytest.mark.parametrize(
    ("network", "canonical", "network_id"),
    [
        ("cardano:mainnet", "cardano:mainnet", 1),
        ("cip34:1-764824073", "cardano:mainnet", 1),
        ("cip34:0-1", "cardano:preprod", 0),
        ("cip34:0-2", "cardano:preview", 0),
    ],
)
def test_network_aliases(network, canonical, network_id):
    from x402.mechanisms.cardano.constants import (
        get_cardano_network_id,
        is_cardano_network,
        normalize_cardano_network,
    )

    assert normalize_cardano_network(network) == canonical
    assert get_cardano_network_id(network) == network_id
    assert is_cardano_network(network)
    assert not is_cardano_network("cardano:1")
    with pytest.raises(ValueError):
        get_cardano_network_id("cardano:1")


def test_default_assets_and_reverse_lookup():
    from x402.mechanisms.cardano.constants import USDM_MAINNET_ASSET, USDM_PREPROD_ASSET
    from x402.mechanisms.cardano.default_assets import find_default_asset, get_default_asset

    assert get_default_asset("cip34:0-1", "usdm") == {
        "asset": USDM_PREPROD_ASSET,
        "decimals": 6,
        "symbol": "USDM",
    }
    assert find_default_asset(USDM_MAINNET_ASSET.upper(), "cardano:mainnet")["decimals"] == 6
    assert find_default_asset("lovelace", "cardano:mainnet") is None
    with pytest.raises(ValueError):
        get_default_asset("cardano:preview")
    with pytest.raises(ValueError):
        get_default_asset("cardano:preprod", "ADA")


def test_asset_and_nonce_parsing():
    from x402.mechanisms.cardano.utils import parse_asset_unit, parse_utxo_ref

    assert parse_asset_unit("AB" * 28 + ".CD") == ("ab" * 28, "cd")
    assert parse_asset_unit("ab" * 28 + ".") == ("ab" * 28, "")
    assert parse_asset_unit("lovelace") == ("", "")
    assert parse_utxo_ref("AB" * 32 + "#12") == ("ab" * 32, 12)
    for asset in ("ADA", "lovelace\n", "ab" * 27 + ".", "ab" * 28 + "." + "00" * 33):
        with pytest.raises(ValueError):
            parse_asset_unit(asset)
    for nonce in ("ab" * 32 + "#-1", "ab" * 32 + "#0\n", "ab#0"):
        with pytest.raises(ValueError):
            parse_utxo_ref(nonce)


@pytest.mark.parametrize(
    "value",
    ["", "AA", "AA==\n", "AB==", "_w==", "!!!!", "A" * 100_000],
    ids=["empty", "padding", "newline", "pad-bits", "url-alphabet", "invalid", "oversize"],
)
def test_reject_noncanonical_base64(value):
    from x402.mechanisms.cardano.utils import decode_cardano_transaction_bytes

    with pytest.raises(ValueError):
        decode_cardano_transaction_bytes(value)


def test_payload_and_output_minimum():
    from x402.mechanisms.cardano.utils import decode_cardano_payload, min_utxo_lovelace

    payload = decode_cardano_payload({"transaction": "AA==", "nonce": "ab" * 32 + "#0"})
    assert payload.to_dict() == {"transaction": "AA==", "nonce": "ab" * 32 + "#0"}
    assert min_utxo_lovelace(200, 4310) == 1_551_600
    for raw in ({}, {"transaction": 123, "nonce": "a"}, {"transaction": "AA==", "nonce": 2}):
        with pytest.raises(ValueError):
            decode_cardano_payload(raw)


def test_decode_preserves_body_hash_and_verifies_witnesses():
    import cbor2
    from nacl.signing import SigningKey

    from x402.mechanisms.cardano.utils import decode_cardano_transaction

    key = SigningKey(bytes(range(32)))
    key_hash = hashlib.blake2b(bytes(key.verify_key), digest_size=28).digest()
    address = bytes([0x60]) + key_hash
    body = {0: [[bytes(32), 0]], 1: [{0: address, 1: 5_000_000}], 2: 200_000, 3: 1000}
    body_bytes = cbor2.dumps(body)
    # An indefinite body map has different signed bytes from a reconstructed map.
    body_bytes = b"\xbf" + body_bytes[1:] + b"\xff"
    body_hash = hashlib.blake2b(body_bytes, digest_size=32).digest()
    signature = key.sign(body_hash).signature
    witnesses = {0: [[bytes(key.verify_key), signature]]}
    tx = b"\x84" + body_bytes + cbor2.dumps(witnesses) + b"\xf5\xf6"
    decoded = decode_cardano_transaction(base64.b64encode(tx).decode())
    assert decoded.tx_hash == body_hash.hex()
    assert decoded.inputs == ["00" * 32 + "#0"]
    assert decoded.outputs[0].coin == 5_000_000
    assert decoded.vkey_hashes == [key_hash.hex()]
    assert decoded.vkey_witness_count == 1
    assert decoded.signatures_valid
    assert decoded.is_valid
    assert decoded.ttl_slot == 1000
    assert decoded.fee == 200_000
    assert decoded.size_bytes == len(tx)

    forged = bytearray(signature)
    forged[0] ^= 1
    forged_tx = (
        b"\x84"
        + body_bytes
        + cbor2.dumps({0: [[bytes(key.verify_key), bytes(forged)]]})
        + b"\xf5\xf6"
    )
    assert not decode_cardano_transaction(base64.b64encode(forged_tx).decode()).signatures_valid
    invalid_tx = b"\x84" + body_bytes + cbor2.dumps(witnesses) + b"\xf4\xf6"
    assert not decode_cardano_transaction(base64.b64encode(invalid_tx).decode()).is_valid


def test_reject_trailing_cbor_and_nontransaction():
    import cbor2

    from x402.mechanisms.cardano.utils import decode_cardano_transaction

    for raw in (cbor2.dumps({}), cbor2.dumps([{}, {}, True, None]) + b"\x00", b"\xff"):
        with pytest.raises(ValueError):
            decode_cardano_transaction(base64.b64encode(raw).decode())


def test_datum_hash_is_not_inline_and_reference_script_is_detected():
    from pycardano import (
        Address,
        DatumHash,
        Network,
        PlutusV3Script,
        Transaction,
        TransactionBody,
        TransactionOutput,
        TransactionWitnessSet,
        VerificationKeyHash,
    )

    from x402.mechanisms.cardano.utils import decode_cardano_transaction

    address = Address(VerificationKeyHash(bytes(28)), network=Network.TESTNET)
    output = TransactionOutput(
        address,
        5_000_000,
        datum_hash=DatumHash(bytes(32)),
        script=PlutusV3Script(bytes.fromhex("01000033222220051200120011")),
        post_alonzo=True,
    )
    tx = Transaction(
        TransactionBody(inputs=[], outputs=[output], fee=200_000), TransactionWitnessSet()
    )
    decoded = decode_cardano_transaction(base64.b64encode(tx.to_cbor()).decode())
    assert decoded.outputs[0].datum is None
    assert decoded.outputs[0].has_reference_script
