"""Tests for ERC-8004 client extension."""

from unittest.mock import MagicMock

from x402.schemas.payments import PaymentPayload, PaymentRequired, PaymentRequirements

from x402.extensions.erc8004.client import (
    ERC8004ClientExtension,
    ERCFeedbackClient,
    echo_erc8004_in_payment_payload,
    extract_erc8004_info,
)
from x402.extensions.erc8004.types import ERC8004Config, FeedbackParams


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x" + "01" * 20,
        amount="1000000",
        pay_to="0x" + "03" * 20,
        max_timeout_seconds=60,
    )


def _config() -> ERC8004Config:
    return ERC8004Config(
        network="eip155:8453",
        reputation_registry="0x" + "00" * 20,
        identity_registry="0x" + "00" * 20,
        rpc_url="http://localhost:8545",
    )


def test_extract_erc8004_info() -> None:
    pr = PaymentRequired(accepts=[], extensions={"erc8004": {"info": {"agentId": 42}, "schema": {}}})
    assert extract_erc8004_info(pr)["agentId"] == 42


def test_extract_erc8004_info_preserves_empty_info() -> None:
    pr = PaymentRequired(accepts=[], extensions={"erc8004": {"info": {}, "schema": {}}})
    assert extract_erc8004_info(pr) == {}


def test_echo_erc8004_in_payment_payload() -> None:
    pr = PaymentRequired(accepts=[], extensions={"erc8004": {"info": {"agentId": 42}, "schema": {}}})
    payload = PaymentPayload(payload={}, accepted=_requirements())
    result = echo_erc8004_in_payment_payload(payload, pr)
    assert result.extensions["erc8004"]["info"]["agentId"] == 42


def test_client_extension_key() -> None:
    assert ERC8004ClientExtension().key == "erc8004"


def test_submit_feedback_to_registry_builds_tx() -> None:
    client = ERCFeedbackClient.__new__(ERCFeedbackClient)
    client._config = _config()
    signer = MagicMock()
    signer.address = "0x" + "02" * 20
    client._signer = signer

    w3 = MagicMock()
    w3.eth.chain_id = 8453
    w3.eth.get_transaction_count.return_value = 7
    w3.eth.max_priority_fee = 1
    w3.eth.get_block.return_value = {"baseFeePerGas": 2}
    w3.eth.contract.return_value.functions.giveFeedback.return_value.build_transaction.return_value = {"data": "0xabcd"}
    w3.eth.contract.return_value.functions.giveFeedback.return_value.estimate_gas = MagicMock(return_value=200000)
    signer.sign_transaction.return_value = MagicMock(raw_transaction=b"\x01")
    w3.eth.send_raw_transaction.return_value = bytes.fromhex("ab" * 32)
    client._w3 = w3

    params = FeedbackParams(agent_id=42, value=90, feedback_uri="mem://x", feedback_hash=b"\x0a" * 32)
    tx_hash = client.submit_feedback_to_registry(params)
    assert tx_hash == "0x" + "ab" * 32
    # plain type-2 tx (no EIP-7702 authorizationList)
    sent_tx = signer.sign_transaction.call_args[0][0]
    assert "authorizationList" not in sent_tx
