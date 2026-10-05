"""Cross-language commitment, CIP-8 and blockchain identifier vectors."""

import hashlib

import pytest
from nacl.signing import SigningKey
from pycardano import Address, Network, VerificationKeyHash
from pycardano.cbor import cbor2

from x402.mechanisms.cardano.exact.masumi.cose import verify_seller_terms_signature
from x402.mechanisms.cardano.exact.masumi.digests import commitment_part_digest, compute_input_hash
from x402.mechanisms.cardano.exact.masumi.identifier import (
    decode_blockchain_identifier,
    encode_blockchain_identifier,
)
from x402.mechanisms.cardano.exact.masumi.jcs import jcs, jcs_bytes

ESCROW = "addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g"
VECTOR = "230d7c6574f41d1c0acc96ade8eae04360019f607004d8809c07d005c053019cae007700bce8058680d89818c04e44002c035931a2c00daf5e00ac9bf00b6c401b80473c6535d00e6003cb8b110199db615001ca8eecc6019b58076c603b13763a80"


def test_identifier_reference_vector():
    parts = {
        "sellerNonce": "11" * 32,
        "agentIdentifier": "",
        "buyerNonce": "",
        "referenceSignature": "55" * 16,
        "referenceKey": "a10101",
        "contractAddress": ESCROW,
    }
    assert encode_blockchain_identifier(parts) == VECTOR
    assert decode_blockchain_identifier(VECTOR) == parts
    for invalid in ["", "gg", VECTOR.upper(), VECTOR[:40], "00", "0000"]:
        assert decode_blockchain_identifier(invalid) is None


def test_canonical_json_and_commitment():
    assert jcs({"b": 1.0, "a": -0.0}) == '{"a":0,"b":1}'
    assert (
        commitment_part_digest({"canonicalization": "raw", "content": "aGVsbG8"})
        == hashlib.sha256(b"hello").hexdigest()
    )
    with pytest.raises(ValueError):
        commitment_part_digest({"canonicalization": "raw", "content": "aGVsbG8="})
    manifest = {
        "version": "1",
        "algorithm": "sha256",
        "parts": [
            {
                "name": "body",
                "canonicalization": "jcs",
                "digest": "11" * 32,
                "content": {"hello": "world"},
            }
        ],
    }
    digest = compute_input_hash(manifest)
    manifest["parts"][0]["content"] = None
    assert compute_input_hash(manifest) == digest
    manifest["parts"][0]["mediaType"] = "application/json"
    assert compute_input_hash(manifest) != digest


def signed_terms_vector():
    signer = SigningKey(bytes(range(32)))
    public = bytes(signer.verify_key)
    address = Address(
        VerificationKeyHash(hashlib.blake2b(public, digest_size=28).digest()),
        network=Network.TESTNET,
    )
    key = {1: 1, 3: -8, -1: 6, -2: public}
    protected = cbor2.dumps({1: -8, "address": bytes(address)})
    digest = bytes.fromhex("42" * 32)
    signature = signer.sign(cbor2.dumps(["Signature1", protected, b"", digest])).signature
    sign1 = [protected, {"hashed": False}, digest, signature]
    return key, sign1, str(address), digest.hex()


def test_cip8_signature_binds_key_address_and_payload():
    key, sign1, address, digest = signed_terms_vector()

    def verify():
        return verify_seller_terms_signature(
            cbor2.dumps(key).hex(), cbor2.dumps(sign1).hex(), address, digest
        )

    assert verify()
    sign1[1]["hashed"] = True
    assert not verify()
    sign1[1]["hashed"] = False
    key[-4] = bytes(32)
    assert not verify()
    del key[-4]
    sign1[2] = bytes(32)
    assert not verify()


@pytest.mark.parametrize("label,value", [(1, True), (1, 1.0), (3, -8.0), (-1, 6.0)])
def test_cose_numeric_parameters_require_integers(label, value):
    key, sign1, address, digest = signed_terms_vector()
    key[label] = value
    assert not verify_seller_terms_signature(
        cbor2.dumps(key).hex(), cbor2.dumps(sign1).hex(), address, digest
    )


@pytest.mark.parametrize(
    "number,expected",
    [
        (2**53, "9007199254740992"),
        (2**53 + 1, "9007199254740992"),
        (-(2**53 + 1), "-9007199254740992"),
        (10**20, "100000000000000000000"),
        (10**21, "1e+21"),
        (17976931348623157 * 10**292, "1.7976931348623157e+308"),
    ],
)
def test_typescript_json_number_vectors(number, expected):
    # TypeScript jcs(JSON.parse(decimal)) vectors, including IEEE-754 rounding.
    value = {"nested": [number], "amount": str(number), "flag": True}
    canonical = '{"amount":"' + str(number) + '","flag":true,"nested":[' + expected + "]}"
    assert jcs(value) == canonical
    assert jcs_bytes(value) == canonical.encode()


@pytest.mark.parametrize(
    "value", [float("inf"), float("nan"), 10**309, {1: "key"}, b"x", {1}, (1,)]
)
def test_jcs_rejects_non_json_values(value):
    with pytest.raises(ValueError):
        jcs(value)


def test_jcs_rejects_cycles_but_accepts_shared_containers():
    value = []
    value.append(value)
    with pytest.raises(ValueError):
        jcs(value)
    shared = {"n": 2**53}
    assert jcs([shared, shared]) == '[{"n":9007199254740992},{"n":9007199254740992}]'
