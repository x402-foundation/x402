"""Sanity tests for batch-settlement constants.

Cross-language EIP-712 byte equivalence (Layer 2) lands in subsequent PRs
once the TypeScript-side fixture generator is in place. These tests cover
shape, ordering, and self-consistency only.
"""

try:
    from eth_utils import is_checksum_address, keccak  # type: ignore[attr-defined]
except ImportError:
    import pytest

    pytest.skip("batch_settlement requires eth_utils", allow_module_level=True)

import pytest

from x402.mechanisms.evm.batch_settlement import (
    BATCH_SETTLEMENT_ADDRESS,
    BATCH_SETTLEMENT_DOMAIN,
    BATCH_SETTLEMENT_SCHEME,
    CHANNEL_CONFIG_TYPEHASH,
    ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
    MAX_WITHDRAW_DELAY,
    MIN_WITHDRAW_DELAY,
    PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
    batch_permit2_witness_types,
    channel_config_types,
    claim_batch_types,
    receive_authorization_types,
    refund_types,
    voucher_types,
)


def test_scheme_identifier() -> None:
    assert BATCH_SETTLEMENT_SCHEME == "batch-settlement"


@pytest.mark.parametrize(
    "address",
    [
        BATCH_SETTLEMENT_ADDRESS,
        ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
        PERMIT2_DEPOSIT_COLLECTOR_ADDRESS,
    ],
)
def test_address_is_eip55_checksummed(address: str) -> None:
    assert is_checksum_address(address), f"{address} is not EIP-55 checksummed"


def test_withdraw_delay_window() -> None:
    assert MIN_WITHDRAW_DELAY == 900
    assert MAX_WITHDRAW_DELAY == 2_592_000
    assert MIN_WITHDRAW_DELAY < MAX_WITHDRAW_DELAY


def test_eip712_domain_shape() -> None:
    assert BATCH_SETTLEMENT_DOMAIN == {
        "name": "x402 Batch Settlement",
        "version": "1",
    }


def test_channel_config_typehash_matches_canonical_signature() -> None:
    canonical = (
        "ChannelConfig("
        "address payer,address payerAuthorizer,address receiver,"
        "address receiverAuthorizer,address token,"
        "uint40 withdrawDelay,bytes32 salt)"
    )
    assert CHANNEL_CONFIG_TYPEHASH == keccak(text=canonical)


def test_channel_config_types_field_order() -> None:
    fields = channel_config_types["ChannelConfig"]
    assert [f["name"] for f in fields] == [
        "payer",
        "payerAuthorizer",
        "receiver",
        "receiverAuthorizer",
        "token",
        "withdrawDelay",
        "salt",
    ]


def test_voucher_types_field_order() -> None:
    fields = voucher_types["Voucher"]
    assert [f["name"] for f in fields] == ["channelId", "maxClaimableAmount"]


def test_refund_types_field_order() -> None:
    fields = refund_types["Refund"]
    assert [f["name"] for f in fields] == ["channelId", "nonce", "amount"]


def test_claim_batch_types_nested_struct() -> None:
    assert claim_batch_types["ClaimBatch"] == [{"name": "claims", "type": "ClaimEntry[]"}]
    entry_fields = claim_batch_types["ClaimEntry"]
    assert [f["name"] for f in entry_fields] == [
        "channelId",
        "maxClaimableAmount",
        "totalClaimed",
    ]


def test_receive_authorization_types_field_order() -> None:
    """ERC-3009 ReceiveWithAuthorization field order is normative for D11 signatures."""
    fields = receive_authorization_types["ReceiveWithAuthorization"]
    assert [f["name"] for f in fields] == [
        "from",
        "to",
        "value",
        "validAfter",
        "validBefore",
        "nonce",
    ]


def test_batch_permit2_witness_types_nested_structs() -> None:
    """Permit2 deposit witness has three nested structs; nesting and order are normative."""
    permit_fields = batch_permit2_witness_types["PermitWitnessTransferFrom"]
    assert [f["name"] for f in permit_fields] == [
        "permitted",
        "spender",
        "nonce",
        "deadline",
        "witness",
    ]
    token_fields = batch_permit2_witness_types["TokenPermissions"]
    assert [f["name"] for f in token_fields] == ["token", "amount"]
    witness_fields = batch_permit2_witness_types["DepositWitness"]
    assert [f["name"] for f in witness_fields] == ["channelId"]
