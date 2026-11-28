"""Path 1 layout: look-alike instructions, budget order, a missing transfer, and out-of-range indexes."""

import pytest
from solders.instruction import CompiledInstruction
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from x402.mechanisms.svm.constants import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ERR_FEE_PAYER_TRANSFERRING,
    ERR_INVALID_LIGHTHOUSE_INSTRUCTION,
    ERR_NO_TRANSFER_INSTRUCTION,
    ERR_PREFLIGHT_POSTFLIGHT_FEE_PAYER_NOT_ISOLATED,
    ERR_PROTOCOL_INSTRUCTION_ORDER,
    ERR_UNKNOWN_INSTRUCTION,
    LIGHTHOUSE_PROGRAM_ADDRESS,
    MEMO_PROGRAM_ADDRESS,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
)
from x402.mechanisms.svm.exact.instruction_layout import (
    InstructionIdentity,
    LayoutError,
    resolve_protocol_layout,
)

FEE_PAYER = Keypair().pubkey()
SETUP = Keypair().pubkey()
STATIC_ACCOUNTS = [
    FEE_PAYER,
    Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS),
    Pubkey.from_string(TOKEN_PROGRAM_ADDRESS),
    Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS),
    Pubkey.from_string(MEMO_PROGRAM_ADDRESS),
    Pubkey.from_string(LIGHTHOUSE_PROGRAM_ADDRESS),
    SETUP,
]
_COMPUTE, _TOKEN, _TOKEN_2022, _MEMO, _LIGHTHOUSE, _SETUP = range(1, 7)


def ix(program: int, data: bytes = b"", accounts: bytes = b"") -> CompiledInstruction:
    return CompiledInstruction(program, data, accounts)


LIMIT = ix(_COMPUTE, bytes([2, 0, 0, 0, 0]))
PRICE = ix(_COMPUTE, bytes([3]) + bytes(8))
TRANSFER = ix(_TOKEN, bytes([12]) + bytes(8) + bytes([6]))
GUARD = ix(_LIGHTHOUSE, bytes([2]))
PROTOCOL = [LIMIT, PRICE, TRANSFER]


def layout(instructions, preflight=(), postflight=()):
    return resolve_protocol_layout(
        STATIC_ACCOUNTS, instructions, list(preflight), list(postflight), FEE_PAYER
    )


def layout_error(instructions, preflight=(), postflight=()) -> str:
    with pytest.raises(LayoutError) as exc:
        layout(instructions, preflight, postflight)
    return exc.value.reason


def test_returns_each_protocol_instruction_and_the_first_memo():
    first_memo, second_memo = ix(_MEMO, b"first"), ix(_MEMO, b"second")

    result = layout([GUARD, LIMIT, GUARD, PRICE, TRANSFER, first_memo, GUARD, second_memo])

    assert result.compute_limit_ix == LIMIT
    assert result.compute_price_ix == PRICE
    assert result.transfer_ix == TRANSFER
    assert result.memo_ix == first_memo
    assert result.memo_count == 2


@pytest.mark.parametrize(
    "lookalike",
    [
        pytest.param(ix(_COMPUTE, bytes([9])), id="compute-budget-other-discriminator"),
        pytest.param(ix(_COMPUTE), id="compute-budget-no-data"),
        pytest.param(ix(_TOKEN, bytes([3]) + bytes(9)), id="token-transfer-not-checked"),
        pytest.param(ix(_TOKEN, bytes([12])), id="token-transfer-checked-truncated"),
        pytest.param(ix(_TOKEN_2022, bytes([12]) + bytes(8)), id="token-2022-truncated"),
    ],
)
def test_rejects_protocol_lookalikes_as_unknown(lookalike):
    assert layout_error([*PROTOCOL, lookalike]) == ERR_UNKNOWN_INSTRUCTION


def test_accepts_token_2022_transfer_checked():
    transfer = ix(_TOKEN_2022, bytes([12]) + bytes(8) + bytes([6]))

    assert layout([LIMIT, PRICE, transfer]).transfer_ix == transfer


