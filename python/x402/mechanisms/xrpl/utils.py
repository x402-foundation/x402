"""XRPL helpers shared by the client, server and facilitator scheme implementations."""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any, TypeGuard

from .constants import (
    ASSET_XRP,
    CANONICAL_SIGNING_PUB_KEY_PATTERN,
    DEFAULT_LEDGER_CLOSE_SECONDS,
    DEFAULT_LEDGER_TOLERANCE,
    MAX_DESTINATION_TAG,
    MAX_NETWORK_ID,
    TRANSACTION_ID_PREFIX,
)

try:
    from xrpl.core import addresscodec, binarycodec, keypairs
    from xrpl.core.binarycodec.definitions import get_field_instance
    from xrpl.core.binarycodec.types.currency import Currency
except ModuleNotFoundError as e:  # pragma: no cover - exercised only without the extra
    # Only claim the dependency is missing when it genuinely is: a blanket
    # catch would report shadowing and transitive failures as "install
    # xrpl-py".
    if (e.name or "").split(".")[0] != "xrpl":
        raise
    raise ImportError(
        "XRPL mechanism requires xrpl-py. Install with: pip install x402[xrpl]"
    ) from e

# These patterns guard trust-boundary values, so they anchor with \Z rather
# than $: Python's $ also matches before a trailing newline, and bytes.fromhex
# skips whitespace, so "<hex>\n" would verify here and be refused by rippled.

# Pairs of digits: an odd count cannot decode to bytes.
_HEX_RE = re.compile(r"\A(?:[0-9A-Fa-f]{2})+\Z")
_PUB_KEY_RE = re.compile(CANONICAL_SIGNING_PUB_KEY_PATTERN, re.IGNORECASE)
# ASCII digits only; str.isdigit() also accepts numeric forms int() refuses.
_DROPS_RE = re.compile(r"\A[0-9]+\Z")
# Any xrpl:<uint32>, not an allowlist: private networks and sidechains are
# legitimate targets given an endpoint override.
_NETWORK_RE = re.compile(r"\Axrpl:(0|[1-9][0-9]*)\Z")
# Plain non-negative decimals; Decimal() would also accept "1e5", "Infinity"
# and "NaN", none of which the ledger can hold.
_DECIMAL_RE = re.compile(r"\A[0-9]+(\.[0-9]+)?\Z")
# A money price, once the currency marks are stripped, shares that grammar.
_MONEY_RE = _DECIMAL_RE

# Group orders, for rejecting the malleable half of the signature space.
_SECP256K1_GROUP_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_ED25519_GROUP_ORDER = 2**252 + 27742317777372353535851937790883648493

# Decoding is super-linear in field count, so an unbounded blob is free CPU
# for an unauthenticated client. A conforming Payment is a few hundred bytes;
# the ceiling is an order of magnitude above any real transaction.
MAX_SIGNED_TX_BLOB_HEX = 4096

# The non-signing fields a single-signed Payment may legitimately carry; any
# other non-signing field would only serve to change the transaction hash.
ALLOWED_NON_SIGNING_FIELDS = frozenset({"TxnSignature", "Signers"})

# Every field rippled's Payment template accepts today. The codec is
# type-agnostic — it happily decodes any field it knows onto any transaction —
# and it classifies fields the moment a release teaches it new ones, so
# "reject what the codec calls non-signing" silently starts accepting fields
# added by future amendments (XLS-68 Sponsor/SponsorFlags are signing fields
# on xrpl-py's main branch). Acceptance is therefore pinned to this list, not
# to the installed codec's knowledge. Memos, Paths, DeliverMin, Delegate and
# Signers stay in the list although the facilitator refuses them: each has its
# own reason code, which must remain reachable.
ALLOWED_PAYMENT_FIELDS = frozenset(
    {
        # Common transaction fields, including the legacy optional pair
        # (PreviousTxnID, OperationLimit) that rippled's template still
        # admits: the list pins today's acceptance, it does not narrow it.
        "TransactionType",
        "Account",
        "Fee",
        "Sequence",
        "AccountTxnID",
        "PreviousTxnID",
        "OperationLimit",
        "Flags",
        "LastLedgerSequence",
        "Memos",
        "NetworkID",
        "Signers",
        "SourceTag",
        "SigningPubKey",
        "TicketSequence",
        "TxnSignature",
        "Delegate",
        # Payment fields. DeliverMax is a JSON-API alias with no binary
        # field, so a decoded blob can only spell the amount as Amount.
        "Amount",
        "Destination",
        "DestinationTag",
        "InvoiceID",
        "Paths",
        "SendMax",
        "DeliverMin",
        "CredentialIDs",
        "DomainID",
    }
)


