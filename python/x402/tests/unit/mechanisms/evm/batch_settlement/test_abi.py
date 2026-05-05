"""ABI shape tests for batch-settlement.

Verifies that ``batch_settlement_abi`` exposes the same function and event
names as the TypeScript SDK (``abi.ts``), and that the helper component
``_voucher_claim_components`` is module-private.
"""

try:
    from eth_utils import is_checksum_address  # type: ignore[attr-defined]  # noqa: F401
except ImportError:
    import pytest

    pytest.skip("batch_settlement requires eth_utils", allow_module_level=True)

from x402.mechanisms.evm import batch_settlement
from x402.mechanisms.evm.batch_settlement import (
    batch_settlement_abi,
    channel_config_components,
    erc20_balance_of_abi,
)

EXPECTED_FUNCTIONS = [
    "multicall",
    "deposit",
    "claim",
    "claimWithSignature",
    "settle",
    "initiateWithdraw",
    "finalizeWithdraw",
    "refund",
    "refundWithSignature",
    "getChannelId",
    "CHANNEL_CONFIG_TYPEHASH",
    "channels",
    "pendingWithdrawals",
    "receivers",
    "getVoucherDigest",
    "getRefundDigest",
    "refundNonce",
    "getClaimBatchDigest",
]

EXPECTED_EVENTS = ["Settled"]


def _names_by_kind(kind: str) -> list[str]:
    return [item["name"] for item in batch_settlement_abi if item.get("type") == kind]


def test_function_names_match_ts() -> None:
    assert _names_by_kind("function") == EXPECTED_FUNCTIONS


def test_event_names_match_ts() -> None:
    assert _names_by_kind("event") == EXPECTED_EVENTS


def test_settled_event_indexed_topics() -> None:
    """Settled is indexed on (receiver, token, sender); amount is non-indexed (D6 / EIP-712 follow-on)."""
    settled = next(item for item in batch_settlement_abi if item.get("name") == "Settled")
    indexed = [(f["name"], f["indexed"]) for f in settled["inputs"]]
    assert indexed == [
        ("receiver", True),
        ("token", True),
        ("sender", True),
        ("amount", False),
    ]


def test_channel_config_components_field_order() -> None:
    """Components list is shared with EIP-712 ChannelConfig; order is normative."""
    assert [c["name"] for c in channel_config_components] == [
        "payer",
        "payerAuthorizer",
        "receiver",
        "receiverAuthorizer",
        "token",
        "withdrawDelay",
        "salt",
    ]


def test_erc20_balance_of_signature() -> None:
    assert erc20_balance_of_abi == [
        {
            "type": "function",
            "name": "balanceOf",
            "inputs": [{"name": "account", "type": "address"}],
            "outputs": [{"name": "", "type": "uint256"}],
            "stateMutability": "view",
        },
    ]


def test_voucher_claim_components_is_private() -> None:
    """``_voucher_claim_components`` is an internal helper; not part of the public surface."""
    assert "_voucher_claim_components" not in batch_settlement.__all__
    assert not hasattr(batch_settlement, "voucher_claim_components")


def test_deposit_collector_data_is_opaque_bytes() -> None:
    """deposit's collectorData is intentionally ``bytes`` (collector-specific encoding, D5)."""
    deposit = next(item for item in batch_settlement_abi if item.get("name") == "deposit")
    collector_data = next(i for i in deposit["inputs"] if i["name"] == "collectorData")
    assert collector_data["type"] == "bytes"
