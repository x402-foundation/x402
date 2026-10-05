"""Masumi deadline intervals and collateral required for later escrow spends."""

MASUMI_PAYMENT_SOURCE_TYPE = "Web3CardanoV2"
MASUMI_REGISTRY_POLICY_ID = "67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b"
MASUMI_MIN_COLLATERAL_LOVELACE = 1_435_230
MASUMI_MIN_PAY_TO_SUBMIT_MS = 5 * 60 * 1000
MASUMI_MIN_SUBMIT_TO_UNLOCK_MS = 15 * 60 * 1000
MASUMI_MIN_UNLOCK_TO_DISPUTE_MS = 15 * 60 * 1000
MASUMI_MIN_SUBMIT_RESULT_LEAD_MS = 15 * 60 * 1000
MASUMI_MAX_DEADLINE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000
MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE = 15_000_000


def masumi_deadline_intervals_hold(pay_by: int, submit: int, unlock: int, dispute: int) -> bool:
    return (
        pay_by + MASUMI_MIN_PAY_TO_SUBMIT_MS <= submit
        and submit + MASUMI_MIN_SUBMIT_TO_UNLOCK_MS <= unlock
        and unlock + MASUMI_MIN_UNLOCK_TO_DISPUTE_MS <= dispute
    )


def masumi_min_utxo_lovelace(
    lock_datum_bytes: int, native_token_count: int, coins_per_utxo_byte: int
) -> int:
    # Reserve space for result_hash and real cooldown timestamps after SubmitResult.
    return coins_per_utxo_byte * (
        lock_datum_bytes + 33 + 160 + 50 + 15 + 100 + 50 * native_token_count
    )


def masumi_collateral_lovelace(
    requested_lovelace: int,
    lock_datum_bytes: int,
    native_token_count: int,
    coins_per_utxo_byte: int,
) -> int:
    required = masumi_min_utxo_lovelace(lock_datum_bytes, native_token_count, coins_per_utxo_byte)
    return (
        0
        if requested_lovelace >= required
        else max(required - requested_lovelace, MASUMI_MIN_COLLATERAL_LOVELACE)
    )