def is_xrpl_network(network: str) -> bool:
    """Return True when the CAIP-2 identifier names a supported XRPL network.

    Applies the same magnitude bound as :func:`parse_xrpl_network_id`, so the
    two validators cannot disagree about one string.

    Args:
        network: CAIP-2 network identifier.

    Returns:
        Whether the network is a supported XRPL network.
    """
    match = _NETWORK_RE.match(network)
    return match is not None and int(match.group(1)) <= MAX_NETWORK_ID


def parse_xrpl_network_id(network: str) -> int:
    """Extract the numeric network id from a CAIP-2 identifier.

    Args:
        network: CAIP-2 network identifier such as ``xrpl:0``.

    Returns:
        The numeric network id.

    Raises:
        ValueError: If the identifier is not a supported XRPL network.
    """
    if not is_xrpl_network(network):
        raise ValueError(f"Unsupported XRPL network: {network}")
    return int(network.split(":", 1)[1])


def decode_signed_transaction_blob(signed_tx_blob: str) -> dict[str, Any]:
    """Decode a hex-encoded signed transaction blob.

    The blob must be the *canonical* serialisation of the transaction it
    decodes to. XRPL's deserialiser accepts fields in any order, so one signed
    transaction otherwise has many encodings, each with a valid signature and
    a different hash. That would let one payment pass the duplicate-settlement
    guard once per re-ordering, and would have settlement poll a transaction id
    the ledger never assigns.

    Args:
        signed_tx_blob: Hex-encoded signed transaction.

    Returns:
        The decoded transaction fields.

    Raises:
        ValueError: If the blob is not canonical hexadecimal, cannot be
            decoded, or carries a field a conforming Payment cannot.
    """
    # Length before the linear hex scan, so rejection costs one comparison.
    if len(signed_tx_blob) > MAX_SIGNED_TX_BLOB_HEX:
        raise ValueError("signedTxBlob is larger than any valid XRPL transaction")
    if not _HEX_RE.match(signed_tx_blob):
        raise ValueError("signedTxBlob must be an even-length hex string")
    try:
        decoded: dict[str, Any] = binarycodec.decode(signed_tx_blob)
        canonical = binarycodec.encode(decoded)
    except Exception as e:
        # The codec's own exception is not a ValueError, which is what callers
        # are documented to expect for bad input.
        raise ValueError(f"signedTxBlob is not a decodable transaction: {e}") from e
    if canonical.upper() != signed_tx_blob.upper():
        raise ValueError("signedTxBlob is not the canonical serialisation of its transaction")

    # The signature covers only the signing fields, so anyone holding no key
    # can append another non-signing field: the blob stays canonical, the
    # signature stays valid, and the transaction hash, the duplicate guard's
    # key, moves. Signers is allowed through so the facilitator can refuse
    # it under its own reason code.
    for field in decoded:
        if field not in ALLOWED_NON_SIGNING_FIELDS and not get_field_instance(field).is_signing:
            raise ValueError(f"signedTxBlob carries a non-signing field: {field}")

    # A Payment is additionally held to the ledger's own field template,
    # because the codec decodes any field it knows onto any transaction. This
    # keeps acceptance stable across xrpl-py upgrades — a field added by a
    # future amendment is refused here, with the same error a blob the codec
    # cannot decode gets today, until it is admitted deliberately. Other
    # transaction types pass through so the facilitator can reject them under
    # its transaction-type reason code rather than as a malformed blob.
    if decoded.get("TransactionType") == "Payment":
        for field in decoded:
            if field not in ALLOWED_PAYMENT_FIELDS:
                raise ValueError(f"signedTxBlob carries a field foreign to Payment: {field}")
    return decoded


def is_canonical_signing_pub_key(public_key: Any) -> TypeGuard[str]:
    """Return True for a canonical secp256k1 or Ed25519 signing public key.

    Args:
        public_key: Candidate public key.

    Returns:
        Whether the value is a canonical signing public key.
    """
    return isinstance(public_key, str) and bool(_PUB_KEY_RE.match(public_key))


