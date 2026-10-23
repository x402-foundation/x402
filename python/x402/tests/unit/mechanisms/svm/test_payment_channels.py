"""Wire goldens and signer/account boundaries for canonical payment channels."""

import base64
import json
import struct
from pathlib import Path

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import to_bytes_versioned
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm.constants import (
    SOLANA_DEVNET_CAIP2,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    USDC_MAINNET_ADDRESS,
)
from x402.mechanisms.svm.payment_channels import (
    PAYMENT_CHANNELS_PROGRAM_ID,
    ChannelSplit,
    ChannelStatus,
    SettleVoucher,
    build_distribute_instruction,
    build_ed25519_verify_instruction,
    build_open_instruction,
    build_open_transaction,
    build_reclaim_instruction,
    build_request_close_instruction,
    build_seal_instruction,
    build_settle_and_seal_instructions,
    build_settle_instructions,
    build_top_up_instruction,
    build_withdraw_payer_instruction,
    decode_channel_account,
    distribution_hash,
    encode_voucher_message,
    find_ata,
    find_payment_channel_pda,
    sign_voucher,
    verify_voucher,
)
from x402.mechanisms.svm.signers import KeypairSigner

PAYER = Keypair.from_seed(bytes(range(32)))
KEYS = [str(Pubkey.from_bytes(bytes([i]) * 32)) for i in range(1, 7)]


def open_args():
    return {
        "payer": str(PAYER.pubkey()),
        "rent_payer": KEYS[0],
        "payee": KEYS[0],
        "mint": KEYS[1],
        "authorized_signer": KEYS[2],
        "token_program": TOKEN_PROGRAM_ADDRESS,
        "deposit": 123_456,
        "salt": 7,
        "open_slot": 999,
        "grace_period": 900,
        "recipients": [ChannelSplit(KEYS[3], 10_000)],
    }


def test_cross_language_voucher_and_distribution_goldens():
    # Pinned by Go generated_wire_test.go and the TypeScript SDK.
    assert encode_voucher_message(USDC_MAINNET_ADDRESS, 1_000_000, 4_102_444_800).hex() == (
        "5601c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61"
        "40420f0000000000005786f400000000"
    )
    assert distribution_hash([ChannelSplit(KEYS[0], 7500), ChannelSplit(KEYS[1], 2500)]).hex() == (
        "54c8975587750e8821e93f5d4af607d20d55a58ba1b9a4b49f72a542ed874a3f"
    )


def test_vouchers_bind_channel_amount_deadline_and_authorizer():
    signature = sign_voucher(KeypairSigner(PAYER), KEYS[0], 42)
    assert verify_voucher(signature, str(PAYER.pubkey()), KEYS[0], 42)
    assert not verify_voucher(signature, str(PAYER.pubkey()), KEYS[1], 42)
    assert not verify_voucher(signature, str(PAYER.pubkey()), KEYS[0], 43)
    assert not verify_voucher(signature, str(PAYER.pubkey()), KEYS[0], 42, 1)
    assert not verify_voucher(signature, KEYS[1], KEYS[0], 42)
    assert not verify_voucher("invalid", str(PAYER.pubkey()), KEYS[0], 42)


@pytest.mark.parametrize("value", [-1, 2**64, True, 1.0])
def test_reject_out_of_range_voucher_amount(value):
    with pytest.raises(ValueError):
        encode_voucher_message(KEYS[0], value)


def test_channel_layout_and_unsupported_account_rejection():
    data = bytearray(256)
    data[:4] = bytes([1, 1, 254, 2])
    struct.pack_into("<QQQQqqI", data, 4, 7, 10000, 1858, 1500, 100, -1, 900)
    data[56:88] = bytes(range(32))
    for i, key in enumerate(KEYS[:5]):
        data[88 + i * 32 : 120 + i * 32] = bytes(Pubkey.from_string(key))
    struct.pack_into("<Q", data, 248, 341_000_000)
    channel = decode_channel_account(bytes(data))
    assert (
        channel.status,
        channel.salt,
        channel.deposit,
        channel.settled,
        channel.payout_watermark,
    ) == (ChannelStatus.CLOSING, 7, 10000, 1858, 1500)
    assert (channel.closure_started_at, channel.payer_withdrawn_at, channel.grace_period) == (
        100,
        -1,
        900,
    )
    assert channel.distribution_hash == bytes(range(32))
    assert [
        channel.payer,
        channel.payee,
        channel.authorized_signer,
        channel.mint,
        channel.rent_payer,
    ] == KEYS[:5]
    assert (channel.open_slot, channel.bump) == (341_000_000, 254)
    for malformed in (
        data[:-1],
        data + b"\0",
        bytes([2]) + data[1:],
        data[:1] + bytes([9]) + data[2:],
        data[:3] + bytes([4]) + data[4:],
    ):
        with pytest.raises(ValueError):
            decode_channel_account(bytes(malformed))


