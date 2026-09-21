"""Issue per-request Masumi quotes from stable route templates."""

import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ....schemas import PaymentPayload, PaymentRequirements, ResourceInfo
from .masumi.blueprint import masumi_escrow_address, resolve_masumi_deployment
from .masumi.constants import MASUMI_MAX_DEADLINE_HORIZON_MS
from .masumi.digests import commitment_part_digest, compute_input_hash
from .masumi.issue import _UNSET, MasumiSellerSigner, issue_masumi_requirements


@dataclass(frozen=True)
class MasumiIssueContext:
    requirement: PaymentRequirements
    resource_info: ResourceInfo
    transport_context: Any = None


@dataclass(frozen=True)
class MasumiDeadlineOffsets:
    submit_result_after_pay_by_ms: int = 15 * 60_000
    unlock_after_pay_by_ms: int = 35 * 60_000
    external_dispute_unlock_after_pay_by_ms: int = 55 * 60_000


@dataclass
class MasumiIssuerConfig:
    seller: MasumiSellerSigner | Callable[[str], MasumiSellerSigner]
    seller_return_address: Any = _UNSET
    agent_identifier: Any = _UNSET
    deployment: dict[str, Any] | None = None
    commitment: Callable[[MasumiIssueContext], list[dict[str, Any]]] | None = None
    deadlines: MasumiDeadlineOffsets = field(default_factory=MasumiDeadlineOffsets)
    max_deadline_horizon_ms: int = MASUMI_MAX_DEADLINE_HORIZON_MS
    payment_payload_from_transport: Callable[[Any], PaymentPayload | None] | None = None


def is_masumi_extra(extra: Any) -> bool:
    return isinstance(extra, dict) and extra.get("assetTransferMethod") == "masumi"


def is_masumi_template(extra: Any) -> bool:
    return is_masumi_extra(extra) and "terms" not in extra


def payment_payload_from_transport_context(context: Any) -> PaymentPayload | None:
    if context is None:
        return None
    request = (
        context.get("request") if isinstance(context, dict) else getattr(context, "request", None)
    )
    header = (
        request.get("payment_header")
        if isinstance(request, dict)
        else getattr(request, "payment_header", None)
    )
    if isinstance(header, str) and header:
        try:
            return PaymentPayload.model_validate(json.loads(base64.b64decode(header)))
        except (ValueError, TypeError):
            pass
    meta = context.get("meta", {}) if isinstance(context, dict) else getattr(context, "meta", {})
    try:
        return PaymentPayload.model_validate(meta["x402/payment"])
    except (ValueError, TypeError, KeyError):
        return None


class MasumiQuoteIssuer:
    def __init__(self, config: MasumiIssuerConfig):
        self.config = config

    def assert_template(self, requirements: PaymentRequirements) -> None:
        extra = requirements.extra
        if extra.keys() - {
            "assetTransferMethod",
            "confirmationPolicy",
            "areFeesSponsored",
            "deployment",
        }:
            raise ValueError("Masumi template carries fields outside its closed schema")
        if (
            requirements.max_timeout_seconds * 1000
            + self.config.deadlines.external_dispute_unlock_after_pay_by_ms
            > self.config.max_deadline_horizon_ms
        ):
            raise ValueError(
                "Masumi template pushes externalDisputeUnlockTime past the accepted horizon"
            )
        deployment = resolve_masumi_deployment(
            requirements.network, extra.get("deployment", self.config.deployment)
        )
        if deployment is None:
            raise ValueError("Network has no canonical Masumi deployment")
        if requirements.pay_to != masumi_escrow_address(requirements.network, deployment):
            raise ValueError("Masumi route payTo must be the escrow address on network")

    def paid_payload(
        self, payload: PaymentPayload | None, transport_context: Any
    ) -> PaymentPayload | None:
        result = payload or payment_payload_from_transport_context(transport_context)
        if result is None and self.config.payment_payload_from_transport:
            result = self.config.payment_payload_from_transport(transport_context)
        return result

    def commitment(
        self, template: PaymentRequirements, resource: ResourceInfo | None, transport_context: Any
    ) -> list[dict[str, Any]]:
        if resource is None:
            raise ValueError("Masumi quote issuance requires resource information")
        config = self.config
        return (
            config.commitment(MasumiIssueContext(template, resource, transport_context))
            if config.commitment
            else [
                {
                    "name": "resource",
                    "canonicalization": "jcs",
                    "mediaType": "application/json",
                    "content": {"url": resource.url},
                }
            ]
        )

    @staticmethod
    def commitment_digest(parts: list[dict[str, Any]]) -> str:
        manifest = [
            {
                **{
                    key: part[key]
                    for key in ("name", "canonicalization", "mediaType")
                    if key in part
                },
                "digest": commitment_part_digest(part),
            }
            for part in parts
        ]
        return compute_input_hash({"version": "1", "algorithm": "sha256", "parts": manifest})

    def issue(
        self,
        template: PaymentRequirements,
        resource: ResourceInfo | None,
        transport_context: Any,
        *,
        commitment: list[dict[str, Any]] | None = None,
    ) -> PaymentRequirements:
        config = self.config
        seller = config.seller(template.network) if callable(config.seller) else config.seller
        if commitment is None:
            commitment = self.commitment(template, resource, transport_context)
        pay_by = int(time.time() * 1000) + template.max_timeout_seconds * 1000
        offsets = config.deadlines
        issued = issue_masumi_requirements(
            network=template.network,
            asset=template.asset,
            amount=template.amount,
            max_timeout_seconds=template.max_timeout_seconds,
            seller_address=seller.seller_address,
            sign_terms=seller.sign_terms,
            commitment=commitment,
            pay_by_time=str(pay_by),
            submit_result_time=str(pay_by + offsets.submit_result_after_pay_by_ms),
            unlock_time=str(pay_by + offsets.unlock_after_pay_by_ms),
            external_dispute_unlock_time=str(
                pay_by + offsets.external_dispute_unlock_after_pay_by_ms
            ),
            seller_return_address=config.seller_return_address,
            agent_identifier=config.agent_identifier,
            confirmation_policy=template.extra.get("confirmationPolicy", _UNSET),
            deployment=template.extra.get("deployment", config.deployment),
            max_deadline_horizon_ms=config.max_deadline_horizon_ms,
        )
        if issued.pay_to != template.pay_to:
            raise ValueError("Masumi route payTo must equal the issued escrow address")
        if "areFeesSponsored" in template.extra:
            issued.extra["areFeesSponsored"] = template.extra["areFeesSponsored"]
        return template.model_copy(update={"extra": issued.extra})
