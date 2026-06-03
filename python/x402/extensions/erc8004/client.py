"""Client-side utilities for the ERC-8004 Feedback Extension."""

from __future__ import annotations

import secrets
from typing import Any, Protocol

from eth_utils import keccak, to_checksum_address
from web3 import Web3


def keccak_text(value: str) -> bytes:
    """keccak256(utf-8 bytes) for empty-string-safe text hashing in EIP-712 fields."""
    return keccak((value or "").encode("utf-8"))
from x402.schemas.extensions import ClientExtension
from x402.schemas.payments import PaymentPayload, PaymentRequired, PaymentRequirements

from .artifact import build_artifact, canonical_bytes, compute_feedback_hash
from .schema import erc8004_schema
from .ticket_hashes import TicketBind, echo_ticket_bind_in_payment_payload
from .types import (
    ERC8004Config,
    EXTENSION_KEY,
    FeedbackParams,
    InteractionReceipt,
)

REPUTATION_ABI = [
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
            {"name": "interactionHash", "type": "bytes32"},
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
                    {"name": "interactionHash", "type": "bytes32"},
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


# EIP-712 typed data for the sponsored feedback path (matches
# ReputationRegistryV3.FEEDBACK_INTENT_TYPEHASH and EIP712("ERC8004ReputationV3","2")).
FEEDBACK_INTENT_TYPES: dict[str, list[dict[str, str]]] = {
    "EIP712Domain": [
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
    ],
    "FeedbackIntent": [
        {"name": "ticketId", "type": "uint256"},
        {"name": "interactionHash", "type": "bytes32"},
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

FEEDBACK_DOMAIN_NAME = "ERC8004ReputationV3"
FEEDBACK_DOMAIN_VERSION = "2"


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
    """Client extension that echoes erc8004 info into PaymentPayload.

    By default it echoes the agentId the server declared. If a ``TicketBind``
    is supplied (computed via ``compute_ticket_bind`` once the client knows
    the request digests), the extension merges ``requestHash``,
    ``interactionHash``, and ``endpoint`` into the same info block so the
    facilitator can pin the ticket to this specific paid call.

    The bind is supplied via ``set_ticket_bind(bind)`` between requests rather
    than at construction time, because each request has a different bind.
    """

    key = EXTENSION_KEY

    def __init__(self, ticket_bind: TicketBind | None = None) -> None:
        self._ticket_bind = ticket_bind

    def set_ticket_bind(self, bind: TicketBind | None) -> None:
        """Set (or clear) the bind to be echoed on the next ``enrich_payment_payload`` call."""
        self._ticket_bind = bind

    def enrich_payment_payload(self, payment_payload: Any, payment_required: Any) -> Any:
        payment_payload = echo_erc8004_in_payment_payload(payment_payload, payment_required)
        if self._ticket_bind is not None:
            payment_payload = echo_ticket_bind_in_payment_payload(
                payment_payload, self._ticket_bind
            )
        return payment_payload


class ArtifactUploader(Protocol):
    """Pluggable storage backend for the feedback artifact.

    Production implementations should use content-addressed storage
    (IPFS/Arweave) so the URI itself commits to the content.
    """

    def upload(self, content: bytes) -> str:
        """Upload bytes, return a resolvable URI."""
        ...


class InMemoryUploader:
    """Test/dev uploader. Returns a mem:// URI and retains bytes in memory."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}

    def upload(self, content: bytes) -> str:
        uri = "mem://" + secrets.token_hex(16)
        self.store[uri] = content
        return uri


class PinataUploader:
    """Content-addressed uploader backed by the Pinata V3 file API.

    Posts to POST https://uploads.pinata.cloud/v3/files with Bearer auth.
    Returns an ipfs:// URI; the resulting CID is also kept on `last_cid`.
    """

    UPLOAD_URL = "https://uploads.pinata.cloud/v3/files"

    def __init__(
        self,
        jwt: str,
        network: str = "public",
        name: str = "x402-erc8004-feedback.json",
        timeout: float = 60.0,
    ) -> None:
        self._jwt = jwt
        self._network = network
        self._name = name
        self._timeout = timeout
        self.last_cid: str | None = None

    def upload(self, content: bytes) -> str:
        import httpx

        resp = httpx.post(
            self.UPLOAD_URL,
            headers={"Authorization": f"Bearer {self._jwt}"},
            files={"file": (self._name, content, "application/json")},
            data={"network": self._network, "name": self._name},
            timeout=self._timeout,
        )
        resp.raise_for_status()
        cid = resp.json()["data"]["cid"]
        self.last_cid = cid
        return f"ipfs://{cid}"


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
        """Parse the TicketMinted log on ``tx_hash`` and return the ticketId.

        Thin wrapper around the facilitator-side helper so clients holding an
        ``ERCFeedbackClient`` can recover the ticket id from PAYMENT-RESPONSE
        when ``extensions.erc8004.ticketId`` isn't echoed (older facilitators)
        or as a backstop verification step.
        """
        from .facilitator import _w3_from_signer  # local: avoid cycle  # noqa: F401
        from .constants import get_ticket_minted_topic

        topic = get_ticket_minted_topic()
        if not tx_hash.startswith("0x"):
            tx_hash = "0x" + tx_hash
        receipt = self._w3.eth.get_transaction_receipt(tx_hash)
        for log in receipt.get("logs", []) or []:
            topics = log.get("topics") or []
            if not topics:
                continue
            topic0 = topics[0]
            topic0_hex = topic0.hex() if isinstance(topic0, (bytes, bytearray)) else str(topic0)
            if not topic0_hex.startswith("0x"):
                topic0_hex = "0x" + topic0_hex
            if topic0_hex.lower() == topic.lower():
                tid = topics[1]
                tid_hex = tid.hex() if isinstance(tid, (bytes, bytearray)) else str(tid)
                return int(tid_hex, 16)
        return None

    def build_and_publish_artifact(
        self,
        requirements: PaymentRequirements,
        payment_payload: PaymentPayload,
        tx_hash: str,
        payer: str,
        payment_method: str,
        request: dict[str, Any],
        response: dict[str, Any],
        params: FeedbackParams,
        uploader: ArtifactUploader,
        receipt: InteractionReceipt | None = None,
    ) -> tuple[str, bytes, FeedbackParams]:
        """Build the canonical artifact, embed the optional receipt, publish it.

        Returns (feedbackURI, feedbackHash, updated FeedbackParams).
        """
        feedback = {
            "agentId": params.agent_id,
            "value": params.value,
            "valueDecimals": params.value_decimals,
            "tag1": params.tag1,
            "tag2": params.tag2,
            "endpoint": params.endpoint,
            "comment": getattr(params, "comment", ""),
        }
        artifact = build_artifact(
            requirements=requirements,
            payment_payload=payment_payload,
            tx_hash=tx_hash,
            payer=payer,
            payment_method=payment_method,
            agent_id=params.agent_id,
            request=request,
            response=response,
            feedback=feedback,
        )
        art_dict = artifact.to_dict()
        if receipt is not None:
            art_dict["interaction"]["response"]["agentSignature"] = receipt.to_dict()

        feedback_hash = compute_feedback_hash(art_dict)
        uri = uploader.upload(canonical_bytes(art_dict))
        updated = params.model_copy(update={"feedback_uri": uri, "feedback_hash": feedback_hash})
        return uri, feedback_hash, updated

    def submit_feedback_to_registry(
        self, params: FeedbackParams, gas_limit: int | None = None
    ) -> str:
        """Submit feedback directly to ReputationRegistry.giveFeedback (type-2 tx)."""
        registry = self._w3.eth.contract(
            address=to_checksum_address(self._config.reputation_registry), abi=REPUTATION_ABI
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
            "to": to_checksum_address(self._config.reputation_registry),
            "value": 0,
            "gas": gas_limit,
            "data": func.build_transaction({"from": sender})["data"],
            "maxFeePerGas": self._w3.eth.max_priority_fee + 2 * base_fee,
            "maxPriorityFeePerGas": self._w3.eth.max_priority_fee,
        }
        signed = self._signer.sign_transaction(tx)
        raw = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        return Web3.to_hex(raw)

    def submit_feedback_with_ticket(
        self,
        ticket_id: int,
        params: FeedbackParams,
        gas_limit: int | None = None,
    ) -> str:
        """Submit feedback through the ticket-gated path (Path A).

        Calls ``ReputationRegistryV3.giveFeedbackWithTicket``. The registry
        verifies the ticket is MINTED + payer matches + feedbackHash hasn't
        been reused, then atomically consumes the ticket and records the
        feedback. The signer must be the ticket's payer.
        """
        registry = self._w3.eth.contract(
            address=to_checksum_address(self._config.reputation_registry),
            abi=REPUTATION_ABI,
        )
        func = registry.functions.giveFeedbackWithTicket(
            int(ticket_id),
            params.value,
            params.value_decimals,
            params.tag1,
            params.tag2,
            params.endpoint,
            params.feedback_uri,
            params.interaction_hash,
            params.feedback_hash,
        )
        return self._send_registry_tx(func, gas_limit)

    def build_feedback_intent(
        self,
        ticket_id: int,
        params: FeedbackParams,
        nonce: int,
        deadline: int,
    ) -> tuple[dict[str, Any], dict[str, list[dict[str, str]]], dict[str, Any]]:
        """Build the EIP-712 (domain, types, message) for a sponsored feedback intent.

        The caller signs ``(domain, types, message)`` with the payer key, then
        passes the signature plus the full ``FeedbackSubmission`` struct to
        ``submit_feedback_sponsored``.

        Returns ``(domain, types, message)`` ready to feed into any EIP-712
        signer (``eth_account.Account.sign_typed_data`` or equivalent).
        """
        domain = {
            "name": FEEDBACK_DOMAIN_NAME,
            "version": FEEDBACK_DOMAIN_VERSION,
            "chainId": self._w3.eth.chain_id,
            "verifyingContract": to_checksum_address(self._config.reputation_registry),
        }
        message = {
            "ticketId": int(ticket_id),
            "interactionHash": params.interaction_hash,
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
        """Relay a payer-signed FeedbackIntent (Path B — sponsored).

        ``self._signer`` here is the *relayer* (pays gas). The on-chain
        signature recovery binds the feedback to the ``payer`` argument.
        """
        registry = self._w3.eth.contract(
            address=to_checksum_address(self._config.reputation_registry),
            abi=REPUTATION_ABI,
        )
        submission = (
            to_checksum_address(payer),
            int(ticket_id),
            params.interaction_hash,
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
        return self._send_registry_tx(func, gas_limit)

    def _send_registry_tx(self, func: Any, gas_limit: int | None) -> str:
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
            "to": to_checksum_address(self._config.reputation_registry),
            "value": 0,
            "gas": gas_limit,
            "data": func.build_transaction({"from": sender})["data"],
            "maxFeePerGas": self._w3.eth.max_priority_fee + 2 * base_fee,
            "maxPriorityFeePerGas": self._w3.eth.max_priority_fee,
        }
        signed = self._signer.sign_transaction(tx)
        raw = self._w3.eth.send_raw_transaction(signed.raw_transaction)
        return Web3.to_hex(raw)
