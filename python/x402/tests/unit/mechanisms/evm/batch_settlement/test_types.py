"""Wire-format type tests for batch-settlement (D1 / D4 / D5 / D7 / D8).

Wire-level byte equivalence with the TypeScript SDK (Layer 2 invariants
L2.1-L2.11) lands in subsequent PRs alongside the cross-language fixture
generator. These tests cover Pydantic-level wire shape, alias handling,
optional-field semantics, manual discrimination, and XOR auth validation.
"""

try:
    from eth_utils import is_checksum_address  # type: ignore[attr-defined]  # noqa: F401
except ImportError:
    import pytest

    pytest.skip("batch_settlement requires eth_utils", allow_module_level=True)

from collections.abc import Callable
from typing import Any

import pytest

from x402.mechanisms.evm.batch_settlement.types import (
    BatchSettlementClaimPayload,
    BatchSettlementDepositAuthorization,
    BatchSettlementDepositPayload,
    BatchSettlementEnrichedRefundPayload,
    BatchSettlementErc3009Authorization,
    BatchSettlementPaymentRequirementsExtra,
    BatchSettlementPermit2Authorization,
    BatchSettlementPermit2Permitted,
    BatchSettlementPermit2Witness,
    BatchSettlementRefundPayload,
    BatchSettlementSettlePayload,
    BatchSettlementVoucherClaim,
    BatchSettlementVoucherFields,
    BatchSettlementVoucherPayload,
    ChannelConfig,
    _validate_deposit_xor,
    parse_facilitator_payload,
    parse_payload,
)

# --- Fixtures ---

ADDR_PAYER = "0x1111111111111111111111111111111111111111"
ADDR_PAYER_AUTHORIZER = "0x2222222222222222222222222222222222222222"
ADDR_RECEIVER = "0x3333333333333333333333333333333333333333"
ADDR_RECEIVER_AUTHORIZER = "0x4444444444444444444444444444444444444444"
ADDR_TOKEN = "0x5555555555555555555555555555555555555555"
SALT = "0x" + "ab" * 32
CHANNEL_ID = "0x" + "cd" * 32
SIGNATURE = "0x" + "ef" * 65


def _channel_config_dict() -> dict[str, Any]:
    return {
        "payer": ADDR_PAYER,
        "payerAuthorizer": ADDR_PAYER_AUTHORIZER,
        "receiver": ADDR_RECEIVER,
        "receiverAuthorizer": ADDR_RECEIVER_AUTHORIZER,
        "token": ADDR_TOKEN,
        "withdrawDelay": 900,
        "salt": SALT,
    }


def _voucher_dict() -> dict[str, Any]:
    return {
        "channelId": CHANNEL_ID,
        "maxClaimableAmount": "1000000",
        "signature": SIGNATURE,
    }


def _erc3009_auth_dict() -> dict[str, Any]:
    return {
        "validAfter": "1700000000",
        "validBefore": "1700003600",
        "salt": SALT,
        "signature": SIGNATURE,
    }


def _permit2_auth_dict() -> dict[str, Any]:
    return {
        "from": ADDR_PAYER,
        "permitted": {"token": ADDR_TOKEN, "amount": "1000000"},
        "spender": ADDR_RECEIVER,
        "nonce": "1",
        "deadline": "1700003600",
        "witness": {"channelId": CHANNEL_ID},
        "signature": SIGNATURE,
    }


def _deposit_payload_dict(*, permit2: bool = False) -> dict[str, Any]:
    auth = (
        {"permit2Authorization": _permit2_auth_dict()}
        if permit2
        else {"erc3009Authorization": _erc3009_auth_dict()}
    )
    return {
        "type": "deposit",
        "channelConfig": _channel_config_dict(),
        "voucher": _voucher_dict(),
        "deposit": {"amount": "1000000", "authorization": auth},
    }


def _voucher_payload_dict() -> dict[str, Any]:
    return {
        "type": "voucher",
        "channelConfig": _channel_config_dict(),
        "voucher": _voucher_dict(),
    }


