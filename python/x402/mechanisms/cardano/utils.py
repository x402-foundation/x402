"""Cardano wire decoding and ledger-independent helpers."""

from __future__ import annotations

import base64
import binascii
import hashlib
from io import BytesIO
from typing import Any

try:
    from nacl.exceptions import BadSignatureError
    from nacl.signing import VerifyKey
    from pycardano import RawPlutusData, Transaction
    from pycardano.cbor import cbor2
except ImportError as e:
    raise ImportError("Cardano mechanism requires: pip install x402[cardano]") from e

from .constants import (
    CARDANO_ASSET_REGEX,
    CARDANO_MAINNET_CAIP2,
    CARDANO_MIN_UTXO_OVERHEAD_BYTES,
    CARDANO_PREPROD_CAIP2,
    CARDANO_PREVIEW_CAIP2,
    CARDANO_UTXO_REF_REGEX,
    normalize_cardano_network,
)
from .limits import MAX_CARDANO_TRANSACTION_BYTES
from .types import CardanoUtxoOutput, DecodedCardanoTransaction, ExactCardanoPayload

# Shelley-era slot origins used by the TypeScript reference signer.
_SLOT_CONFIG = {
    CARDANO_MAINNET_CAIP2: (1_596_059_091_000, 4_492_800),
    CARDANO_PREPROD_CAIP2: (1_655_769_600_000, 86_400),
    CARDANO_PREVIEW_CAIP2: (1_666_656_000_000, 0),
}


def slot_to_posix_ms(network: str, slot: int) -> int:
    """Convert a slot using the selected network's Shelley slot origin."""
    config = _SLOT_CONFIG.get(normalize_cardano_network(network))
    if config is None:
        raise ValueError(f"No slot config for network: {network}")
    zero_time, zero_slot = config
    return zero_time + (slot - zero_slot) * 1000


def min_utxo_lovelace(serialized_size: int, coins_per_utxo_byte: int) -> int:
    return (CARDANO_MIN_UTXO_OVERHEAD_BYTES + serialized_size) * coins_per_utxo_byte


def parse_asset_unit(asset: str) -> tuple[str, str]:
    if not isinstance(asset, str) or CARDANO_ASSET_REGEX.fullmatch(asset) is None:
        raise ValueError(f"Invalid Cardano asset unit: {asset}")
    if asset == "lovelace":
        return "", ""
    policy, name = asset.lower().split(".")
    return policy, name


def parse_utxo_ref(ref: str) -> tuple[str, int]:
    if not isinstance(ref, str) or CARDANO_UTXO_REF_REGEX.fullmatch(ref) is None:
        raise ValueError(f"Invalid Cardano UTXO reference: {ref}")
    tx_hash, index = ref.split("#")
    return tx_hash.lower(), int(index)


