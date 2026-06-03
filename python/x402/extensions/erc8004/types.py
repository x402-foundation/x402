"""Type definitions for the ERC-8004 Feedback Extension."""

from __future__ import annotations

import copy
from typing import Any

from pydantic import BaseModel, Field

EXTENSION_KEY = "erc8004"
ARTIFACT_VERSION = "x402-erc8004/1"


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
    agent_id: int | None = None

    model_config = {"extra": "allow"}


class FeedbackParams(BaseModel):
    """Parameters for ReputationRegistry.giveFeedback."""

    agent_id: int
    value: int
    value_decimals: int = 0
    tag1: str = ""
    tag2: str = ""
    endpoint: str = ""
    feedback_uri: str = ""
    feedback_hash: bytes = Field(default=b"\x00" * 32)
    interaction_hash: bytes = Field(default=b"\x00" * 32)

    model_config = {"extra": "allow"}


class InteractionReceipt(BaseModel):
    """Agent-signed attestation over a paid interaction (optional).

    Signed by IdentityRegistry.ownerOf(agentId). Returned by the server in the
    X-X402-Interaction-Receipt header and embedded by the client into the
    artifact at interaction.response.agentSignature.

    Phase 4.4: anchors to the ticket id (was: settlement tx hash). The ticket
    id is the canonical identifier in the new model.
    """

    ticket_id: int
    interaction_hash: bytes
    chain_id: int
    signature: bytes

    model_config = {"extra": "allow"}

    def to_dict(self) -> dict[str, Any]:
        return {
            "ticketId": str(self.ticket_id),
            "interactionHash": "0x" + self.interaction_hash.hex(),
            "chainId": self.chain_id,
            "signature": "0x" + self.signature.hex(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> InteractionReceipt:
        return cls(
            ticket_id=int(data["ticketId"]),
            interaction_hash=bytes.fromhex(data["interactionHash"].removeprefix("0x")),
            chain_id=int(data["chainId"]),
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