def _is_fully_canonical_signature(signature: bytes, public_key: str) -> bool:
    """Return True for the one signature encoding rippled accepts.

    A signature can be rewritten without the key (negating ``s`` for
    secp256k1, adding the group order to ``S`` for Ed25519) into a variant
    that verifies here but that rippled refuses under
    ``RequireFullyCanonicalSig``, with a different transaction hash per
    variant. A permissive verifier would pass payments that can never settle.

    Args:
        signature: Raw signature bytes.
        public_key: Canonical signing public key, which selects the algorithm.

    Returns:
        Whether the signature is in rippled's required encoding.
    """
    if public_key.upper().startswith("ED"):
        # Ed25519: 64 bytes, with the scalar S below the group order.
        if len(signature) != 64:
            return False
        return int.from_bytes(signature[32:], "little") < _ED25519_GROUP_ORDER

    # secp256k1: strict DER, minimally encoded, with s in the lower half of
    # the group order.
    if len(signature) < 8 or signature[0] != 0x30 or signature[1] != len(signature) - 2:
        return False
    if signature[2] != 0x02:
        return False
    r_length = signature[3]
    s_marker = 4 + r_length
    if r_length == 0 or s_marker + 2 > len(signature) or signature[s_marker] != 0x02:
        return False
    s_length = signature[s_marker + 1]
    if s_length == 0 or s_marker + 2 + s_length != len(signature):
        return False

    r_bytes = signature[4:s_marker]
    s_bytes = signature[s_marker + 2 :]
    for part in (r_bytes, s_bytes):
        # Negative values are not valid, and a leading zero is only allowed
        # when it is what keeps the value positive.
        if part[0] & 0x80:
            return False
        if len(part) > 1 and part[0] == 0x00 and not (part[1] & 0x80):
            return False

    r_value = int.from_bytes(r_bytes, "big")
    s_value = int.from_bytes(s_bytes, "big")
    if not (0 < r_value < _SECP256K1_GROUP_ORDER and 0 < s_value < _SECP256K1_GROUP_ORDER):
        return False
    return s_value <= _SECP256K1_GROUP_ORDER // 2


def verify_signed_blob(signed_tx_blob: str) -> bool:
    """Verify a signed transaction blob against its embedded public key.

    ``xrpl-py`` has no equivalent of xrpl.js's ``verifySignature``, so the
    signing payload is reconstructed here. This proves the blob was signed by
    the holder of the embedded key and has not been altered since; it does
    **not** prove the key is still authorised on the sending account, which is
    a separate ledger lookup.

    Args:
        signed_tx_blob: Hex-encoded signed transaction.

    Returns:
        Whether the signature is valid for the transaction as encoded.
    """
    try:
        decoded = decode_signed_transaction_blob(signed_tx_blob)
    except ValueError:
        return False

    signature = decoded.get("TxnSignature")
    public_key = decoded.get("SigningPubKey")
    if not isinstance(signature, str) or not is_canonical_signing_pub_key(public_key):
        return False

    unsigned = {key: value for key, value in decoded.items() if key != "TxnSignature"}
    try:
        if not _is_fully_canonical_signature(bytes.fromhex(signature), public_key):
            return False
        signing_payload = binarycodec.encode_for_signing(unsigned)
        return keypairs.is_valid_message(
            bytes.fromhex(signing_payload), bytes.fromhex(signature), public_key
        )
    except Exception:
        # A malformed signature or unencodable field set is an invalid blob.
        return False


def get_signed_transaction_hash(signed_tx_blob: str) -> str:
    """Compute the canonical transaction hash of a signed blob.

    XRPL hashes a signed transaction as the first half of the SHA-512 digest of
    the ``TXN\\0`` prefix followed by the serialised transaction.

    Args:
        signed_tx_blob: Hex-encoded signed transaction.

    Returns:
        Uppercase hexadecimal transaction hash.

    Raises:
        ValueError: If the blob is not hexadecimal.
    """
    if len(signed_tx_blob) > MAX_SIGNED_TX_BLOB_HEX:
        raise ValueError("signedTxBlob is larger than any valid XRPL transaction")
    if not _HEX_RE.match(signed_tx_blob):
        raise ValueError("signedTxBlob must be an even-length hex string")
    prefixed = TRANSACTION_ID_PREFIX.to_bytes(4, "big") + bytes.fromhex(signed_tx_blob)
    return hashlib.sha512(prefixed).digest()[:32].hex().upper()


def invoice_id_to_invoice_id_field(invoice_id: str) -> str:
    """Derive the on-ledger ``InvoiceID`` committed for an x402 invoice.

    Args:
        invoice_id: The x402 invoice identifier.

    Returns:
        Uppercase hexadecimal SHA-256 digest of the identifier.
    """
    return hashlib.sha256(invoice_id.encode("utf-8")).hexdigest().upper()


def is_destination_tag(value: Any) -> TypeGuard[int]:
    """Return True when the value is a tag the ledger can carry.

    ``DestinationTag`` is a uint32. ``bool`` is excluded because it is a subclass
    of ``int``, so ``True`` would otherwise pass as the tag 1.

    Args:
        value: Candidate destination tag.

    Returns:
        Whether the value is a valid destination tag.
    """
    return (
        not isinstance(value, bool) and isinstance(value, int) and 0 <= value <= MAX_DESTINATION_TAG
    )


