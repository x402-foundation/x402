"""Tests for TVM error constant exports."""

from __future__ import annotations

from x402.mechanisms.tvm import (
    ERR_EXACT_TVM_ACCOUNT_FROZEN,
    ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
    ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE,
    ERR_EXACT_TVM_INSUFFICIENT_BALANCE,
    ERR_EXACT_TVM_INVALID_AMOUNT,
    ERR_EXACT_TVM_INVALID_ASSET,
    ERR_EXACT_TVM_INVALID_CODE_HASH,
    ERR_EXACT_TVM_INVALID_EXTENSIONS_DICT,
    ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
    ERR_EXACT_TVM_INVALID_PAYLOAD,
    ERR_EXACT_TVM_INVALID_RECIPIENT,
    ERR_EXACT_TVM_INVALID_SEQNO,
    ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC,
    ERR_EXACT_TVM_INVALID_SIGNATURE,
    ERR_EXACT_TVM_INVALID_SIGNATURE_MODE,
    ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED,
    ERR_EXACT_TVM_INVALID_W5_ACTIONS,
    ERR_EXACT_TVM_INVALID_W5_MESSAGE,
    ERR_EXACT_TVM_INVALID_WALLET_ID,
    ERR_EXACT_TVM_NETWORK_MISMATCH,
    ERR_EXACT_TVM_SIMULATION_FAILED,
    ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH,
    ERR_EXACT_TVM_TRANSACTION_FAILED,
    ERR_EXACT_TVM_UNSUPPORTED_NETWORK,
    ERR_EXACT_TVM_UNSUPPORTED_SCHEME,
    ERR_EXACT_TVM_UNSUPPORTED_VERSION,
    ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR,
)


def test_should_export_canonical_tvm_error_constants() -> None:
    assert ERR_EXACT_TVM_UNSUPPORTED_SCHEME == "unsupported_scheme"
    assert ERR_EXACT_TVM_UNSUPPORTED_VERSION == "unsupported_version"
    assert ERR_EXACT_TVM_UNSUPPORTED_NETWORK == "unsupported_network"
    assert ERR_EXACT_TVM_NETWORK_MISMATCH == "network_mismatch"
    assert ERR_EXACT_TVM_INVALID_PAYLOAD == "invalid_exact_tvm_payload"
    assert ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC == "invalid_exact_tvm_payload_settlement_boc"
    assert (
        ERR_EXACT_TVM_INVALID_W5_MESSAGE == "invalid_exact_tvm_payload_w5_internal_signed_request"
    )
    assert ERR_EXACT_TVM_INVALID_W5_ACTIONS == "invalid_exact_tvm_payload_w5_actions"
    assert ERR_EXACT_TVM_INVALID_JETTON_TRANSFER == "invalid_exact_tvm_payload_jetton_transfer"
    assert ERR_EXACT_TVM_INVALID_SIGNATURE == "invalid_exact_tvm_payload_invalid_signature"
    assert ERR_EXACT_TVM_INVALID_CODE_HASH == "invalid_exact_tvm_payload_invalid_code_hash"
    assert ERR_EXACT_TVM_INVALID_ASSET == "invalid_exact_tvm_payload_asset_mismatch"
    assert ERR_EXACT_TVM_INVALID_RECIPIENT == "invalid_exact_tvm_payload_recipient_mismatch"
    assert ERR_EXACT_TVM_INVALID_AMOUNT == "invalid_exact_tvm_payload_amount_mismatch"
    assert (
        ERR_EXACT_TVM_INVALID_SIGNATURE_MODE == "invalid_exact_tvm_payload_signature_mode_mismatch"
    )
    assert ERR_EXACT_TVM_INVALID_SEQNO == "invalid_exact_tvm_payload_seqno_mismatch"
    assert ERR_EXACT_TVM_INVALID_WALLET_ID == "invalid_exact_tvm_payload_wallet_id_mismatch"
    assert (
        ERR_EXACT_TVM_INVALID_EXTENSIONS_DICT
        == "invalid_exact_tvm_payload_extensions_dict_mismatch"
    )
    assert (
        ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH
        == "invalid_exact_tvm_payload_attached_ton_amount_too_high"
    )
    assert ERR_EXACT_TVM_ACCOUNT_FROZEN == "account_frozen"
    assert ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED == "invalid_exact_tvm_payload_valid_until_expired"
    assert ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR == "invalid_exact_tvm_payload_valid_until_too_far"
    assert ERR_EXACT_TVM_INSUFFICIENT_BALANCE == "insufficient_balance"
    assert ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE == "facilitator_insufficient_balance"
    assert ERR_EXACT_TVM_DUPLICATE_SETTLEMENT == "duplicate_settlement"
    assert ERR_EXACT_TVM_SIMULATION_FAILED == "simulation_failed"
    assert ERR_EXACT_TVM_TRANSACTION_FAILED == "transaction_failed"
