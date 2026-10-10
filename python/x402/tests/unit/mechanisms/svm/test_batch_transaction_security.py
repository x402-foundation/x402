"""Reject sponsor abuse across the complete signed transaction message."""

import base64
import hashlib
import struct

import pytest
from solders.address_lookup_table_account import AddressLookupTableAccount
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import MessageV0, to_bytes_versioned
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm.batch_settlement.close_authorization import (
    encode_close_authorization_digest,
    sign_close_authorization,
    verify_close_authorization,
)
from x402.mechanisms.svm.batch_settlement.receiver_binding import (
    encode_receiver_binding_memo,
    read_receiver_binding_from_open,
)
from x402.mechanisms.svm.constants import (
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MEMO_PROGRAM_ADDRESS,
    SOLANA_DEVNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
)
from x402.mechanisms.svm.payment_channels import (
    OPEN_MAX_COMPUTE_UNIT_LIMIT,
    PAYMENT_CHANNELS_PROGRAM_ID,
    ChannelSplit,
    build_open_instruction,
    build_request_close_transaction,
    build_top_up_transaction,
    compile_transaction,
    find_payment_channel_pda,
)
from x402.mechanisms.svm.payment_channels.verification import (
    verify_open_transaction,
    verify_request_close_transaction,
    verify_top_up_transaction,
)

PAYER, SPONSOR, RECEIVER, AUTHOR, OTHER = [Keypair.from_seed(bytes([i] * 32)) for i in range(1, 6)]
FEE = str(SPONSOR.pubkey())
BLOCKHASH = str(Hash.from_bytes(bytes([9] * 32)))
CONFIG = {
    "payer": str(PAYER.pubkey()),
    "payerAuthorizer": str(PAYER.pubkey()),
    "receiver": str(RECEIVER.pubkey()),
    "receiverAuthorizer": str(AUTHOR.pubkey()),
    "token": USDC_DEVNET_ADDRESS,
    "withdrawDelay": 900,
    "salt": "0",
    "openSlot": 42,
}
CHANNEL = find_payment_channel_pda(
    payer=CONFIG["payer"],
    payee=FEE,
    mint=CONFIG["token"],
    authorized_signer=CONFIG["payerAuthorizer"],
    salt=0,
    open_slot=42,
)


def memo(data, accounts=()):
    return Instruction(Pubkey.from_string(MEMO_PROGRAM_ADDRESS), data.encode(), list(accounts))


def open_parts():
    return [
        set_compute_unit_limit(200000),
        set_compute_unit_price(1),
        build_open_instruction(
            payer=CONFIG["payer"],
            rent_payer=FEE,
            payee=FEE,
            mint=CONFIG["token"],
            authorized_signer=CONFIG["payerAuthorizer"],
            token_program=TOKEN_PROGRAM_ADDRESS,
            deposit=30,
            salt=0,
            open_slot=42,
            grace_period=900,
            recipients=[ChannelSplit(CONFIG["receiver"], 10_000)],
        ),
        memo("invoice"),
        memo(encode_receiver_binding_memo(CONFIG["receiverAuthorizer"])),
    ]


def wire(parts):
    return base64.b64encode(
        bytes(compile_transaction(parts, fee_payer=FEE, blockhash=BLOCKHASH, signers=[PAYER]))
    ).decode()


def verify(value, **overrides):
    args = {
        "channel_config": CONFIG,
        "fee_payer": FEE,
        "token_program": TOKEN_PROGRAM_ADDRESS,
        "deposit": 30,
        "memo": "invoice",
        "current_slot": 42,
    }
    args.update(overrides)
    return verify_open_transaction(value, **args)


def test_canonical_open_topup_close_and_receiver_binding():
    opened = wire(open_parts())
    assert verify(opened).verify_with_results() == [False, True]
    assert read_receiver_binding_from_open(opened, CHANNEL) == CONFIG["receiverAuthorizer"]
    assert read_receiver_binding_from_open(opened, str(OTHER.pubkey())) is None
    topped = build_top_up_transaction(
        payer=PAYER,
        channel_id=CHANNEL,
        mint=CONFIG["token"],
        token_program=TOKEN_PROGRAM_ADDRESS,
        fee_payer=FEE,
        amount=10,
        blockhash=BLOCKHASH,
        memo="invoice",
    )
    assert verify_top_up_transaction(
        topped,
        channel_id=CHANNEL,
        channel_config=CONFIG,
        fee_payer=FEE,
        token_program=TOKEN_PROGRAM_ADDRESS,
        amount=10,
        memo="invoice",
    )
    with pytest.raises(ValueError):
        verify_top_up_transaction(
            topped,
            channel_id=CHANNEL,
            channel_config=CONFIG,
            fee_payer=FEE,
            token_program=TOKEN_PROGRAM_ADDRESS,
            amount=11,
            memo="invoice",
        )
    closed = build_request_close_transaction(
        payer=PAYER, channel_id=CHANNEL, fee_payer=FEE, blockhash=BLOCKHASH
    )
    assert verify_request_close_transaction(
        closed, payer=CONFIG["payer"], channel_id=CHANNEL, fee_payer=FEE
    )