def is_classic_address(address: Any) -> TypeGuard[str]:
    """Return True when the value is a valid XRPL classic address.

    Args:
        address: Candidate address.

    Returns:
        Whether the value is a classic address.
    """
    return isinstance(address, str) and bool(addresscodec.is_valid_classic_address(address))


def is_issued_currency_amount(amount: Any) -> TypeGuard[dict[str, str]]:
    """Return True for an issued-currency amount object rather than XRP drops.

    Args:
        amount: Candidate amount.

    Returns:
        Whether the amount denotes an issued currency.
    """
    return (
        isinstance(amount, dict)
        and isinstance(amount.get("currency"), str)
        and isinstance(amount.get("issuer"), str)
        and isinstance(amount.get("value"), str)
    )


def parse_drops(value: Any) -> int | None:
    """Parse an XRP drops amount strictly.

    Only a bare run of ASCII digits is valid: ``int()`` accepts signs,
    underscores and whitespace, and ``str.isdigit()`` accepts characters
    ``int()`` then rejects.

    Args:
        value: Candidate drops amount.

    Returns:
        The parsed amount, or None when malformed or negative.
    """
    if not isinstance(value, str) or not _DROPS_RE.match(value):
        return None
    return int(value)


def normalize_currency_code(asset: Any) -> str | None:
    """Return the ledger's own spelling of an issued-currency code.

    The spec allows both the 3-character and 160-bit hex spellings, and the
    binary codec normalises the hex form of a standard code back to the ISO
    code on decode, so raw string comparison would make a requirement
    written in hex unpayable. The codec also ignores bytes 15-19 when
    normalising, while the ledger keys trust lines on all twenty, so a code is
    only accepted when it is the canonical spelling of what it normalises to;
    otherwise a payment in one token could satisfy a requirement for another.

    Args:
        asset: Candidate currency code.

    Returns:
        The normalised code, or None when it is not a usable currency.
    """
    if not isinstance(asset, str) or not asset:
        return None
    try:
        normalized = str(Currency.from_value(asset).to_json())
        if Currency.from_value(normalized).to_hex() != Currency.from_value(asset).to_hex():
            return None
    except Exception:
        return None
    # "XRP" names the native asset, which is never an issued currency; the
    # all-zero 160-bit code normalises to it.
    return None if normalized == ASSET_XRP else normalized


def is_issued_currency_value(value: Any) -> TypeGuard[str]:
    """Return True for a value the ledger can hold as an issued-currency amount.

    Args:
        value: Candidate value.

    Returns:
        Whether the value is a plain non-negative decimal string.
    """
    return isinstance(value, str) and bool(_DECIMAL_RE.match(value))


def parse_money_to_decimal(money: str | int | float) -> float:
    """Parse a Money value such as ``"$1.50"``, ``"1.50"`` or ``1.5``.

    Mirrors the sibling mechanisms' parser so a money string behaves the same
    across schemes. The result feeds registered money parsers; XRPL itself has
    no on-ledger rate, so nothing here converts to an asset amount.

    Args:
        money: Money value in string or numeric form.

    Returns:
        The decimal amount.

    Raises:
        ValueError: If the value is not a non-negative finite amount.
    """
    if isinstance(money, bool):
        raise ValueError(f"Invalid money format: {money!r}")
    if isinstance(money, int | float):
        value = float(money)
    else:
        clean = re.sub(r"\s*(?:USD|USDC|usd|usdc)\s*\Z", "", money.strip().lstrip("$")).strip()
        # float() also accepts "1_000" and "inf". A stray separator in a
        # configured price is a thousandfold difference in what is charged.
        if not _MONEY_RE.match(clean):
            raise ValueError(f"Invalid money format: {money!r}")
        value = float(clean)
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"Invalid money format: {money!r}")
    return value


def get_max_last_ledger_sequence(current_ledger_index: int, max_timeout_seconds: float) -> int:
    """Return the highest LastLedgerSequence allowed for a payment.

    The client builds to exactly this bound and the facilitator rejects above
    it. The formula matches the TypeScript mechanism, so neither
    implementation rejects the other's payments.

    Args:
        current_ledger_index: Current validated ledger index.
        max_timeout_seconds: Requirement's validity window in seconds.

    Returns:
        The maximum acceptable LastLedgerSequence.
    """
    ledgers = math.ceil(float(max_timeout_seconds or 0) / DEFAULT_LEDGER_CLOSE_SECONDS)
    return current_ledger_index + ledgers + DEFAULT_LEDGER_TOLERANCE
