"""Encode and decode the 19-field masumi.vested_pay.v2 lock datum."""

from dataclasses import dataclass
from typing import Any, cast

from pycardano import Address, PointerAddress, RawPlutusData, ScriptHash

from ...limits import MAX_CARDANO_DATUM_BYTES
from ...utils import decode_cbor

MASUMI_STATE_FUNDS_LOCKED = 0


@dataclass(frozen=True)
class MasumiCredential:
    is_script: bool
    hash: str


@dataclass(frozen=True)
class MasumiAddressCredentials:
    payment: MasumiCredential
    stake: MasumiCredential | None = None
    pointer: tuple[int, int, int] | None = None


@dataclass
class MasumiLockDatumInput:
    buyer_address: str
    seller_address: str
    reference_key: str
    reference_signature: str
    seller_nonce: str
    buyer_nonce: str
    agent_identifier: str
    collateral_return_lovelace: int
    input_hash: str
    pay_by_time: int
    submit_result_time: int
    unlock_time: int
    external_dispute_unlock_time: int
    buyer_return_address: str | None = None
    seller_return_address: str | None = None


@dataclass
class MasumiDatumView:
    buyer: MasumiAddressCredentials
    buyer_return_address: MasumiAddressCredentials | None
    seller: MasumiAddressCredentials
    seller_return_address: MasumiAddressCredentials | None
    reference_key: str
    reference_signature: str
    seller_nonce: str
    buyer_nonce: str
    agent_identifier: str
    collateral_return_lovelace: int
    input_hash: str
    result_hash: str
    pay_by_time: int
    submit_result_time: int
    unlock_time: int
    external_dispute_unlock_time: int
    seller_cooldown_time: int
    buyer_cooldown_time: int
    state: int


def address_credentials(bech32: str) -> MasumiAddressCredentials:
    address = Address.from_primitive(bech32)
    if address.payment_part is None:
        raise ValueError("Masumi datum address must have a payment credential")
    payment = MasumiCredential(
        isinstance(address.payment_part, ScriptHash), address.payment_part.payload.hex()
    )
    stake = address.staking_part
    if isinstance(stake, PointerAddress):
        return MasumiAddressCredentials(
            payment, pointer=(stake.slot, stake.tx_index, stake.cert_index)
        )
    return MasumiAddressCredentials(
        payment,
        MasumiCredential(isinstance(stake, ScriptHash), stake.payload.hex()) if stake else None,
    )


def _constr(index: int, fields: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"constructor": index, "fields": fields or []}


def _address_data(value: str) -> dict[str, Any]:
    credentials = address_credentials(value)

    def credential(cred: MasumiCredential) -> dict[str, Any]:
        return _constr(int(cred.is_script), [{"bytes": cred.hash}])

    if credentials.stake:
        stake = _constr(0, [_constr(0, [credential(credentials.stake)])])
    elif credentials.pointer:
        stake = _constr(0, [_constr(1, [{"int": n} for n in credentials.pointer])])
    else:
        stake = _constr(1)
    return _constr(0, [credential(credentials.payment), stake])


def build_masumi_lock_datum(input: MasumiLockDatumInput) -> RawPlutusData:
    def optional(address: str | None) -> dict[str, Any]:
        return _constr(0, [_address_data(address)]) if address else _constr(1)

    fields = [
        _address_data(input.buyer_address),
        optional(input.buyer_return_address),
        _address_data(input.seller_address),
        optional(input.seller_return_address),
    ]
    fields.extend(
        {"bytes": value}
        for value in (
            input.reference_key,
            input.reference_signature,
            input.seller_nonce,
            input.buyer_nonce,
            input.agent_identifier,
        )
    )
    fields.extend(
        [{"int": input.collateral_return_lovelace}, {"bytes": input.input_hash}, {"bytes": ""}]
    )
    fields.extend(
        {"int": value}
        for value in (
            input.pay_by_time,
            input.submit_result_time,
            input.unlock_time,
            input.external_dispute_unlock_time,
            0,
            0,
        )
    )
    fields.append(_constr(MASUMI_STATE_FUNDS_LOCKED))
    return RawPlutusData.from_dict(_constr(0, fields))


def _fields(data: dict[str, Any], index: int, length: int) -> list[dict[str, Any]]:
    if data.get("constructor") != index or len(data.get("fields", [])) != length:
        raise ValueError("Invalid Masumi constructor")
    return cast(list[dict[str, Any]], data["fields"])


def _credential(data: dict[str, Any]) -> MasumiCredential:
    if data.get("constructor") not in (0, 1):
        raise ValueError("Invalid Masumi credential")
    fields = _fields(data, data["constructor"], 1)
    digest = fields[0]["bytes"]
    if len(digest) != 56:
        raise ValueError("Invalid credential hash")
    return MasumiCredential(data["constructor"] == 1, digest)


def _parse_address(data: dict[str, Any]) -> MasumiAddressCredentials:
    payment, option = _fields(data, 0, 2)
    credential = _credential(payment)
    if option.get("constructor") == 1:
        _fields(option, 1, 0)
        return MasumiAddressCredentials(credential)
    stake = _fields(option, 0, 1)[0]
    if stake.get("constructor") == 0:
        return MasumiAddressCredentials(credential, _credential(_fields(stake, 0, 1)[0]))
    fields = _fields(stake, 1, 3)
    pointer = tuple(field["int"] for field in fields)
    if any(type(value) is not int or value < 0 for value in pointer):
        raise ValueError("Invalid pointer stake reference")
    return MasumiAddressCredentials(credential, pointer=pointer)


def _parse_optional(data: dict[str, Any]) -> MasumiAddressCredentials | None:
    if data.get("constructor") == 1:
        _fields(data, 1, 0)
        return None
    return _parse_address(_fields(data, 0, 1)[0])


def parse_masumi_lock_datum(datum: RawPlutusData | str) -> MasumiDatumView | None:
    try:
        if isinstance(datum, str):
            if len(datum) // 2 > MAX_CARDANO_DATUM_BYTES:
                return None
            raw = bytes.fromhex(datum)
            decode_cbor(raw)
            datum = RawPlutusData.from_cbor(raw)
        f = _fields(datum.to_dict(), 0, 19)
        bytes_fields = [f[i]["bytes"] for i in (4, 5, 6, 7, 8, 10, 11)]
        ints = [f[i]["int"] for i in (9, 12, 13, 14, 15, 16, 17)]
        if any(type(value) is not int for value in ints):
            return None
        state = f[18]["constructor"]
        _fields(f[18], state, 0)
        return MasumiDatumView(
            buyer=_parse_address(f[0]),
            buyer_return_address=_parse_optional(f[1]),
            seller=_parse_address(f[2]),
            seller_return_address=_parse_optional(f[3]),
            reference_key=bytes_fields[0],
            reference_signature=bytes_fields[1],
            seller_nonce=bytes_fields[2],
            buyer_nonce=bytes_fields[3],
            agent_identifier=bytes_fields[4],
            collateral_return_lovelace=ints[0],
            input_hash=bytes_fields[5],
            result_hash=bytes_fields[6],
            pay_by_time=ints[1],
            submit_result_time=ints[2],
            unlock_time=ints[3],
            external_dispute_unlock_time=ints[4],
            seller_cooldown_time=ints[5],
            buyer_cooldown_time=ints[6],
            state=state,
        )
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        return None