def decode_cardano_payload(raw: dict[str, Any]) -> ExactCardanoPayload:
    transaction = raw.get("transaction")
    nonce = raw.get("nonce")
    if not isinstance(transaction, str) or not transaction:
        raise ValueError("Cardano payload is missing a transaction string")
    if len(transaction) > ((MAX_CARDANO_TRANSACTION_BYTES + 2) // 3) * 4:
        raise ValueError("Cardano payload transaction exceeds the decode limit")
    if not isinstance(nonce, str) or not nonce:
        raise ValueError("Cardano payload is missing a nonce string")
    return ExactCardanoPayload(transaction, nonce)


def decode_cardano_transaction_bytes(transaction_base64: str) -> bytes:
    if (
        not transaction_base64
        or len(transaction_base64) > ((MAX_CARDANO_TRANSACTION_BYTES + 2) // 3) * 4
    ):
        raise ValueError("Cardano transaction exceeds the decode limit")
    try:
        decoded = base64.b64decode(transaction_base64, validate=True)
    except (ValueError, binascii.Error) as e:
        raise ValueError("Cardano transaction must use canonical padded base64") from e
    if (
        not decoded
        or len(decoded) > MAX_CARDANO_TRANSACTION_BYTES
        or base64.b64encode(decoded).decode("ascii") != transaction_base64
    ):
        raise ValueError("Cardano transaction must use canonical padded base64")
    return decoded


def decode_cbor(data: bytes) -> Any:
    """Decode one CBOR item, rejecting trailing bytes."""
    stream = BytesIO(data)
    try:
        result = cbor2.CBORDecoder(stream).decode()
    except (ValueError, EOFError, RecursionError, TypeError) as e:
        raise ValueError("Invalid CBOR") from e
    if stream.tell() != len(data):
        raise ValueError("Trailing CBOR bytes")
    return result


def unwrap_cbor_byte_string(hex_value: str) -> bytes:
    try:
        result = decode_cbor(bytes.fromhex(hex_value))
    except ValueError as e:
        raise ValueError("Expected a CBOR byte string from applyParamsToScript") from e
    if not isinstance(result, bytes):
        raise ValueError("Expected a CBOR byte string from applyParamsToScript")
    return result


def _transaction_body_bytes(raw: bytes) -> bytes:
    """Extract the original body; re-encoding it would change signed hashes."""
    stream = BytesIO(raw)
    initial = stream.read(1)[0]
    if initial >> 5 != 4:
        raise ValueError("Expected a CBOR transaction array")
    length = initial & 31
    if length == 24:
        size = stream.read(1)
        if not size:
            raise ValueError("Truncated CBOR array")
        length = size[0]
    if length not in (4, 31):
        raise ValueError("Expected a four-element Cardano transaction")
    start = stream.tell()
    cbor2.CBORDecoder(stream).decode()
    return raw[start : stream.tell()]


def decode_cardano_transaction(transaction_base64: str) -> DecodedCardanoTransaction:
    """Decode payment fields and verify vkey signatures over the original body."""
    raw = decode_cardano_transaction_bytes(transaction_base64)
    try:
        primitive = decode_cbor(raw)
        if not isinstance(primitive, list) or len(primitive) != 4 or type(primitive[2]) is not bool:
            raise ValueError("Invalid Cardano transaction envelope")
        if not isinstance(primitive[0], dict) or not {0, 1, 2} <= primitive[0].keys():
            raise ValueError("Missing transaction body fields")
        tx = Transaction.from_cbor(raw)
        body_hash = hashlib.blake2b(_transaction_body_bytes(raw), digest_size=32).digest()
        body = tx.transaction_body
        ws = tx.transaction_witness_set
        outputs = []
        for output in body.outputs:
            datum = output.datum
            datum_hex = None
            if datum is not None:
                datum_hex = (
                    datum.to_cbor_hex()
                    if isinstance(datum, RawPlutusData)
                    else RawPlutusData(datum).to_cbor_hex()
                )
            outputs.append(
                CardanoUtxoOutput(
                    address=str(output.address),
                    coin=output.amount.coin,
                    assets={
                        f"{policy.payload.hex()}.{name.payload.hex()}": quantity
                        for policy, assets in output.amount.multi_asset.items()
                        for name, quantity in assets.items()
                    },
                    datum=datum_hex,
                    serialized_size=len(output.to_cbor()),
                    has_reference_script=output.script is not None,
                )
            )
        witnesses = list(ws.vkey_witnesses or [])
        signatures_valid = True
        for witness in witnesses:
            try:
                VerifyKey(witness.vkey.payload).verify(body_hash, witness.signature)
            except (BadSignatureError, ValueError):
                signatures_valid = False
        redeemer_count = len(ws.redeemer or [])
        return DecodedCardanoTransaction(
            tx_hash=body_hash.hex(),
            network_id=int(body.network_id) if body.network_id is not None else None,
            ttl_slot=body.ttl,
            validity_start_slot=body.validity_start,
            inputs=[f"{item.transaction_id.payload.hex()}#{item.index}" for item in body.inputs],
            fee=body.fee,
            size_bytes=len(raw),
            balance_changing_operations=[
                name
                for key, name in (
                    (9, "mint"),
                    (5, "withdrawals"),
                    (4, "certificates"),
                    (20, "proposalProcedures"),
                    (22, "donation"),
                )
                if key in primitive[0]
            ],
            outputs=outputs,
            vkey_witness_count=len(witnesses) + len(ws.bootstrap_witness or []),
            vkey_hashes=[
                hashlib.blake2b(item.vkey.payload, digest_size=28).hexdigest() for item in witnesses
            ],
            required_signer_hashes=[item.payload.hex() for item in body.required_signers or []],
            script_witness_count=sum(
                len(items or [])
                for items in (
                    ws.native_scripts,
                    ws.plutus_v1_script,
                    ws.plutus_v2_script,
                    ws.plutus_v3_script,
                )
            )
            + redeemer_count,
            redeemer_count=redeemer_count,
            signatures_valid=signatures_valid,
            is_valid=tx.valid is not False,
            auxiliary_data_hash=body.auxiliary_data_hash.payload.hex()
            if body.auxiliary_data_hash
            else None,
        )
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        AttributeError,
        OverflowError,
        RecursionError,
    ) as e:
        raise ValueError("Invalid Cardano transaction CBOR") from e
