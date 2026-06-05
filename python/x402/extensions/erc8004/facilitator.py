"""Facilitator-side extension for ERC-8004 ticket minting.

Routes x402 settlement through a deployed X402AgentReputation wrapper so token
transfer and ticket mint land in a single transaction.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Callable

from eth_utils import to_checksum_address

from ...interfaces import FacilitatorExtension
from ...schemas import PaymentPayload, PaymentRequirements, SettleResponse
from .constants import X402_AGENT_REPUTATION_ABI, get_ticket_minted_topic
from .types import EXTENSION_KEY

if TYPE_CHECKING:
    from ...mechanisms.evm.signer import FacilitatorEvmSigner

logger = logging.getLogger("x402.erc8004.facilitator")

ERR_TICKET_MINT_FAILED = "erc8004_ticket_mint_failed"
ERR_WRAPPER_NOT_CONFIGURED = "erc8004_wrapper_not_configured"


def extract_agent_id(payload: PaymentPayload) -> int | None:
    """Parse agentId from PaymentPayload.extensions.erc8004 (echoed from server 402)."""
    extensions = payload.extensions or {}
    ext = extensions.get(EXTENSION_KEY)
    if not isinstance(ext, dict):
        return None
    info = ext.get("info") if isinstance(ext.get("info"), dict) else ext
    try:
        return int(info["agentId"])
    except (KeyError, ValueError, TypeError):
        return None


class ERC8004TicketFacilitatorExtension(FacilitatorExtension):
    """Facilitator extension that mints an ERC-8004 ticket atomically with settle."""

    def __init__(
        self,
        *,
        wrapper_for_network: Callable[[str], str | None] | None = None,
        wrappers: dict[str, str] | None = None,
        minter_for_network: Callable[[str], str | None] | None = None,
        minters: dict[str, str] | None = None,
    ) -> None:
        object.__setattr__(self, "key", EXTENSION_KEY)
        lookup = wrapper_for_network or minter_for_network
        static = dict(wrappers or minters or {})
        object.__setattr__(self, "_wrapper_for_network", lookup)
        object.__setattr__(self, "_wrappers", static)

    def resolve_wrapper(self, network: str) -> str | None:
        """Return the X402AgentReputation address for `network`, or None."""
        if self._wrapper_for_network is not None:
            addr = self._wrapper_for_network(network)
            if addr is not None:
                return addr
        return self._wrappers.get(network)

    def resolve_minter(self, network: str) -> str | None:
        """Legacy alias for resolve_wrapper."""
        return self.resolve_wrapper(network)


def settle_via_wrapper(
    signer: "FacilitatorEvmSigner",
    wrapper_address: str,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    agent_id: int,
) -> SettleResponse:
    """Settle by routing through X402AgentReputation.settleAndMintTicket*."""
    network = str(requirements.network)
    payer = _payer_from_payload(payload)
    agent_address = to_checksum_address(requirements.pay_to)

    try:
        if _is_permit2_payload(payload.payload):
            tx_hash = _write_settle_permit2(
                signer, wrapper_address, payload, requirements, agent_id, agent_address, payer
            )
        else:
            tx_hash = _write_settle_eip3009(
                signer, wrapper_address, payload, requirements, agent_id, agent_address, payer
            )
    except Exception as e:
        logger.warning("erc8004 settle failed for payer=%s: %s", payer, e, exc_info=True)
        return SettleResponse(
            success=False,
            error_reason=ERR_TICKET_MINT_FAILED,
            error_message=str(e)[:500],
            network=network,
            payer=payer,
            transaction="",
        )

    receipt = signer.wait_for_transaction_receipt(tx_hash)
    if getattr(receipt, "status", 0) != 1:
        return SettleResponse(
            success=False,
            error_reason=ERR_TICKET_MINT_FAILED,
            transaction=tx_hash,
            network=network,
            payer=payer,
        )

    ticket_id = ticket_id_from_receipt(signer, tx_hash)
    if ticket_id is None:
        return SettleResponse(
            success=False,
            error_reason=ERR_TICKET_MINT_FAILED,
            transaction=tx_hash,
            network=network,
            payer=payer,
        )

    return SettleResponse(
        success=True,
        transaction=tx_hash,
        network=network,
        payer=payer,
        extensions={EXTENSION_KEY: {"ticketId": str(ticket_id)}},
    )


def ticket_id_from_receipt(signer: "FacilitatorEvmSigner", tx_hash: str) -> int | None:
    """Parse TicketMinted.ticketId from a settled transaction receipt."""
    w3 = _w3_from_signer(signer)
    if w3 is None:
        return None
    if not tx_hash.startswith("0x"):
        tx_hash = "0x" + tx_hash
    receipt = w3.eth.get_transaction_receipt(tx_hash)
    topic = get_ticket_minted_topic()
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
            if isinstance(tid, (bytes, bytearray)):
                return int.from_bytes(tid, "big")
            return int(str(tid), 16)
    return None


def _is_permit2_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    return "permit2Authorization" in payload


def _payer_from_payload(payload: PaymentPayload) -> str:
    from ...mechanisms.evm.types import ExactEIP3009Payload, ExactPermit2Payload

    inner = payload.payload or {}
    if _is_permit2_payload(inner):
        return ExactPermit2Payload.from_dict(inner).permit2_authorization.from_address
    return ExactEIP3009Payload.from_dict(inner).authorization.from_address


def _write_settle_eip3009(
    signer: "FacilitatorEvmSigner",
    wrapper_address: str,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    agent_id: int,
    agent_address: str,
    payer: str,
) -> str:
    from ...mechanisms.evm.types import ExactEIP3009Payload

    eip3009 = ExactEIP3009Payload.from_dict(payload.payload)
    auth = eip3009.authorization
    nonce = auth.nonce
    if isinstance(nonce, str):
        nonce_bytes = bytes.fromhex(nonce.removeprefix("0x"))
    else:
        nonce_bytes = bytes(nonce)
    if len(nonce_bytes) != 32:
        raise ValueError("EIP-3009 nonce must be 32 bytes")

    sig_hex = eip3009.signature or ""
    sig_bytes = bytes.fromhex(sig_hex.removeprefix("0x"))

    settlement = (
        to_checksum_address(requirements.asset),
        to_checksum_address(auth.to),
        int(auth.value),
        int(auth.valid_after),
        int(auth.valid_before),
        nonce_bytes,
        sig_bytes,
    )

    return signer.write_contract(
        to_checksum_address(wrapper_address),
        X402_AGENT_REPUTATION_ABI,
        "settleAndMintTicketEIP3009",
        to_checksum_address(payer),
        int(agent_id),
        agent_address,
        settlement,
    )


def _write_settle_permit2(
    signer: "FacilitatorEvmSigner",
    wrapper_address: str,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    agent_id: int,
    agent_address: str,
    payer: str,
) -> str:
    from ...mechanisms.evm.types import ExactPermit2Payload

    permit2 = ExactPermit2Payload.from_dict(payload.payload)
    auth = permit2.permit2_authorization

    sig_hex = permit2.signature or ""
    sig_bytes = bytes.fromhex(sig_hex.removeprefix("0x"))

    permit_tuple = (
        (
            to_checksum_address(auth.permitted.token),
            int(auth.permitted.amount),
        ),
        int(auth.nonce),
        int(auth.deadline),
    )
    settlement = (
        permit_tuple,
        to_checksum_address(auth.witness.to),
        int(auth.witness.valid_after),
        sig_bytes,
    )

    return signer.write_contract(
        to_checksum_address(wrapper_address),
        X402_AGENT_REPUTATION_ABI,
        "settleAndMintTicketPermit2",
        to_checksum_address(payer),
        int(agent_id),
        agent_address,
        settlement,
    )


def _w3_from_signer(signer: Any) -> Any:
    for attr in ("_w3", "w3"):
        w3 = getattr(signer, attr, None)
        if w3 is not None:
            return w3
    return None
