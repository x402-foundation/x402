"""Verify CIP-8 seller authorization over the exact Masumi terms digest."""

from hashlib import blake2b

from nacl.signing import VerifyKey
from pycardano import Address, VerificationKeyHash
from pycardano.cbor import cbor2

from ...limits import MAX_MASUMI_COSE_BYTES
from ...utils import decode_cbor


def verify_seller_terms_signature(
    reference_key_hex: str, reference_signature_hex: str, seller_address: str, terms_digest_hex: str
) -> bool:
    try:
        if max(len(reference_key_hex), len(reference_signature_hex)) > MAX_MASUMI_COSE_BYTES * 2:
            return False
        digest = bytes.fromhex(terms_digest_hex)
        if len(digest) != 32:
            return False
        key = decode_cbor(bytes.fromhex(reference_key_hex))
        if (
            not isinstance(key, dict)
            or any(type(label) not in (int, str) for label in key)
            or any(type(key.get(label)) is not int for label in (1, 3, -1))
            or key.get(1) != 1
            or key.get(3) != -8
            or key.get(-1) != 6
            or -4 in key
        ):
            return False
        public = key.get(-2)
        if not isinstance(public, bytes) or len(public) != 32:
            return False
        sign1 = decode_cbor(bytes.fromhex(reference_signature_hex))
        if isinstance(sign1, cbor2.CBORTag) and sign1.tag == 18:
            sign1 = sign1.value
        if not isinstance(sign1, (list, tuple)) or len(sign1) != 4:
            return False
        protected_bytes, unprotected, payload, signature = sign1
        if not isinstance(unprotected, dict) or unprotected.get("hashed") is not False:
            return False
        protected = decode_cbor(protected_bytes)
        address = Address.from_primitive(seller_address)
        if (
            not isinstance(protected, dict)
            or any(type(label) not in (int, str) for label in protected)
            or type(protected.get(1)) is not int
            or protected.get(1) != -8
            or protected.get("address") != bytes(address)
            or not isinstance(address.payment_part, VerificationKeyHash)
            or address.payment_part.payload != blake2b(public, digest_size=28).digest()
            or payload != digest
        ):
            return False
        if isinstance(key.get(2), bytes) and 4 in protected and key[2] != protected[4]:
            return False
        structure = cbor2.dumps(["Signature1", protected_bytes, b"", payload])
        VerifyKey(public).verify(structure, signature)
        return True
    except Exception:
        return False
