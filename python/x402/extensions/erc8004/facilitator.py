"""Facilitator-side extension for ERC-8004 ticket minting.

The extension wraps a facilitator EVM signer with the ability to route x402
settlement through a deployed TicketMinter so that the token transfer and the
ticket mint land in a single transaction. The returned tx hash + ticketId go
back to the resource server via PAYMENT-RESPONSE.extensions.erc8004.

Phase 2 ships the building blocks (extension class + settle helpers). Wiring
this into the standard `ExactEvmScheme.settle` flow happens once the client
extension populates payment.extensions.erc8004 with the ticket-bind fields
(Phase 4).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable

from eth_utils import to_checksum_address

from ...interfaces import FacilitatorExtension
from ...schemas import PaymentPayload, PaymentRequirements, SettleResponse
from .constants import TICKET_MINTER_ABI, get_ticket_minted_topic
from .types import EXTENSION_KEY

if TYPE_CHECKING:
    from ...mechanisms.evm.signer import FacilitatorEvmSigner

logger = logging.getLogger("x402.erc8004.facilitator")

ERR_TICKET_MISSING_BIND = "erc8004_ticket_bind_missing"
ERR_TICKET_MINT_FAILED = "erc8004_ticket_mint_failed"
ERR_TICKET_MINTER_NOT_CONFIGURED = "erc8004_ticket_minter_not_configured"


@dataclass(frozen=True)
class TicketBind:
    """Fields the client binds to a paid request before signing.

    `agent_id`, `request_hash`, `interaction_hash`, `endpoint` are echoed by
    the client in `PaymentPayload.extensions.erc8004` at signing time. The
    facilitator reads them from there and forwards into the minter.
    """

    agent_id: int
    request_hash: bytes
    interaction_hash: bytes
    endpoint: str


def extract_ticket_bind(payload: PaymentPayload) -> TicketBind | None:
    """Parse ticket-bind fields out of `PaymentPayload.extensions.erc8004`.

    Returns None when the extension is absent or malformed — callers should
    fall back to the standard settle path in that case.
    """
    extensions = payload.extensions or {}
    ext = extensions.get(EXTENSION_KEY)
    if not isinstance(ext, dict):
        return None

    info = ext.get("info") if isinstance(ext.get("info"), dict) else ext
    try:
        agent_id = int(info["agentId"])
        request_hash = _hex_to_bytes32(info["requestHash"])
        interaction_hash = _hex_to_bytes32(info["interactionHash"])
        endpoint = str(info["endpoint"])
    except (KeyError, ValueError, TypeError):
        return None

    return TicketBind(
        agent_id=agent_id,
        request_hash=request_hash,
        interaction_hash=interaction_hash,
        endpoint=endpoint,
    )


def _hex_to_bytes32(value: Any) -> bytes:
    if isinstance(value, bytes):
        if len(value) != 32:
            raise ValueError("bytes32 must be 32 bytes")
        return value
    if not isinstance(value, str):
        raise ValueError("bytes32 hex required")
    raw = bytes.fromhex(value.removeprefix("0x"))
    if len(raw) != 32:
        raise ValueError("bytes32 hex must decode to 32 bytes")
    return raw


class ERC8004TicketFacilitatorExtension(FacilitatorExtension):
    """Facilitator extension that mints an ERC-8004 ticket atomically with settle.

    Holds the per-network TicketMinter address mapping. Looked up by the
    scheme settle path via FacilitatorContext.get_extension(EXTENSION_KEY).

    Usage:
        ext = ERC8004TicketFacilitatorExtension(
            minter_for_network=lambda net: ADDRS.get(net),
        )
        facilitator.register_extension(ext)
    """

    def __init__(
        self,
        *,
        minter_for_network: Callable[[str], str | None] | None = None,
        minters: dict[str, str] | None = None,
    ) -> None:
        # FacilitatorExtension is a frozen dataclass — we bypass dataclass init
        # to set the runtime fields (matching Erc20ApprovalFacilitatorExtension).
        object.__setattr__(self, "key", EXTENSION_KEY)
        object.__setattr__(self, "_minter_for_network", minter_for_network)
        object.__setattr__(self, "_minters", dict(minters or {}))

    def resolve_minter(self, network: str) -> str | None:
        """Return the TicketMinter address configured for `network`, or None."""
        if self._minter_for_network is not None:
            addr = self._minter_for_network(network)
            if addr is not None:
                return addr
        return self._minters.get(network)


def settle_via_ticket_minter(
    signer: "FacilitatorEvmSigner",
    minter_address: str,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    ticket_bind: TicketBind,
) -> SettleResponse:
    """Settle a payment by routing it through TicketMinter.settleAndMintTicket*.

    Selects EIP-3009 or Permit2 path based on payload shape. Returns a
    SettleResponse whose `extensions.erc8004.ticketId` carries the minted id
    (parsed from the TicketMinted log on the receipt).
    """
    network = str(requirements.network)
    payer = _payer_from_payload(payload)

    try:
        if _is_permit2_payload(payload.payload):
            tx_hash = _write_settle_permit2(
                signer, minter_address, payload, requirements, ticket_bind, payer
            )
        else:
            tx_hash = _write_settle_eip3009(
                signer, minter_address, payload, requirements, ticket_bind, payer
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
        # Mint reverted silently or log topic missing — surface a failure so
        # the resource server skips its handler.
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
    """Parse the TicketMinted event's ticketId from a settled transaction.

    Returns None if no TicketMinted log is present (mint silently failed,
    or this tx didn't go through the minter).
    """
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
            # ticketId is the first indexed parameter → topics[1].
            tid = topics[1]
            tid_hex = tid.hex() if isinstance(tid, (bytes, bytearray)) else str(tid)
            return int(tid_hex, 16)
    return None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


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
    minter_address: str,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    ticket_bind: TicketBind,
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
        to_checksum_address(minter_address),
        TICKET_MINTER_ABI,
        "settleAndMintTicketEIP3009",
        to_checksum_address(payer),
        ticket_bind.agent_id,
        ticket_bind.request_hash,
        ticket_bind.interaction_hash,
        ticket_bind.endpoint,
        settlement,
    )


def _write_settle_permit2(
    signer: "FacilitatorEvmSigner",
    minter_address: str,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    ticket_bind: TicketBind,
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
        to_checksum_address(minter_address),
        TICKET_MINTER_ABI,
        "settleAndMintTicketPermit2",
        to_checksum_address(payer),
        ticket_bind.agent_id,
        ticket_bind.request_hash,
        ticket_bind.interaction_hash,
        ticket_bind.endpoint,
        settlement,
    )


def _w3_from_signer(signer: Any) -> Any:
    """Best-effort access to the underlying web3 instance for log parsing."""
    for attr in ("_w3", "w3"):
        w3 = getattr(signer, attr, None)
        if w3 is not None:
            return w3
    return None
