"""Tests for parse_eip3009_transfer_error error classification."""

from __future__ import annotations

import pytest

from x402.mechanisms.evm.constants import (
    ERR_INSUFFICIENT_BALANCE,
    ERR_INVALID_SIGNATURE,
    ERR_NONCE_ALREADY_USED,
    ERR_RELAYER_INSUFFICIENT_FUNDS,
    ERR_TRANSACTION_FAILED,
    ERR_VALID_AFTER_FUTURE,
    ERR_VALID_BEFORE_EXPIRED,
)
from x402.mechanisms.evm.exact.eip3009_utils import parse_eip3009_transfer_error


@pytest.mark.parametrize(
    "msg",
    [
        "insufficient funds for gas * price + value",
        "err: insufficient funds for transfer: address 0x...",
        "exceeds the balance of the account",
        "insufficient balance for transaction",
        "Error: insufficient funds for gas * price + value: address 0xabc want 100 have 1",
    ],
)
def test_relayer_gas_exhaustion_classified(msg: str) -> None:
    assert parse_eip3009_transfer_error(Exception(msg)) == ERR_RELAYER_INSUFFICIENT_FUNDS


@pytest.mark.parametrize(
    "msg, want",
    [
        ("FiatTokenV2: authorization is expired", ERR_VALID_BEFORE_EXPIRED),
        ("execution reverted: AuthorizationExpired()", ERR_VALID_BEFORE_EXPIRED),
        ("authorization is not yet valid", ERR_VALID_AFTER_FUTURE),
        ("AuthorizationNotYetValid()", ERR_VALID_AFTER_FUTURE),
        ("FiatTokenV2: authorization is used", ERR_NONCE_ALREADY_USED),
        ("AuthorizationAlreadyUsed()", ERR_NONCE_ALREADY_USED),
        ("AuthorizationUsedOrCanceled()", ERR_NONCE_ALREADY_USED),
        ("ERC20: transfer amount exceeds balance", ERR_INSUFFICIENT_BALANCE),
        ("ERC20InsufficientBalance(0x..., 100, 200)", ERR_INSUFFICIENT_BALANCE),
        ("FiatTokenV2: invalid signature", ERR_INVALID_SIGNATURE),
        ("SignerMismatch()", ERR_INVALID_SIGNATURE),
        ("InvalidSignatureV()", ERR_INVALID_SIGNATURE),
        ("InvalidSignatureS()", ERR_INVALID_SIGNATURE),
    ],
)
def test_contract_revert_buckets(msg: str, want: str) -> None:
    assert parse_eip3009_transfer_error(Exception(msg)) == want


def test_payer_balance_error_not_classified_as_relayer_gas() -> None:
    msg = "ERC20: transfer amount exceeds balance"
    assert parse_eip3009_transfer_error(Exception(msg)) == ERR_INSUFFICIENT_BALANCE


def test_relayer_gas_not_classified_as_payer_balance() -> None:
    msg = "insufficient funds for gas * price + value"
    assert parse_eip3009_transfer_error(Exception(msg)) == ERR_RELAYER_INSUFFICIENT_FUNDS


def test_unknown_revert_falls_back_to_transaction_failed() -> None:
    assert (
        parse_eip3009_transfer_error(Exception("something nobody has ever seen"))
        == ERR_TRANSACTION_FAILED
    )
