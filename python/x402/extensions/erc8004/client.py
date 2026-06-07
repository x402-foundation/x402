"""Client-side utilities for the ERC-8004 Feedback Extension.

Feedback reaches the canonical ERC-8004 ReputationRegistry, authored by the paying
client, via the EIP-7702 ``FeedbackGateway``: the client delegates its EOA to the
gateway, which consumes the x402 ticket and forwards ``giveFeedback`` — both calls
run with ``msg.sender == client``.
"""

from __future__ import annotations

from typing import Any

from eth_utils import keccak, to_checksum_address
from web3 import Web3

from x402.schemas.extensions import ClientExtension
from x402.schemas.payments import PaymentPayload, PaymentRequired

from .constants import (
    FEEDBACK_GATEWAY_ABI,
    FEEDBACK_GATEWAY_DOMAIN_NAME,
    FEEDBACK_GATEWAY_DOMAIN_VERSION,
    REPUTATION_REGISTRY_ABI,
)
from .schema import erc8004_schema
from .types import (
    ERC8004Config,
    EXTENSION_KEY,
    FeedbackParams,
)


def keccak_text(value: str) -> bytes:
    """keccak256(utf-8 bytes) for empty-string-safe text hashing in EIP-712 fields."""
    return keccak((value or "").encode("utf-8"))


# Matches FeedbackGateway.FEEDBACK_INTENT_TYPEHASH (sponsored path).
FEEDBACK_INTENT_TYPES: dict[str, list[dict[str, str]]] = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "FeedbackIntent": [
        {"name": "wrapper", "type": "address"},
        {"name": "registry", "type": "address"},
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
    """Client-side helper for ticket-gated feedback via the EIP-7702 FeedbackGateway.

    The signer must be an ``eth_account`` LocalAccount (it signs both the EIP-7702
    set-code authorization and the transaction). For sponsored feedback the *payer*
    builds the authorization + intent signature, and a *relayer* client submits.
    """

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

    # ----- gateway feedback (canonical registry, client-authored) -----

    def authorize_gateway(self, nonce: int | None = None) -> Any:
        """Sign an EIP-7702 set-code authorization delegating this signer's EOA to the gateway.

        For sponsored feedback the payer calls this (nonce defaults to the payer's account
        nonce). For self-paid feedback `submit_feedback_self_paid` handles it internally.
        """
        gateway = self._require_gateway()
        if nonce is None:
            nonce = self._w3.eth.get_transaction_count(self._signer.address)
        return self._signer.sign_authorization(
            {"chainId": self._w3.eth.chain_id, "address": gateway, "nonce": int(nonce)}
        )

    def submit_feedback_self_paid(
        self, ticket_id: int, params: FeedbackParams, gas: int = 500_000
    ) -> str:
        """Self-paid: the client delegates its own EOA and calls the gateway on itself."""
        gateway = self._require_gateway()
        data = self._gateway_calldata(
            "submitFeedback",
            [self._wrapper(), self._registry(), int(ticket_id), self._params_tuple(params)],
            gateway,
        )
        sender = self._signer.address
        tx_nonce = self._w3.eth.get_transaction_count(sender)
        # The tx consumes nonce `tx_nonce`; the set-code authorization for the same EOA is
        # checked after that, so it must be `tx_nonce + 1`.
        auth = self._signer.sign_authorization(
            {"chainId": self._w3.eth.chain_id, "address": gateway, "nonce": tx_nonce + 1}
        )
        return self._send_type4(to=sender, data=data, authorizations=[auth], gas=gas, tx_nonce=tx_nonce)

    def build_feedback_intent(
        self,
        ticket_id: int,
        params: FeedbackParams,
        nonce: int,
        deadline: int,
    ) -> tuple[dict[str, Any], dict[str, list[dict[str, str]]], dict[str, Any]]:
        """Build the EIP-712 FeedbackIntent (gateway domain) the payer signs for sponsored feedback."""
        domain = {
            "name": FEEDBACK_GATEWAY_DOMAIN_NAME,
            "version": FEEDBACK_GATEWAY_DOMAIN_VERSION,
            "chainId": self._w3.eth.chain_id,
            "verifyingContract": self._require_gateway(),
        }
        message = {
            "wrapper": self._wrapper(),
            "registry": self._registry(),
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
        client_address: str,
        client_authorization: Any,
        ticket_id: int,
        params: FeedbackParams,
        nonce: int,
        deadline: int,
        signature: bytes,
        gas: int = 500_000,
    ) -> str:
        """Sponsored: this signer (relayer) pays gas; the payer's authorization + signed intent
        delegate the EOA and authorize the exact feedback. Feedback is authored by the payer."""
        gateway = self._require_gateway()
        data = self._gateway_calldata(
            "submitFeedbackFor",
            [
                self._wrapper(),
                self._registry(),
                int(ticket_id),
                self._params_tuple(params),
                int(nonce),
                int(deadline),
                bytes(signature),
            ],
            gateway,
        )
        relayer_nonce = self._w3.eth.get_transaction_count(self._signer.address)
        return self._send_type4(
            to=to_checksum_address(client_address),
            data=data,
            authorizations=[client_authorization],
            gas=gas,
            tx_nonce=relayer_nonce,
        )

    def submit_feedback_to_registry(
        self, params: FeedbackParams, gas_limit: int | None = None
    ) -> str:
        """Direct (non-ticket) feedback on the canonical ReputationRegistry. Permissionless;
        records this signer as the author. Bypasses ticket gating."""
        registry = self._w3.eth.contract(
            address=to_checksum_address(self._config.reputation_registry), abi=REPUTATION_REGISTRY_ABI
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

    # ----- internals -----

    def _require_gateway(self) -> str:
        if not self._config.feedback_gateway:
            raise ValueError("ERC8004Config.feedback_gateway is required for gateway feedback")
        return to_checksum_address(self._config.feedback_gateway)

    def _wrapper(self) -> str:
        return to_checksum_address(self._config.feedback_contract)

    def _registry(self) -> str:
        return to_checksum_address(self._config.reputation_registry)

    @staticmethod
    def _params_tuple(params: FeedbackParams) -> tuple:
        return (
            int(params.value),
            int(params.value_decimals),
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedback_uri,
            params.feedback_hash,
        )

    def _gateway_calldata(self, fn: str, args: list[Any], gateway: str) -> str:
        contract = self._w3.eth.contract(address=gateway, abi=FEEDBACK_GATEWAY_ABI)
        return contract.encode_abi(fn, args=args)

    def _send_type4(
        self, to: str, data: str, authorizations: list[Any], gas: int, tx_nonce: int
    ) -> str:
        base_fee = self._w3.eth.get_block("latest")["baseFeePerGas"]
        tx = {
            "type": 4,
            "chainId": self._w3.eth.chain_id,
            "nonce": tx_nonce,
            "to": to,
            "value": 0,
            "gas": gas,
            "data": data,
            "maxFeePerGas": self._w3.eth.max_priority_fee + 2 * base_fee,
            "maxPriorityFeePerGas": self._w3.eth.max_priority_fee,
            "authorizationList": authorizations,
        }
        signed = self._signer.sign_transaction(tx)
        raw = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        return Web3.to_hex(raw)

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
