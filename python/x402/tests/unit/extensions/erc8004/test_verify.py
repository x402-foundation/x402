"""Tests for ERC-8004 verification + dedup."""

from unittest.mock import MagicMock

from eth_utils import keccak

from x402.extensions.erc8004.verify import (
    TrustTier,
    dedup_feedback,
    verify_settlement,
)
from x402.mechanisms.evm.constants import X402_EXACT_PERMIT2_PROXY_ADDRESS


def test_dedup_keeps_latest_per_key() -> None:
    records = [
        {
            "payer": "0x000000000000000000000000000000000000000a",
            "agentId": 1,
            "txHash": "0x" + "11" * 32,
            "block": 10,
            "value": 50,
        },
        {
            "payer": "0x000000000000000000000000000000000000000a",
            "agentId": 1,
            "txHash": "0x" + "11" * 32,
            "block": 20,
            "value": 90,
        },
        {
            "payer": "0x000000000000000000000000000000000000000b",
            "agentId": 1,
            "txHash": "0x" + "11" * 32,
            "block": 5,
            "value": 30,
        },
    ]
    out = dedup_feedback(records)
    assert len(out) == 2
    a = [r for r in out if r["payer"].lower() == "0x000000000000000000000000000000000000000a"][0]
    assert a["value"] == 90  # latest block wins


def test_trust_tier_values() -> None:
    assert {t.name for t in TrustTier} >= {"FULL", "CLIENT_ONLY", "DISPUTED", "REJECTED"}


def _addr_topic(addr: str) -> bytes:
    hx = addr.lower().removeprefix("0x")
    return bytes.fromhex(hx.rjust(64, "0"))


def test_verify_settlement_accepts_permit2_transfer_from_singleton() -> None:
    transfer_topic = keccak(b"Transfer(address,address,uint256)")
    permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
    asset = "0x" + "01" * 20
    payer = "0x" + "02" * 20
    pay_to = "0x" + "03" * 20
    amount = 1000
    txh = "0x" + "aa" * 32

    topics = [transfer_topic, _addr_topic(permit2), _addr_topic(pay_to)]
    log = {"address": asset, "topics": topics, "data": amount.to_bytes(32, "big")}
    receipt = {"status": 1, "logs": [log]}
    tx = {"to": asset}

    w3 = MagicMock()
    w3.eth.chain_id = 8453
    w3.eth.get_transaction_receipt.return_value = receipt
    w3.eth.get_transaction.return_value = tx

    artifact = {
        "settlement": {
            "chainId": "eip155:8453",
            "txHash": txh,
            "asset": asset,
            "payer": payer,
            "payTo": pay_to,
            "amount": str(amount),
            "paymentMethod": "permit2",
            "paymentRequirements": {"extra": {}},
        }
    }
    assert verify_settlement(w3, artifact) is True


def test_verify_settlement_accepts_permit2_when_settlement_tx_targets_proxy() -> None:
    """Real `settle` txs set `to` to x402ExactPermit2Proxy, not the ERC-20."""
    transfer_topic = keccak(b"Transfer(address,address,uint256)")
    permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
    asset = "0x" + "01" * 20
    payer = "0x" + "02" * 20
    pay_to = "0x" + "03" * 20
    amount = 1000
    txh = "0x" + "aa" * 32

    topics = [transfer_topic, _addr_topic(permit2), _addr_topic(pay_to)]
    log = {"address": asset, "topics": topics, "data": amount.to_bytes(32, "big")}
    receipt = {"status": 1, "logs": [log]}
    tx = {"to": X402_EXACT_PERMIT2_PROXY_ADDRESS}

    w3 = MagicMock()
    w3.eth.chain_id = 8453
    w3.eth.get_transaction_receipt.return_value = receipt
    w3.eth.get_transaction.return_value = tx

    artifact = {
        "settlement": {
            "chainId": "eip155:8453",
            "txHash": txh,
            "asset": asset,
            "payer": payer,
            "payTo": pay_to,
            "amount": str(amount),
            "paymentMethod": "permit2",
            "paymentRequirements": {"extra": {}},
        }
    }
    assert verify_settlement(w3, artifact) is True
