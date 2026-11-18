"""Wallet V5 R1 codecs and state decoding helpers."""

from __future__ import annotations

from collections.abc import Callable

from pytoniq_core import TransactionError

from ..constants import (
    ALLOWED_CLIENT_CODES,
    ERR_EXACT_TVM_INVALID_W5_ACTIONS,
    ERR_EXACT_TVM_INVALID_W5_MESSAGE,
    SEND_MODE_IGNORE_ERRORS,
    SEND_MODE_PAY_FEES_SEPARATELY,
    W5R1_CODE_HEX,
)
from ..types import TvmAccountState, W5InitData
from .common import get_network_global_id, normalize_address

try:
    from pytoniq_core import Address, Cell, begin_cell
    from pytoniq_core.crypto.signature import verify_sign
    from pytoniq_core.tlb.account import StateInit
    from pytoniq_core.tlb.transaction import OutAction
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


def make_w5r1_wallet_id(network: str, workchain: int = 0, subwallet_number: int = 0) -> int:
    """Build the unsigned W5R1 wallet_id for a client wallet."""
    network_global_id = get_network_global_id(network)
    context = (
        begin_cell()
        .store_uint(1, 1)
        .store_int(workchain, 8)
        .store_uint(0, 8)
        .store_uint(subwallet_number, 15)
        .end_cell()
        .begin_parse()
        .load_int(32)
    )
    return ((network_global_id & 0xFFFFFFFF) ^ (context & 0xFFFFFFFF)) & 0xFFFFFFFF


def address_from_state_init(state_init: StateInit, workchain: int) -> str:
    """Compute the contract address derived from ``state_init``."""
    return normalize_address(Address((workchain, state_init.serialize().hash)))


def build_w5r1_state_init(public_key: bytes, wallet_id: int) -> StateInit:
    """Build a W5R1 wallet StateInit for a client wallet."""
    code = Cell.one_from_boc(bytes.fromhex(W5R1_CODE_HEX))

    data = (
        begin_cell()
        .store_uint(1, 1)
        .store_uint(0, 32)
        .store_uint(wallet_id, 32)
        .store_bytes(public_key)
        .store_bit(0)
        .end_cell()
    )
    return StateInit(code=code, data=data)


def parse_w5_init_data(state_init: StateInit) -> W5InitData:
    """Extract W5 wallet fields from StateInit data."""
    if state_init.data is None:
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_MESSAGE)
    data = state_init.data.begin_parse()
    result = W5InitData(
        signature_allowed=data.load_bit(),
        seqno=data.load_uint(32),
        wallet_id=data.load_uint(32),
        public_key=data.load_bytes(32),
        extensions_dict=data.load_maybe_ref(),
    )
    if data.remaining_bits or data.remaining_refs:
        raise ValueError(ERR_EXACT_TVM_INVALID_W5_MESSAGE)
    return result


def parse_active_w5_account_state(account_state: TvmAccountState) -> W5InitData:
    """Decode W5 state from an active account state."""
    if (
        not account_state.is_active
        or account_state.state_init is None
        or account_state.state_init.code is None
    ):
        raise RuntimeError(f"Account {account_state.address} does not have active W5 state")
    if account_state.state_init.code.hash.hex() not in ALLOWED_CLIENT_CODES:
        raise RuntimeError(f"Account {account_state.address} is not a W5R1 wallet")
    return parse_w5_init_data(account_state.state_init)


def get_w5_seqno(account_state: TvmAccountState) -> int:
    """Extract seqno from W5 account state, treating undeployed accounts as seqno=0."""
    if account_state.is_uninitialized:
        return 0
    return parse_active_w5_account_state(account_state).seqno


def parse_out_list(cell: Cell) -> list[OutAction]:
    """Parse a recursive OutList cell into actions."""
    cell_slice = cell.begin_parse()
    out_actions = []
    while cell_slice.remaining_bits or cell_slice.remaining_refs:
        n_bits = cell_slice.remaining_bits
        n_refs = cell_slice.remaining_refs
        if n_refs != 2 or n_bits != 32 + 8:
            raise ValueError(ERR_EXACT_TVM_INVALID_W5_ACTIONS)

        prev = cell_slice.load_ref().begin_parse()
        try:
            out_actions.append(OutAction.deserialize(cell_slice))
        except TransactionError as exc:
            raise ValueError(ERR_EXACT_TVM_INVALID_W5_ACTIONS) from exc
        cell_slice = prev

    return out_actions


def serialize_send_msg_action(
    message: Cell, mode: int = SEND_MODE_IGNORE_ERRORS + SEND_MODE_PAY_FEES_SEPARATELY
) -> Cell:
    """Serialize one action_send_msg item."""
    return begin_cell().store_uint(0x0EC3C86D, 32).store_uint(mode, 8).store_ref(message).end_cell()


def serialize_out_list(actions: list[Cell]) -> Cell:
    """Serialize a recursive OutList."""
    out_list = Cell.empty()
    for action in actions:
        out_list = begin_cell().store_ref(out_list).store_cell(action).end_cell()
    return out_list


def build_w5_signed_body(
    *,
    out_message: Cell,
    seqno: int,
    valid_until: int,
    sign_message: Callable[[bytes], bytes],
    wallet_id: int,
    opcode: int,
    send_mode: int = SEND_MODE_PAY_FEES_SEPARATELY,
) -> Cell:
    """Build and sign a W5 request body for a single outgoing message."""
    actions = serialize_out_list([serialize_send_msg_action(out_message, send_mode)])
    unsigned_body = (
        begin_cell()
        .store_uint(opcode, 32)
        .store_uint(wallet_id, 32)
        .store_uint(valid_until, 32)
        .store_uint(seqno, 32)
        .store_maybe_ref(actions)
        .store_bit(0)
        .end_cell()
    )
    signature = sign_message(unsigned_body.hash)
    return begin_cell().store_slice(unsigned_body.begin_parse()).store_bytes(signature).end_cell()


def verify_w5_signature(public_key: bytes, signed_slice_hash: bytes, signature: bytes) -> bool:
    """Verify a signed W5 request body."""
    return bool(verify_sign(public_key, signed_slice_hash, signature))
