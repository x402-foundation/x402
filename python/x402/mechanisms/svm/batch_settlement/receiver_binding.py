"""Read the receiver-authorizer commitment covered by a channel open signature."""

import base64

from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from ..constants import MEMO_PROGRAM_ADDRESS
from ..payment_channels import OPEN_DISCRIMINATOR, PAYMENT_CHANNELS_PROGRAM_ID

RECEIVER_BINDING_MEMO_PREFIX = "x402:batch-settlement:svm:rcvauth:v1:"


def encode_receiver_binding_memo(authorizer: str) -> str:
    Pubkey.from_string(authorizer)
    return RECEIVER_BINDING_MEMO_PREFIX + authorizer


def parse_receiver_binding_memo(memo: str) -> str | None:
    if not memo.startswith(RECEIVER_BINDING_MEMO_PREFIX):
        return None
    try:
        key = memo[len(RECEIVER_BINDING_MEMO_PREFIX) :]
        return str(Pubkey.from_string(key))
    except ValueError:
        return None


def read_receiver_binding_from_open(wire_transaction: str, channel_id: str) -> str | None:
    try:
        wire = base64.b64decode(wire_transaction, validate=True)
        transaction = VersionedTransaction.from_bytes(wire)
        transaction.sanitize()
        if bytes(transaction) != wire:
            return None
        message = transaction.message
        if getattr(message, "address_table_lookups", []):
            return None
        keys = message.account_keys
        opens = [
            ix
            for ix in message.instructions
            if str(keys[ix.program_id_index]) == PAYMENT_CHANNELS_PROGRAM_ID
            and ix.data[:1] == bytes([OPEN_DISCRIMINATOR])
        ]
        if (
            len(opens) != 1
            or len(opens[0].accounts) != 14
            or str(keys[opens[0].accounts[5]]) != channel_id
        ):
            return None
        bindings = []
        for ix in message.instructions:
            if str(keys[ix.program_id_index]) != MEMO_PROGRAM_ADDRESS:
                continue
            memo = bytes(ix.data).decode("utf-8")
            if memo.startswith(RECEIVER_BINDING_MEMO_PREFIX):
                bindings.append(parse_receiver_binding_memo(memo))
        return bindings[0] if len(bindings) == 1 else None
    except (ValueError, TypeError, IndexError, UnicodeError):
        return None
