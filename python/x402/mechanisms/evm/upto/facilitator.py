"""EVM facilitator implementation for the Upto payment scheme."""

import random
from dataclasses import dataclass
from typing import Any

from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..constants import SCHEME_UPTO
from ..signer import FacilitatorEvmSigner
from ..types import is_upto_permit2_payload
from .permit2_utils import settle_upto_permit2, verify_upto_permit2


@dataclass
class UptoEvmSchemeConfig:
    """Configuration for upto facilitator behavior."""

    simulate_in_settle: bool = False


class UptoEvmScheme:
    """EVM facilitator implementation for the Upto payment scheme.

    Attributes:
        scheme: The scheme identifier ("upto").
        caip_family: The CAIP family pattern ("eip155:*").
    """

    scheme = SCHEME_UPTO
    caip_family = "eip155:*"

    def __init__(
        self,
        signer: FacilitatorEvmSigner,
        config: UptoEvmSchemeConfig | None = None,
    ):
        self._signer = signer
        self._config = config or UptoEvmSchemeConfig()

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Return facilitatorAddress so clients can bind the witness to this facilitator."""
        addresses = self._signer.get_addresses()
        if not addresses:
            return None
        return {"facilitatorAddress": random.choice(addresses)}

    def get_signers(self, network: Network) -> list[str]:
        return self._signer.get_addresses()

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> VerifyResponse:
        if not is_upto_permit2_payload(payload.payload):
            return VerifyResponse(
                is_valid=False, invalid_reason="unsupported_payload_type", payer=""
            )
        return verify_upto_permit2(self._signer, payload, requirements, context, simulate=True)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> SettleResponse:
        if not is_upto_permit2_payload(payload.payload):
            return SettleResponse(
                success=False,
                error_reason="unsupported_payload_type",
                network=str(payload.accepted.network),
                payer="",
                transaction="",
            )
        return settle_upto_permit2(
            self._signer,
            payload,
            requirements,
            context,
            simulate_in_settle=self._config.simulate_in_settle,
        )