def _refund_payload_dict(*, with_amount: bool = False) -> dict[str, Any]:
    d = {
        "type": "refund",
        "channelConfig": _channel_config_dict(),
        "voucher": _voucher_dict(),
    }
    if with_amount:
        d["amount"] = "500000"
    return d


def _voucher_claim_dict() -> dict[str, Any]:
    return {
        "voucher": {
            "channel": _channel_config_dict(),
            "maxClaimableAmount": "1000000",
        },
        "signature": SIGNATURE,
        "totalClaimed": "500000",
    }


# --- D4: camelCase ↔ snake_case alias handling ---


def test_channel_config_round_trips_camel_case() -> None:
    cfg = ChannelConfig.model_validate(_channel_config_dict())
    assert cfg.payer_authorizer == ADDR_PAYER_AUTHORIZER
    assert cfg.withdraw_delay == 900
    dumped = cfg.model_dump(by_alias=True)
    assert "payerAuthorizer" in dumped
    assert "withdrawDelay" in dumped


def test_permit2_from_alias_maps_to_underscore() -> None:
    """``from`` is reserved in Python; we use ``from_`` with explicit alias."""
    auth = BatchSettlementPermit2Authorization.model_validate(_permit2_auth_dict())
    assert auth.from_ == ADDR_PAYER
    dumped = auth.model_dump(by_alias=True)
    assert dumped["from"] == ADDR_PAYER
    assert "from_" not in dumped


def test_permit2_from_alias_used_by_default_serialization() -> None:
    """``BaseX402Model.serialize_by_alias=True`` should emit ``"from"`` even without ``by_alias``."""
    auth = BatchSettlementPermit2Authorization.model_validate(_permit2_auth_dict())
    dumped_default = auth.model_dump()
    assert dumped_default["from"] == ADDR_PAYER
    assert "from_" not in dumped_default


def test_voucher_fields_round_trip() -> None:
    vf = BatchSettlementVoucherFields.model_validate(_voucher_dict())
    assert vf.channel_id == CHANNEL_ID
    assert vf.max_claimable_amount == "1000000"
    assert vf.model_dump(by_alias=True) == _voucher_dict()


# --- D5: Optional 三状態 (absent / explicit null / present) ---


def test_optional_field_absent_round_trips_to_absent_when_excluded() -> None:
    """absent on input → None attribute → absent on output (exclude_none=True)."""
    payload = BatchSettlementRefundPayload.model_validate(_refund_payload_dict())
    assert payload.amount is None
    dumped = payload.model_dump(by_alias=True, exclude_none=True)
    assert "amount" not in dumped


def test_optional_field_dumps_null_by_default() -> None:
    """absent on input → None → ``null`` on output when exclude_none=False (default).

    D5 contract: callers MUST pass ``exclude_none=True`` to match the TS wire
    (which drops ``undefined`` keys); this test pins the default behavior so
    the call-site discipline is intentional rather than incidental.
    """
    payload = BatchSettlementRefundPayload.model_validate(_refund_payload_dict())
    dumped = payload.model_dump(by_alias=True)
    assert dumped["amount"] is None


def test_optional_field_accepts_explicit_null() -> None:
    """``"amount": null`` is accepted defensively (#1762)."""
    data = _refund_payload_dict()
    data["amount"] = None
    payload = BatchSettlementRefundPayload.model_validate(data)
    assert payload.amount is None


def test_optional_field_present_round_trips() -> None:
    payload = BatchSettlementRefundPayload.model_validate(_refund_payload_dict(with_amount=True))
    assert payload.amount == "500000"
    dumped = payload.model_dump(by_alias=True, exclude_none=True)
    assert dumped["amount"] == "500000"


def test_payment_requirements_extra_optional_collapse() -> None:
    """All optional state extras absent → exclude_none drops them all."""
    pre = BatchSettlementPaymentRequirementsExtra.model_validate(
        {
            "receiverAuthorizer": ADDR_RECEIVER_AUTHORIZER,
            "withdrawDelay": 900,
            "name": "x402 Batch Settlement",
            "version": "1",
        }
    )
    dumped = pre.model_dump(by_alias=True, exclude_none=True)
    assert dumped == {
        "receiverAuthorizer": ADDR_RECEIVER_AUTHORIZER,
        "withdrawDelay": 900,
        "name": "x402 Batch Settlement",
        "version": "1",
    }


