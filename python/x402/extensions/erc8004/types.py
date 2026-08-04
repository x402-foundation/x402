"""Type definitions for the ERC-8004 Feedback Extension."""

from __future__ import annotations

import copy
from typing import Any

from pydantic import BaseModel, Field

EXTENSION_KEY = "erc8004"
ARTIFACT_VERSION = "x402-erc8004/2"
ARTIFACT_VERSION_V1 = "x402-erc8004/1"


class ERC8004ExtensionInfo(BaseModel):
    """Info portion of the erc8004 extension declaration."""

    agent_id: int = Field(alias="agentId")

    model_config = {"extra": "allow", "populate_by_name": True}


class ERC8004ExtensionDeclaration(BaseModel):
    """What server puts in PaymentRequired.extensions['erc8004']."""

    info: ERC8004ExtensionInfo
    schema_: dict[str, Any] = Field(alias="schema")

    model_config = {"extra": "allow", "populate_by_name": True}


class ERC8004Config(BaseModel):
    """Chain-specific config for ERC-8004 extension."""

    network: str
    reputation_registry: str
    identity_registry: str
    rpc_url: str
    wrapper_address: str | None = None
    feedback_gateway: str | None = None
    agent_id: int | None = None

    model_config = {"extra": "allow"}

    @property
    def feedback_contract(self) -> str:
        """On-chain contract for ticket-gated feedback (v2 wrapper)."""
        return self.wrapper_address or self.reputation_registry


class FeedbackParams(BaseModel):
    """Parameters for ticket-gated feedback submission."""

    agent_id: int
    value: int
    value_decimals: int = 0
    tag1: str = ""
    tag2: str = ""
    endpoint: str = ""
    feedback_uri: str = ""
    feedback_hash: bytes = Field(default=b"\x00" * 32)

    model_config = {"extra": "allow"}


class InteractionAttestation(BaseModel):
    """Agent-signed EIP-712 attestation over a paid HTTP interaction."""

    ticket_id: int
    chain_id: int
    method: str
    url: str
    request_body_digest: bytes
    response_body_digest: bytes
    response_status: int
    signature: bytes

    model_config = {"extra": "allow"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "ticketId": str(self.ticket_id),
            "chainId": self.chain_id,
            "method": self.method,
            "url": self.url,
            "requestBodyDigest": "0x" + self.request_body_digest.hex(),
            "responseBodyDigest": "0x" + self.response_body_digest.hex(),
            "responseStatus": self.response_status,
            "signature": "0x" + self.signature.hex(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> InteractionAttestation:
        return cls(
            ticket_id=int(data["ticketId"]),
            chain_id=int(data["chainId"]),
            method=str(data["method"]),
            url=str(data["url"]),
            request_body_digest=bytes.fromhex(data["requestBodyDigest"].removeprefix("0x")),
            response_body_digest=bytes.fromhex(data["responseBodyDigest"].removeprefix("0x")),
            response_status=int(data["responseStatus"]),
            signature=bytes.fromhex(data["signature"].removeprefix("0x")),
        )


class FeedbackArtifact(BaseModel):
    """Canonical off-chain feedback artifact hosted at feedbackURI."""

    version: str = ARTIFACT_VERSION
    settlement: dict[str, Any]
    interaction: dict[str, Any]
    feedback: dict[str, Any]

    model_config = {"extra": "allow"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "settlement": copy.deepcopy(self.settlement),
            "interaction": copy.deepcopy(self.interaction),
            "feedback": copy.deepcopy(self.feedback),
        }
