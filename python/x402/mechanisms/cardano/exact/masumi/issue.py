"""Issue seller-signed Masumi payment requirements."""

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pycardano import Address
from pycardano.cbor import cbor2

from .....schemas import PaymentRequirements
from ...constants import CANONICAL_CARDANO_ASSET_REGEX, POSITIVE_CANONICAL_AMOUNT_REGEX
from ...wallet import derive_wallet
from .blueprint import masumi_escrow_address, resolve_masumi_deployment
from .constants import (
    MASUMI_MAX_DEADLINE_HORIZON_MS,
    MASUMI_MIN_SUBMIT_RESULT_LEAD_MS,
    masumi_deadline_intervals_hold,
)
from .digests import (
    build_signed_terms,
    commitment_part_digest,
    compute_input_hash,
    compute_terms_digest,
)
from .identifier import encode_blockchain_identifier
from .schema import is_posix_ms_string, validate_masumi_extra

_UNSET = object()


@dataclass(frozen=True)
class MasumiSellerAuthorization:
    key: str
    signature: str


MasumiTermsSigner = Callable[[str, str], MasumiSellerAuthorization]


@dataclass(frozen=True)
class MasumiSellerSigner:
    seller_address: str
    sign_terms: MasumiTermsSigner


def to_masumi_seller_signer(
    mnemonic: str, network: str, account_index: int = 0
) -> MasumiSellerSigner:
    wallet = derive_wallet(mnemonic, network, account_index)

    def sign_terms(address: str, digest: str) -> MasumiSellerAuthorization:
        protected = cbor2.dumps({1: -8, "address": bytes(Address.from_primitive(address))})
        payload = bytes.fromhex(digest)
        signature = wallet.payment_key.sign(cbor2.dumps(["Signature1", protected, b"", payload]))
        public = wallet.payment_key.to_verification_key().to_non_extended().payload
        key = cbor2.dumps({1: 1, 3: -8, -1: 6, -2: public})
        return MasumiSellerAuthorization(
            key.hex(), cbor2.dumps([protected, {"hashed": False}, payload, signature]).hex()
        )

    return MasumiSellerSigner(wallet.address, sign_terms)


def _check_window(terms: dict[str, Any], timeout: int, horizon: int) -> None:
    now = int(time.time() * 1000)
    pay_by = int(terms["payByTime"])
    if pay_by <= now:
        raise ValueError("Masumi payByTime must be in the future")
    if int(terms["submitResultTime"]) < now + MASUMI_MIN_SUBMIT_RESULT_LEAD_MS:
        raise ValueError("Masumi submitResultTime must be at least 15 minutes away")
    if int(terms["externalDisputeUnlockTime"]) > now + horizon:
        raise ValueError("Masumi deadlines extend beyond the accepted horizon")
    if pay_by > now + timeout * 1000:
        raise ValueError("Masumi payByTime exceeds maxTimeoutSeconds")


def issue_masumi_requirements(
    *,
    network: str,
    asset: str,
    amount: str,
    max_timeout_seconds: int,
    seller_address: str,
    sign_terms: MasumiTermsSigner,
    commitment: list[dict[str, Any]],
    pay_by_time: str,
    submit_result_time: str,
    unlock_time: str,
    external_dispute_unlock_time: str,
    seller_nonce: str | None = None,
    buyer_nonce: str = "",
    agent_identifier: Any = _UNSET,
    seller_return_address: Any = _UNSET,
    confirmation_policy: Any = _UNSET,
    deployment: dict[str, Any] | None = None,
    unsafe_skip_policy_checks: bool = False,
    max_deadline_horizon_ms: int = MASUMI_MAX_DEADLINE_HORIZON_MS,
) -> PaymentRequirements:
    """Bind the complete quote to a fresh seller nonce and CIP-8 authorization."""
    if not POSITIVE_CANONICAL_AMOUNT_REGEX.fullmatch(amount):
        raise ValueError("Masumi amount must be a positive canonical integer")
    if not CANONICAL_CARDANO_ASSET_REGEX.fullmatch(asset):
        raise ValueError("Masumi asset must use canonical lowercase form")
    if type(max_timeout_seconds) is not int or not 0 < max_timeout_seconds <= 2**53 - 1:
        raise ValueError("Masumi maxTimeoutSeconds must be a positive safe integer")
    deadlines = dict(
        zip(
            ("payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime"),
            (pay_by_time, submit_result_time, unlock_time, external_dispute_unlock_time),
            strict=True,
        )
    )
    if unsafe_skip_policy_checks is not True:
        if not all(is_posix_ms_string(value) for value in deadlines.values()):
            raise ValueError("Masumi deadlines must be positive POSIX-ms integer strings")
        if not masumi_deadline_intervals_hold(*(int(value) for value in deadlines.values())):
            raise ValueError("Masumi deadline intervals are below the minimum")
        _check_window(deadlines, max_timeout_seconds, max_deadline_horizon_ms)
    resolved = resolve_masumi_deployment(network, deployment)
    if resolved is None:
        raise ValueError("Network has no canonical Masumi deployment; supply deployment")
    pay_to = masumi_escrow_address(network, resolved)
    parts: list[dict[str, Any]] = []
    for part in commitment:
        result = {
            key: part[key] for key in ("name", "canonicalization", "mediaType") if key in part
        }
        if part.get("echoContent") is not False:
            result["content"] = part["content"]
        result["digest"] = commitment_part_digest(part)
        parts.append(result)
    input_commitment: dict[str, Any] = {"version": "1", "algorithm": "sha256", "parts": parts}
    input_commitment["digest"] = compute_input_hash(input_commitment)
    terms: dict[str, Any] = {
        "version": "1",
        "paymentType": "Web3CardanoV2",
        "sellerAddress": seller_address,
        "sellerNonce": seller_nonce if seller_nonce is not None else secrets.token_hex(32),
        "buyerNonce": buyer_nonce,
        "inputHash": input_commitment["digest"],
        **deadlines,
    }
    for name, value in (
        ("agentIdentifier", agent_identifier),
        ("sellerReturnAddress", seller_return_address),
    ):
        if value is not _UNSET:
            terms[name] = value
    requirements = PaymentRequirements(
        scheme="exact",
        network=network,
        asset=asset,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=max_timeout_seconds,
    )
    extra: dict[str, Any] = {
        "assetTransferMethod": "masumi",
        "inputCommitment": input_commitment,
        "terms": terms,
    }
    digest = compute_terms_digest(build_signed_terms(extra, requirements))
    authorization = sign_terms(seller_address, digest)
    if unsafe_skip_policy_checks is not True:
        _check_window(terms, requirements.max_timeout_seconds, max_deadline_horizon_ms)
    extra.update(
        referenceKey=authorization.key.lower(), referenceSignature=authorization.signature.lower()
    )
    extra["blockchainIdentifier"] = encode_blockchain_identifier(
        {
            "sellerNonce": terms["sellerNonce"],
            "agentIdentifier": terms.get("agentIdentifier") or "",
            "buyerNonce": buyer_nonce,
            "referenceSignature": extra["referenceSignature"],
            "referenceKey": extra["referenceKey"],
            "contractAddress": pay_to,
        }
    )
    if confirmation_policy is not _UNSET:
        extra["confirmationPolicy"] = confirmation_policy
    if deployment is not None:
        extra["deployment"] = deployment
    schema = validate_masumi_extra(extra, network)
    if not schema.ok:
        raise ValueError(f"Issued Masumi requirements are invalid: {schema.detail}")
    requirements.extra = extra
    return requirements
