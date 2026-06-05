"""Client-side utilities for the ERC-8004 Feedback Extension."""

from __future__ import annotations

from typing import Any

from eth_utils import keccak, to_checksum_address
from web3 import Web3

from x402.schemas.extensions import ClientExtension
from x402.schemas.payments import PaymentPayload, PaymentRequired

from .schema import erc8004_schema
from .types import (
    ERC8004Config,
    EXTENSION_KEY,
    FeedbackParams,
)


def keccak_text(value: str) -> bytes:
    """keccak256(utf-8 bytes) for empty-string-safe text hashing in EIP-712 fields."""
    return keccak((value or "").encode("utf-8"))


WRAPPER_ABI = [
    {
        "inputs": [
            {"name": "agentId", "type": "uint256"},
            {"name": "value", "type": "int128"},
            {"name": "valueDecimals", "type": "uint8"},
            {"name": "tag1", "type": "string"},
            {"name": "tag2", "type": "string"},
            {"name": "endpoint", "type": "string"},
            {"name": "feedbackURI", "type": "string"},
            {"name": "feedbackHash", "type": "bytes32"},
        ],
        "name": "giveFeedback",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "ticketId", "type": "uint256"},
            {"name": "value", "type": "int128"},
            {"name": "valueDecimals", "type": "uint8"},
            {"name": "tag1", "type": "string"},
            {"name": "tag2", "type": "string"},
            {"name": "endpoint", "type": "string"},
            {"name": "feedbackURI", "type": "string"},
            {"name": "feedbackHash", "type": "bytes32"},
        ],
        "name": "giveFeedbackWithTicket",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {
                "name": "submission",
                "type": "tuple",
                "components": [
                    {"name": "payer", "type": "address"},
                    {"name": "ticketId", "type": "uint256"},
                    {"name": "value", "type": "int128"},
                    {"name": "valueDecimals", "type": "uint8"},
                    {"name": "tag1", "type": "string"},
                    {"name": "tag2", "type": "string"},
                    {"name": "endpoint", "type": "string"},
                    {"name": "feedbackURI", "type": "string"},
                    {"name": "feedbackHash", "type": "bytes32"},
                ],
            },
            {"name": "nonce", "type": "uint256"},
            {"name": "deadline", "type": "uint256"},
            {"name": "signature", "type": "bytes"},
        ],
        "name": "giveFeedbackWithTicketFor",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]

FEEDBACK_INTENT_TYPES: dict[str, list[dict[str, str]]] = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "FeedbackIntent": [
        {"name": "ticketId", "type": "uint256"},
        {"name": "value", "type": "int128"},
        {"name": "valueDecimals", "type": "uint8"},
        {"name": "tag1Hash", "type": "bytes32"},
        {"name": "tag2Hash", "type": "bytes32"},
        {"name": "endpointHash", "type": "bytes32"},
        {"name": "feedbackURIHash", "type": "bytes32"},
        {"name": "feedbackHash", "type": "bytes32"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
    ],
}

FEEDBACK_DOMAIN_NAME = "X402AgentReputation"
FEEDBACK_DOMAIN_VERSION = "1"


def extract_erc8004_info(payment_required: PaymentRequired) -> dict[str, Any] | None:
    """Extract agentId from PaymentRequired.extensions."""
    if not payment_required.extensions:
        return None
    ext = payment_required.extensions.get(EXTENSION_KEY)
    if not ext:
        return None
    info = ext.get("info") if isinstance(ext, dict) else getattr(ext, "info", None)
    return info if info is not None else None


def echo_erc8004_in_payment_payload(
    payment_payload: PaymentPayload, payment_required: PaymentRequired
) -> PaymentPayload:
    """Echo the erc8004 extension into PaymentPayload per x402 v2 spec."""
    if not payment_required.extensions or EXTENSION_KEY not in payment_required.extensions:
        return payment_payload
    ext = payment_required.extensions[EXTENSION_KEY]
    info = ext.get("info") if isinstance(ext, dict) else getattr(ext, "info", {})
    extensions = dict(payment_payload.extensions or {})
    extensions[EXTENSION_KEY] = {"info": dict(info), "schema": erc8004_schema}
    payment_payload.extensions = extensions
    return payment_payload


class ERC8004ClientExtension(ClientExtension):
    """Client extension that echoes erc8004 agentId into PaymentPayload."""

    key = EXTENSION_KEY

    def enrich_payment_payload(self, payment_payload: Any, payment_required: Any) -> Any:
        return echo_erc8004_in_payment_payload(payment_payload, payment_required)


