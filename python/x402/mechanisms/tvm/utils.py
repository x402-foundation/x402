"""Backward-compatible TVM utility facade.

This module keeps the historical import surface while the actual codec logic
is split across ``tvm.codecs`` and ``tvm.exact.codec``.
"""

from __future__ import annotations

try:
    from pytoniq_core.crypto.signature import verify_sign
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e

from .codecs.common import (
    address_to_stack_item,
    get_network_global_id,
    normalize_address,
    parse_amount,
    parse_money_to_decimal,
)
from .codecs.jetton import (
    build_jetton_transfer_body,
    build_jetton_transfer_body_fields,
    parse_jetton_transfer,
)
from .codecs.w5 import (
    address_from_state_init,
    build_w5_signed_body,
    build_w5r1_state_init,
    get_w5_seqno,
    make_w5r1_wallet_id,
    parse_active_w5_account_state,
    parse_out_list,
    parse_w5_init_data,
    serialize_out_list,
    serialize_send_msg_action,
    verify_w5_signature,
)
from .exact.codec import parse_exact_tvm_payload

__all__ = [
    "address_from_state_init",
    "address_to_stack_item",
    "build_jetton_transfer_body",
    "build_jetton_transfer_body_fields",
    "build_w5_signed_body",
    "build_w5r1_state_init",
    "get_network_global_id",
    "get_w5_seqno",
    "make_w5r1_wallet_id",
    "normalize_address",
    "parse_active_w5_account_state",
    "parse_amount",
    "parse_exact_tvm_payload",
    "parse_jetton_transfer",
    "parse_money_to_decimal",
    "parse_out_list",
    "parse_w5_init_data",
    "serialize_out_list",
    "serialize_send_msg_action",
    "verify_sign",
    "verify_w5_signature",
]