# --- D7: parse_payload manual discrimination ---


def test_parse_payload_deposit() -> None:
    payload = parse_payload(_deposit_payload_dict())
    assert isinstance(payload, BatchSettlementDepositPayload)
    assert payload.type == "deposit"


def test_parse_payload_deposit_permit2() -> None:
    payload = parse_payload(_deposit_payload_dict(permit2=True))
    assert isinstance(payload, BatchSettlementDepositPayload)
    assert payload.deposit.authorization.permit2_authorization is not None


def test_parse_payload_voucher() -> None:
    payload = parse_payload(_voucher_payload_dict())
    assert isinstance(payload, BatchSettlementVoucherPayload)
    assert payload.type == "voucher"


def test_parse_payload_refund() -> None:
    payload = parse_payload(_refund_payload_dict())
    assert isinstance(payload, BatchSettlementRefundPayload)
    assert payload.type == "refund"


def test_parse_payload_unknown_type_raises() -> None:
    with pytest.raises(ValueError, match="unknown BatchSettlementPayload type"):
        parse_payload({"type": "frob"})


def test_parse_payload_missing_type_raises() -> None:
    with pytest.raises(ValueError, match="unknown BatchSettlementPayload type"):
        parse_payload({})


# --- D7 facilitator-side: parse_facilitator_payload ---


def test_parse_facilitator_payload_claim() -> None:
    data = {"type": "claim", "claims": [_voucher_claim_dict()]}
    payload = parse_facilitator_payload(data)
    assert isinstance(payload, BatchSettlementClaimPayload)
    assert len(payload.claims) == 1
    assert isinstance(payload.claims[0], BatchSettlementVoucherClaim)


def test_parse_facilitator_payload_settle() -> None:
    data = {"type": "settle", "receiver": ADDR_RECEIVER, "token": ADDR_TOKEN}
    payload = parse_facilitator_payload(data)
    assert isinstance(payload, BatchSettlementSettlePayload)


def test_parse_facilitator_payload_enriched_refund() -> None:
    data = {
        "type": "refund",
        "channelConfig": _channel_config_dict(),
        "voucher": _voucher_dict(),
        "amount": "500000",
        "refundNonce": "1",
        "claims": [_voucher_claim_dict()],
    }
    payload = parse_facilitator_payload(data)
    assert isinstance(payload, BatchSettlementEnrichedRefundPayload)
    assert payload.amount == "500000"
    assert payload.refund_nonce == "1"


def test_parse_facilitator_payload_plain_refund_rejected() -> None:
    """Plain (client-side) refund must be rejected by the facilitator parser."""
    with pytest.raises(ValueError, match="missing mandatory fields"):
        parse_facilitator_payload(_refund_payload_dict())


def test_parse_facilitator_payload_refund_with_null_mandatory_rejected() -> None:
    """``null`` on a mandatory enriched field must surface as the same ValueError.

    Without this, ``data.get(k) is not None`` collapses ``null`` and absent into
    one branch; otherwise the caller would see a Pydantic ``ValidationError``
    for ``amount: str`` rejecting ``None`` and a plain ``ValueError`` for the
    absent case — two exception types for the same wire-shape failure.
    """
    data = {
        "type": "refund",
        "channelConfig": _channel_config_dict(),
        "voucher": _voucher_dict(),
        "amount": None,
        "refundNonce": "1",
        "claims": [_voucher_claim_dict()],
    }
    with pytest.raises(ValueError, match="missing mandatory fields"):
        parse_facilitator_payload(data)


def test_parse_facilitator_payload_unknown_type_raises() -> None:
    with pytest.raises(ValueError, match="unknown BatchSettlementFacilitatorSettlePayload type"):
        parse_facilitator_payload({"type": "frob"})


# --- D8: XOR deposit authorization ---


def test_deposit_xor_erc3009_only_passes() -> None:
    auth = BatchSettlementDepositAuthorization.model_validate(
        {"erc3009Authorization": _erc3009_auth_dict()}
    )
    _validate_deposit_xor(auth)