def test_builders_match_every_idl_account_privilege_and_discriminator():
    root = next(p for p in Path(__file__).parents if (p / "typescript").is_dir())
    idl = json.loads(
        (root / "typescript/packages/mechanisms/svm/idl/payment-channels.json").read_text()
    )
    by_name = {item["name"]: item for item in idl["program"]["instructions"]}
    voucher = SettleVoucher(str(PAYER.pubkey()), sign_voucher(PAYER, KEYS[0], 7), 7)
    built = {
        "open": build_open_instruction(**open_args()),
        "topUp": build_top_up_instruction(
            payer=KEYS[1],
            channel_id=KEYS[0],
            mint=KEYS[2],
            token_program=TOKEN_PROGRAM_ADDRESS,
            amount=9,
        ),
        "requestClose": build_request_close_instruction(payer=KEYS[1], channel_id=KEYS[0]),
        "settle": build_settle_instructions(KEYS[0], voucher)[1],
        "settleAndSeal": build_settle_and_seal_instructions(KEYS[0], KEYS[1], voucher)[1],
        "seal": build_seal_instruction(KEYS[0]),
        "distribute": build_distribute_instruction(
            channel_id=KEYS[0],
            payee=KEYS[1],
            payer=KEYS[2],
            rent_payer=KEYS[3],
            mint=KEYS[4],
            token_program=TOKEN_PROGRAM_ADDRESS,
            splits=[],
            network=SOLANA_DEVNET_CAIP2,
        ),
        "withdrawPayer": build_withdraw_payer_instruction(
            channel_id=KEYS[0], payer=KEYS[1], mint=KEYS[2], token_program=TOKEN_PROGRAM_ADDRESS
        ),
        "reclaim": build_reclaim_instruction(KEYS[0], KEYS[1]),
    }
    for name, instruction in built.items():
        spec = by_name[name]
        assert str(instruction.program_id) == PAYMENT_CHANNELS_PROGRAM_ID
        assert [(a.is_writable, a.is_signer) for a in instruction.accounts] == [
            (a["isWritable"], a["isSigner"]) for a in spec["accounts"]
        ], name
        assert instruction.data[0] == spec["arguments"][0]["defaultValue"]["number"], name
    assert built["open"].data == (
        b"\x01"
        + struct.pack("<QQIQI", 7, 123456, 900, 999, 1)
        + bytes(Pubkey.from_string(KEYS[3]))
        + struct.pack("<H", 10000)
    )
    assert built["topUp"].data == b"\x03" + struct.pack("<Q", 9)
    assert built["settleAndSeal"].data == b"\x04\x01"
    assert build_settle_and_seal_instructions(KEYS[0], KEYS[1])[0].data == b"\x04\x00"


def test_ed25519_offsets_reference_same_instruction_and_canonical_message():
    message = encode_voucher_message(KEYS[0], 42)
    signature = PAYER.sign_message(message)
    instruction = build_ed25519_verify_instruction(message, bytes(signature), bytes(PAYER.pubkey()))
    assert instruction.accounts == []
    assert struct.unpack_from("<BB7H", instruction.data) == (
        1,
        0,
        48,
        65535,
        16,
        65535,
        112,
        50,
        65535,
    )
    assert Signature.from_bytes(instruction.data[48:112]).verify(
        Pubkey.from_bytes(instruction.data[16:48]), instruction.data[112:]
    )
    with pytest.raises(ValueError):
        build_ed25519_verify_instruction(message, bytes(63), bytes(PAYER.pubkey()))


def test_pda_seeds_and_token_program_bind_escrow():
    params = {
        key: value
        for key, value in open_args().items()
        if key in ("payer", "payee", "mint", "authorized_signer", "salt", "open_slot")
    }
    channel = find_payment_channel_pda(**params)
    expected, _ = Pubkey.find_program_address(
        [
            b"channel",
            bytes(PAYER.pubkey()),
            bytes(Pubkey.from_string(KEYS[0])),
            bytes(Pubkey.from_string(KEYS[1])),
            bytes(Pubkey.from_string(KEYS[2])),
            bytes.fromhex("0700000000000000"),
            bytes.fromhex("e703000000000000"),
        ],
        Pubkey.from_string(PAYMENT_CHANNELS_PROGRAM_ID),
    )
    assert channel == str(expected)
    assert find_payment_channel_pda(**{**params, "open_slot": 1000}) != channel
    assert find_ata(channel, KEYS[1], TOKEN_PROGRAM_ADDRESS) != find_ata(
        channel, KEYS[1], TOKEN_2022_PROGRAM_ADDRESS
    )


def test_open_transaction_leaves_only_sponsor_unsigned():
    args = open_args()
    args.pop("rent_payer")
    args["payer"] = KeypairSigner(PAYER)
    encoded = build_open_transaction(
        **args, fee_payer=KEYS[0], blockhash=str(Hash.default()), binding_memo="binding"
    )
    transaction = VersionedTransaction.from_bytes(base64.b64decode(encoded))
    message = transaction.message
    assert message.header.num_required_signatures == 2
    assert str(message.account_keys[0]) == KEYS[0]
    assert transaction.signatures[0] == Signature.default()
    assert transaction.signatures[1].verify(PAYER.pubkey(), to_bytes_versioned(message))
    assert not message.address_table_lookups
    assert bytes(message.instructions[-1].data) == b"binding"
    with pytest.raises(ValueError, match="compute budget"):
        build_open_transaction(
            **args, fee_payer=KEYS[0], blockhash=str(Hash.default()), compute_unit_limit=400001
        )