@pytest.mark.parametrize(
    "instructions",
    [
        pytest.param([PRICE, LIMIT, TRANSFER], id="price-before-limit"),
        pytest.param([LIMIT, LIMIT, PRICE, TRANSFER], id="duplicate-limit"),
        pytest.param([LIMIT, PRICE, PRICE, TRANSFER], id="duplicate-price"),
        pytest.param([PRICE, TRANSFER], id="price-without-limit"),
        pytest.param([TRANSFER], id="transfer-without-compute-budget"),
        pytest.param([*PROTOCOL, ix(_MEMO, b"m"), TRANSFER], id="transfer-after-memo"),
    ],
)
def test_rejects_out_of_order_protocol_instructions(instructions):
    assert layout_error(instructions) == ERR_PROTOCOL_INSTRUCTION_ORDER


@pytest.mark.parametrize(
    "instructions",
    [
        pytest.param([], id="empty"),
        pytest.param([LIMIT, PRICE], id="compute-budget-only"),
        pytest.param([GUARD, GUARD], id="guards-only"),
    ],
)
def test_reports_a_missing_transfer(instructions):
    assert layout_error(instructions) == ERR_NO_TRANSFER_INSTRUCTION


def test_preflight_block_is_not_matched_after_the_protocol_instructions():
    setup = ix(_SETUP, b"\xaa")
    preflight = [[InstructionIdentity(SETUP, b"\xaa")]]

    assert layout_error([*PROTOCOL, setup], preflight=preflight) == ERR_UNKNOWN_INSTRUCTION
    assert layout([setup, *PROTOCOL], preflight=preflight).transfer_ix == TRANSFER


def test_rejects_a_program_index_outside_the_static_accounts():
    outside = ix(len(STATIC_ACCOUNTS))

    assert layout_error([*PROTOCOL, outside]) == ERR_UNKNOWN_INSTRUCTION


def test_isolation_ignores_lookup_table_accounts_in_an_allowlisted_block():
    lookup_table_index = len(STATIC_ACCOUNTS) + 3
    setup = ix(_SETUP, b"\xaa", bytes([lookup_table_index]))

    result = layout([setup, *PROTOCOL], preflight=[[InstructionIdentity(SETUP, b"\xaa")]])

    assert result.transfer_ix == TRANSFER


def guard_naming_fee_payer(discriminator: int) -> CompiledInstruction:
    return ix(_LIGHTHOUSE, bytes([discriminator]), bytes([0, _SETUP]))


def test_accepts_a_phantom_shaped_transaction_with_guards_naming_the_fee_payer():
    instructions = [
        GUARD,
        LIMIT,
        PRICE,
        guard_naming_fee_payer(5),
        TRANSFER,
        ix(_MEMO, b"memo"),
        guard_naming_fee_payer(2),
    ]

    assert layout(instructions).transfer_ix == TRANSFER


def test_rejects_a_guard_whose_program_is_the_fee_payer():
    with pytest.raises(LayoutError) as exc:
        resolve_protocol_layout(
            STATIC_ACCOUNTS,
            [GUARD, *PROTOCOL],
            [],
            [],
            Pubkey.from_string(LIGHTHOUSE_PROGRAM_ADDRESS),
        )

    assert exc.value.reason == ERR_FEE_PAYER_TRANSFERRING


@pytest.mark.parametrize("discriminator", [0, 1, 18, 255])
def test_still_rejects_a_non_assertion_lighthouse_instruction_naming_the_fee_payer(discriminator):
    instructions = [*PROTOCOL, guard_naming_fee_payer(discriminator)]

    assert layout_error(instructions) == ERR_INVALID_LIGHTHOUSE_INSTRUCTION


def test_still_rejects_a_non_guard_instruction_naming_the_fee_payer():
    setup = ix(_SETUP, b"\xaa", bytes([0]))
    preflight = [[InstructionIdentity(SETUP, b"\xaa")]]

    error = layout_error([guard_naming_fee_payer(2), setup, *PROTOCOL], preflight=preflight)

    assert error == ERR_PREFLIGHT_POSTFLIGHT_FEE_PAYER_NOT_ISOLATED
