"""Verify seller authorization and the value and datum of a Masumi escrow lock."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .....schemas import PaymentRequirements
from ... import constants as c
from ...types import DecodedCardanoTransaction
from ...utils import slot_to_posix_ms
from .blueprint import masumi_escrow_address, resolve_masumi_deployment
from .constants import (
    MASUMI_MIN_COLLATERAL_LOVELACE,
    MASUMI_REGISTRY_POLICY_ID,
    masumi_deadline_intervals_hold,
    masumi_min_utxo_lovelace,
)
from .cose import verify_seller_terms_signature
from .datum import MasumiDatumView, address_credentials, parse_masumi_lock_datum
from .digests import (
    build_signed_terms,
    commitment_part_digest,
    compute_input_hash,
    compute_terms_digest,
)
from .identifier import decode_blockchain_identifier
from .schema import validate_masumi_extra


@dataclass(frozen=True)
class MasumiLockCheck:
    ok: bool
    reason: str | None = None
    detail: str | None = None
    escrow_address: str | None = None
    terms_digest: str | None = None


@dataclass
class MasumiAuthorizationOptions:
    validate_registry_claim: Callable[[dict[str, Any]], bool] | None = None
    resource: Any = None
    validate_custom_deployment: Callable[[dict[str, Any]], bool] | None = None
    local_commitment_content: dict[str, Any] | None = None
    require_all_part_content: bool = False
    max_deadline_horizon_ms: int | None = None


def verify_masumi_datum_invariants(view: MasumiDatumView, escrow_address: str) -> MasumiLockCheck:
    def fail(detail: str) -> MasumiLockCheck:
        return MasumiLockCheck(False, c.ERR_MASUMI_DATUM_INVALID, detail)

    if view.state != 0:
        return fail("state")
    if view.result_hash:
        return fail("result_hash")
    if view.seller_cooldown_time != 0 or view.buyer_cooldown_time != 0:
        return fail("cooldown")
    for name in ("buyer", "seller", "buyer_return_address", "seller_return_address"):
        credential = getattr(view, name)
        if credential and (
            credential.payment.is_script
            or credential.pointer
            or (credential.stake and credential.stake.is_script)
        ):
            return fail(f"{name} uses an unsupported address form")
    if len(view.reference_signature) < 32:
        return fail("reference_signature shorter than 16 bytes")
    escrow = address_credentials(escrow_address)
    buyer_target = view.buyer_return_address or view.buyer
    seller_target = view.seller_return_address or view.seller
    if escrow in (view.buyer, view.seller, buyer_target, seller_target):
        return fail("datum address is the escrow")
    if buyer_target == seller_target:
        return fail("buyer and seller payout targets are equal")
    if not masumi_deadline_intervals_hold(
        view.pay_by_time,
        view.submit_result_time,
        view.unlock_time,
        view.external_dispute_unlock_time,
    ):
        return MasumiLockCheck(False, c.ERR_MASUMI_DEADLINE, "deadline intervals below the minimum")
    return MasumiLockCheck(True)


def verify_masumi_authorization(
    extra: dict[str, Any],
    requirements: PaymentRequirements,
    options: MasumiAuthorizationOptions | None = None,
) -> MasumiLockCheck:
    """Authenticate signed terms before invoking application trust callbacks."""
    options = options or MasumiAuthorizationOptions()
    schema = validate_masumi_extra(extra, requirements.network)
    if not schema.ok:
        return MasumiLockCheck(False, c.ERR_MASUMI_SCHEMA, schema.detail)
    terms, commitment = extra["terms"], extra["inputCommitment"]
    times = [
        int(terms[field])
        for field in ("payByTime", "submitResultTime", "unlockTime", "externalDisputeUnlockTime")
    ]
    if not masumi_deadline_intervals_hold(*times):
        return MasumiLockCheck(False, c.ERR_MASUMI_DEADLINE, "deadline intervals below the minimum")
    if (
        options.max_deadline_horizon_ms is not None
        and times[-1] > int(time.time() * 1000) + options.max_deadline_horizon_ms
    ):
        return MasumiLockCheck(
            False, c.ERR_MASUMI_DEADLINE, "deadlines extend beyond the accepted horizon"
        )
    missing = object()
    for part in commitment["parts"]:
        content = part.get("content", missing)
        if content is missing:
            content = (options.local_commitment_content or {}).get(part["name"], missing)
        if content is missing:
            if options.require_all_part_content:
                return MasumiLockCheck(
                    False, c.ERR_MASUMI_COMMITMENT, f"part {part['name']} carries no content"
                )
            continue
        try:
            digest = commitment_part_digest(
                {"canonicalization": part["canonicalization"], "content": content}
            )
        except (ValueError, TypeError, OverflowError):
            return MasumiLockCheck(False, c.ERR_MASUMI_COMMITMENT, "invalid commitment content")
        if digest != part["digest"]:
            return MasumiLockCheck(
                False, c.ERR_MASUMI_COMMITMENT, f"part {part['name']} digest mismatch"
            )
    if compute_input_hash(commitment) != commitment["digest"]:
        return MasumiLockCheck(False, c.ERR_MASUMI_COMMITMENT, "commitment digest mismatch")
    deployment = resolve_masumi_deployment(requirements.network, extra.get("deployment"))
    if deployment is None:
        return MasumiLockCheck(
            False, c.ERR_MASUMI_DEPLOYMENT, "network has no canonical deployment"
        )
    try:
        escrow = masumi_escrow_address(requirements.network, deployment)
    except (ValueError, TypeError):
        return MasumiLockCheck(False, c.ERR_MASUMI_DEPLOYMENT, "invalid deployment")
    if escrow != requirements.pay_to:
        return MasumiLockCheck(
            False, c.ERR_MASUMI_DEPLOYMENT, "derived escrow does not equal payTo"
        )
    digest = compute_terms_digest(build_signed_terms(extra, requirements))
    if not verify_seller_terms_signature(
        extra["referenceKey"], extra["referenceSignature"], terms["sellerAddress"], digest
    ):
        return MasumiLockCheck(False, c.ERR_MASUMI_SELLER_SIGNATURE)
    if "deployment" in extra:
        if options.validate_custom_deployment is None or not options.validate_custom_deployment(
            {
                "network": requirements.network,
                "payTo": requirements.pay_to,
                "deployment": extra["deployment"],
            }
        ):
            return MasumiLockCheck(
                False, c.ERR_MASUMI_DEPLOYMENT, "custom deployment was not approved"
            )
    agent = terms.get("agentIdentifier") or ""
    if agent:
        if (
            not agent.startswith(MASUMI_REGISTRY_POLICY_ID)
            or options.validate_registry_claim is None
            or options.resource is None
            or not options.validate_registry_claim(
                {
                    "agentIdentifier": agent,
                    "sellerAddress": terms["sellerAddress"],
                    "network": requirements.network,
                    "amount": requirements.amount,
                    "asset": requirements.asset,
                    "resource": options.resource,
                }
            )
        ):
            return MasumiLockCheck(
                False, c.ERR_MASUMI_AGENT_IDENTIFIER, "registry claim was not validated"
            )
    identifier = decode_blockchain_identifier(extra["blockchainIdentifier"])
    expected = {
        "sellerNonce": terms["sellerNonce"],
        "agentIdentifier": agent,
        "buyerNonce": terms["buyerNonce"],
        "referenceSignature": extra["referenceSignature"],
        "referenceKey": extra["referenceKey"],
        "contractAddress": requirements.pay_to,
    }
    if identifier != expected:
        return MasumiLockCheck(False, c.ERR_MASUMI_IDENTIFIER)
    return MasumiLockCheck(True, escrow_address=escrow, terms_digest=digest)


def verify_masumi_lock(
    extra: dict[str, Any],
    requirements: PaymentRequirements,
    decoded: DecodedCardanoTransaction,
    payer: str,
    coins_per_utxo_byte: int | None = None,
    options: MasumiAuthorizationOptions | None = None,
) -> MasumiLockCheck:
    authorization = verify_masumi_authorization(extra, requirements, options)
    if not authorization.ok:
        return authorization
    terms = extra["terms"]
    outputs = [
        output for output in decoded.outputs if output.address == authorization.escrow_address
    ]
    if len(outputs) != 1:
        return MasumiLockCheck(False, c.ERR_MASUMI_ESCROW_OUTPUT_COUNT)
    output = outputs[0]
    if output.datum is None:
        return MasumiLockCheck(False, c.ERR_MASUMI_DATUM_MISSING)
    if output.has_reference_script:
        return MasumiLockCheck(False, c.ERR_MASUMI_REFERENCE_SCRIPT)
    view = parse_masumi_lock_datum(output.datum)
    if view is None:
        return MasumiLockCheck(False, c.ERR_MASUMI_DATUM_INVALID)
    invariants = verify_masumi_datum_invariants(view, requirements.pay_to)
    if not invariants.ok:
        return invariants
    if (
        decoded.ttl_slot is None
        or slot_to_posix_ms(requirements.network, decoded.ttl_slot) > view.pay_by_time
    ):
        return MasumiLockCheck(False, c.ERR_MASUMI_DEADLINE, "TTL is absent or after pay_by_time")
    if (
        view.buyer.payment.hash != address_credentials(payer).payment.hash
        or view.buyer.payment.hash not in decoded.vkey_hashes
    ):
        return MasumiLockCheck(
            False, c.ERR_MASUMI_DATUM_MISMATCH, "buyer does not control and witness the nonce input"
        )
    if view.seller != address_credentials(terms["sellerAddress"]):
        return MasumiLockCheck(False, c.ERR_MASUMI_DATUM_MISMATCH, "seller")
    seller_return = (
        address_credentials(terms["sellerReturnAddress"])
        if "sellerReturnAddress" in terms
        else None
    )
    if view.seller_return_address != seller_return:
        return MasumiLockCheck(False, c.ERR_MASUMI_DATUM_MISMATCH, "seller_return_address")
    expected = {
        "reference_key": extra["referenceKey"],
        "reference_signature": extra["referenceSignature"],
        "seller_nonce": terms["sellerNonce"],
        "buyer_nonce": terms["buyerNonce"],
        "agent_identifier": terms.get("agentIdentifier") or "",
        "input_hash": terms["inputHash"],
    }
    expected.update(
        {
            snake: int(terms[wire])
            for snake, wire in (
                ("pay_by_time", "payByTime"),
                ("submit_result_time", "submitResultTime"),
                ("unlock_time", "unlockTime"),
                ("external_dispute_unlock_time", "externalDisputeUnlockTime"),
            )
        }
    )
    for field, declared in expected.items():
        if getattr(view, field) != declared:
            return MasumiLockCheck(False, c.ERR_MASUMI_DATUM_MISMATCH, field)
    asset, amount = requirements.asset.lower(), int(requirements.amount)
    requested = amount if asset == c.LOVELACE_ASSET else 0
    collateral = view.collateral_return_lovelace
    if (
        collateral < 0
        or 0 < collateral < MASUMI_MIN_COLLATERAL_LOVELACE
        or output.coin != requested + collateral
    ):
        return MasumiLockCheck(False, c.ERR_MASUMI_COLLATERAL)
    if output.assets != ({} if asset == c.LOVELACE_ASSET else {asset: amount}):
        return MasumiLockCheck(False, c.ERR_MASUMI_ASSET)
    if coins_per_utxo_byte is not None and output.coin < masumi_min_utxo_lovelace(
        len(output.datum) // 2, len(output.assets), coins_per_utxo_byte
    ):
        return MasumiLockCheck(False, c.ERR_MASUMI_MIN_UTXO)
    return MasumiLockCheck(True)