@pytest.mark.parametrize(
    "attack",
    [
        "transfer",
        "suffix",
        "limit",
        "price",
        "writable",
        "signer",
        "binding",
        "duplicate_binding",
        "memo",
        "compute_suffix",
        "deposit",
        "slot",
        "trailing",
        "payer_signature",
        "alt",
    ],
)
def test_open_rejects_message_level_sponsor_attacks(attack):
    parts = open_parts()
    overrides = {}
    if attack == "transfer":
        parts.append(
            transfer(
                TransferParams(from_pubkey=SPONSOR.pubkey(), to_pubkey=OTHER.pubkey(), lamports=1)
            )
        )
    elif attack == "suffix":
        parts.append(Instruction(OTHER.pubkey(), b"do something", []))
    elif attack == "limit":
        parts[0] = set_compute_unit_limit(OPEN_MAX_COMPUTE_UNIT_LIMIT + 1)
    elif attack == "price":
        parts[1] = set_compute_unit_price(MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS + 1)
    elif attack == "writable":
        parts[3] = memo(
            "invoice", [AccountMeta(Pubkey.from_string(USDC_DEVNET_ADDRESS), False, True)]
        )
    elif attack == "signer":
        parts[3] = memo("invoice", [AccountMeta(OTHER.pubkey(), True, False)])
    elif attack == "binding":
        parts[-1] = memo(encode_receiver_binding_memo(str(OTHER.pubkey())))
    elif attack == "duplicate_binding":
        parts.append(parts[-1])
    elif attack == "memo":
        parts[3] = memo("another invoice")
    elif attack == "compute_suffix":
        parts.append(set_compute_unit_price(1))
    elif attack == "deposit":
        overrides["deposit"] = 31
    elif attack == "slot":
        overrides["current_slot"] = 41
    raw = wire(parts)
    if attack == "trailing":
        raw = base64.b64encode(base64.b64decode(raw) + b"ignored").decode()
    elif attack == "payer_signature":
        decoded = VersionedTransaction.from_bytes(base64.b64decode(raw))
        raw = base64.b64encode(
            bytes(
                VersionedTransaction.populate(
                    decoded.message, [Signature.default(), Signature.default()]
                )
            )
        ).decode()
    elif attack == "alt":
        table = AddressLookupTableAccount(OTHER.pubkey(), [Pubkey.from_string(USDC_DEVNET_ADDRESS)])
        message = MessageV0.try_compile(
            SPONSOR.pubkey(), parts, [table], Hash.from_string(BLOCKHASH)
        )
        assert message.address_table_lookups
        tx = VersionedTransaction.populate(
            message, [Signature.default(), PAYER.sign_message(to_bytes_versioned(message))]
        )
        raw = base64.b64encode(bytes(tx)).decode()
    with pytest.raises(ValueError):
        verify(raw, **overrides)


def test_receiver_binding_rejects_missing_duplicate_or_malformed_memos():
    parts = open_parts()
    assert read_receiver_binding_from_open(wire(parts[:-1]), CHANNEL) is None
    assert read_receiver_binding_from_open(wire(parts + [parts[-1]]), CHANNEL) is None
    parts[-1] = memo("x402:batch-settlement:svm:rcvauth:v1:not-a-key")
    assert read_receiver_binding_from_open(wire(parts), CHANNEL) is None
    assert read_receiver_binding_from_open("not base64", CHANNEL) is None


def close_binding():
    return {
        "network": SOLANA_DEVNET_CAIP2,
        "fee_payer": FEE,
        "channel_id": CHANNEL,
        "max_claimable_amount": 10,
        "voucher_expires_at": 0,
    }


def test_close_digest_exact_layout_and_domain_separation():
    binding = close_binding()
    network = SOLANA_DEVNET_CAIP2.encode()
    expected = hashlib.sha256(
        b"x402:batch-settlement:svm:close:v1\0"
        + struct.pack("<H", len(network))
        + network
        + bytes(Pubkey.from_string(PAYMENT_CHANNELS_PROGRAM_ID))
        + bytes(SPONSOR.pubkey())
        + bytes(Pubkey.from_string(CHANNEL))
        + struct.pack("<Qqq", 10, 0, 100)
    ).digest()
    assert encode_close_authorization_digest(**binding, valid_before=100) == expected
    authorization = sign_close_authorization(AUTHOR, **binding, valid_before=100)
    assert authorization["signature"] == str(AUTHOR.sign_message(expected))
    assert verify_close_authorization(
        authorization,
        receiver_authorizer=str(AUTHOR.pubkey()),
        now_seconds=50,
        max_timeout_seconds=60,
        **binding,
    )
    assert not verify_close_authorization(
        authorization,
        receiver_authorizer=str(AUTHOR.pubkey()),
        now_seconds=100,
        max_timeout_seconds=60,
        **binding,
    )
    assert not verify_close_authorization(
        authorization,
        receiver_authorizer=str(AUTHOR.pubkey()),
        now_seconds=1,
        max_timeout_seconds=60,
        **binding,
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("network", "solana:other"),
        ("fee_payer", str(OTHER.pubkey())),
        ("channel_id", str(OTHER.pubkey())),
        ("max_claimable_amount", 11),
        ("voucher_expires_at", 1),
        ("program_id", str(OTHER.pubkey())),
    ],
)
def test_close_authorization_binds_every_cooperative_close_field(field, value):
    binding = close_binding()
    authorization = sign_close_authorization(AUTHOR, **binding, valid_before=100)
    binding[field] = value
    assert not verify_close_authorization(
        authorization,
        receiver_authorizer=str(AUTHOR.pubkey()),
        now_seconds=50,
        max_timeout_seconds=60,
        **binding,
    )