class ERCFeedbackClient:
    """Client-side helper for building, publishing, and submitting feedback."""

    def __init__(self, config: ERC8004Config, signer: Any) -> None:
        self._config = config
        self._signer = signer
        self._w3 = Web3(Web3.HTTPProvider(config.rpc_url))

    @staticmethod
    def extract_erc8004_info(payment_required: PaymentRequired) -> dict[str, Any] | None:
        return extract_erc8004_info(payment_required)

    def ticket_id_from_receipt(self, tx_hash: str) -> int | None:
        from .facilitator import ticket_id_from_receipt

        return ticket_id_from_receipt(self._signer, tx_hash)

    def submit_feedback_to_registry(
        self, params: FeedbackParams, gas_limit: int | None = None
    ) -> str:
        """Submit feedback directly to upstream ReputationRegistry.giveFeedback."""
        registry = self._w3.eth.contract(
            address=to_checksum_address(self._config.reputation_registry), abi=WRAPPER_ABI
        )
        func = registry.functions.giveFeedback(
            params.agent_id,
            params.value,
            params.value_decimals,
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedback_uri,
            params.feedback_hash,
        )
        return self._send_registry_tx(func, self._config.reputation_registry, gas_limit)

    def submit_feedback_with_ticket(
        self,
        ticket_id: int,
        params: FeedbackParams,
        gas_limit: int | None = None,
    ) -> str:
        """Submit feedback through the ticket-gated wrapper path (Path A)."""
        contract_addr = self._config.feedback_contract
        registry = self._w3.eth.contract(address=to_checksum_address(contract_addr), abi=WRAPPER_ABI)
        func = registry.functions.giveFeedbackWithTicket(
            int(ticket_id),
            params.value,
            params.value_decimals,
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedback_uri,
            params.feedback_hash,
        )
        return self._send_registry_tx(func, contract_addr, gas_limit)

    def build_feedback_intent(
        self,
        ticket_id: int,
        params: FeedbackParams,
        nonce: int,
        deadline: int,
    ) -> tuple[dict[str, Any], dict[str, list[dict[str, str]]], dict[str, Any]]:
        domain = {
            "name": FEEDBACK_DOMAIN_NAME,
            "version": FEEDBACK_DOMAIN_VERSION,
            "chainId": self._w3.eth.chain_id,
            "verifyingContract": to_checksum_address(self._config.feedback_contract),
        }
        message = {
            "ticketId": int(ticket_id),
            "value": int(params.value),
            "valueDecimals": int(params.value_decimals),
            "tag1Hash": keccak_text(params.tag1),
            "tag2Hash": keccak_text(params.tag2),
            "endpointHash": keccak_text(params.endpoint),
            "feedbackURIHash": keccak_text(params.feedback_uri),
            "feedbackHash": params.feedback_hash,
            "nonce": int(nonce),
            "deadline": int(deadline),
        }
        return domain, FEEDBACK_INTENT_TYPES, message

    def submit_feedback_sponsored(
        self,
        payer: str,
        ticket_id: int,
        params: FeedbackParams,
        nonce: int,
        deadline: int,
        signature: bytes,
        gas_limit: int | None = None,
    ) -> str:
        contract_addr = self._config.feedback_contract
        registry = self._w3.eth.contract(address=to_checksum_address(contract_addr), abi=WRAPPER_ABI)
        submission = (
            to_checksum_address(payer),
            int(ticket_id),
            int(params.value),
            int(params.value_decimals),
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedback_uri,
            params.feedback_hash,
        )
        func = registry.functions.giveFeedbackWithTicketFor(
            submission, int(nonce), int(deadline), bytes(signature)
        )
        return self._send_registry_tx(func, contract_addr, gas_limit)

    def _send_registry_tx(self, func: Any, contract_address: str, gas_limit: int | None) -> str:
        sender = getattr(self._signer, "address", None)
        if sender is None:
            raise TypeError("signer must expose an address attribute")

        if gas_limit is None:
            estimate = func.estimate_gas({"from": sender})
            gas_limit = int(estimate * 1.2)

        nonce = self._w3.eth.get_transaction_count(sender)
        base_fee = self._w3.eth.get_block("latest")["baseFeePerGas"]
        tx = {
            "type": 2,
            "chainId": self._w3.eth.chain_id,
            "nonce": nonce,
            "to": to_checksum_address(contract_address),
            "value": 0,
            "gas": gas_limit,
            "data": func.build_transaction({"from": sender})["data"],
            "maxFeePerGas": self._w3.eth.max_priority_fee + 2 * base_fee,
            "maxPriorityFeePerGas": self._w3.eth.max_priority_fee,
        }
        signed = self._signer.sign_transaction(tx)
        raw = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        return Web3.to_hex(raw)