def test_deposit_xor_permit2_only_passes() -> None:
    auth = BatchSettlementDepositAuthorization.model_validate(
        {"permit2Authorization": _permit2_auth_dict()}
    )
    _validate_deposit_xor(auth)


def test_deposit_xor_both_set_raises() -> None:
    auth = BatchSettlementDepositAuthorization.model_validate(
        {
            "erc3009Authorization": _erc3009_auth_dict(),
            "permit2Authorization": _permit2_auth_dict(),
        }
    )
    with pytest.raises(ValueError, match="exactly one of"):
        _validate_deposit_xor(auth)


def test_deposit_xor_both_unset_raises() -> None:
    auth = BatchSettlementDepositAuthorization.model_validate({})
    with pytest.raises(ValueError, match="exactly one of"):
        _validate_deposit_xor(auth)


def test_parse_payload_deposit_with_both_auth_raises() -> None:
    data = _deposit_payload_dict()
    data["deposit"]["authorization"]["permit2Authorization"] = _permit2_auth_dict()
    with pytest.raises(ValueError, match="exactly one of"):
        parse_payload(data)


def test_parse_payload_deposit_with_no_auth_raises() -> None:
    data = _deposit_payload_dict()
    data["deposit"]["authorization"] = {}
    with pytest.raises(ValueError, match="exactly one of"):
        parse_payload(data)


# --- D1: Integer-as-string (large integer round-trip without IntStr) ---


def test_large_integer_round_trips_as_str() -> None:
    """Wire format keeps large ints as str; Python str field preserves them losslessly."""
    big = "123456789012345678901234567890"
    data = _voucher_dict()
    data["maxClaimableAmount"] = big
    vf = BatchSettlementVoucherFields.model_validate(data)
    assert vf.max_claimable_amount == big
    assert int(vf.max_claimable_amount) == int(big)
    assert vf.model_dump(by_alias=True)["maxClaimableAmount"] == big


# --- Round-trip stability ---


@pytest.mark.parametrize(
    "data_factory",
    [
        _deposit_payload_dict,
        _voucher_payload_dict,
        _refund_payload_dict,
        lambda: _refund_payload_dict(with_amount=True),
        lambda: _deposit_payload_dict(permit2=True),
    ],
)
def test_payload_round_trip_is_stable(data_factory: Callable[[], dict[str, Any]]) -> None:
    """parse → dump → parse yields the same wire dict (exclude_none normalization)."""
    original = data_factory()
    parsed = parse_payload(original)
    dumped = parsed.model_dump(by_alias=True, exclude_none=True)
    reparsed = parse_payload(dumped)
    assert reparsed.model_dump(by_alias=True, exclude_none=True) == dumped


# --- Erc3009 / Permit2 standalone round-trips ---


def test_erc3009_authorization_round_trip() -> None:
    auth = BatchSettlementErc3009Authorization.model_validate(_erc3009_auth_dict())
    assert auth.model_dump(by_alias=True) == _erc3009_auth_dict()


def test_permit2_authorization_round_trip() -> None:
    auth = BatchSettlementPermit2Authorization.model_validate(_permit2_auth_dict())
    dumped = auth.model_dump(by_alias=True)
    assert dumped == _permit2_auth_dict()
    assert isinstance(auth.permitted, BatchSettlementPermit2Permitted)
    assert isinstance(auth.witness, BatchSettlementPermit2Witness)


# --- extra="ignore" wire contract (BaseX402Model default) ---


def test_unknown_wire_field_is_silently_dropped() -> None:
    """``BaseX402Model`` inherits Pydantic's default ``extra="ignore"``.

    This pins the contract: unknown wire fields are dropped, not rejected.
    The cross-language fixture layer (Layer 2 L2.x) is responsible for the
    schema-strictness side of TS↔Python interop.
    """
    data = {**_voucher_dict(), "futureField": "should-be-dropped"}
    vf = BatchSettlementVoucherFields.model_validate(data)
    dumped = vf.model_dump(by_alias=True)
    assert "futureField" not in dumped
    assert dumped == _voucher_dict()
