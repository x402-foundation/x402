"""Shared helpers for the settlement_pending integration tests
(test_evm_settlement_pending.py, test_svm_settlement_pending.py,
test_evm_batch_settlement_settlement_pending.py).
"""

from __future__ import annotations

from typing import Any

from x402.schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse


class SingleSchemeFacilitatorClientSync:
    """Adapts a single-scheme, single-network facilitator scheme (verify/settle/get_extra/
    get_signers) to the FacilitatorClient surface used by x402ResourceServerSync.
    """

    x402_version = 2

    def __init__(self, scheme: str, network: str, facilitator_scheme: Any) -> None:
        self.scheme = scheme
        self.network = network
        self._facilitator_scheme = facilitator_scheme

    def verify(self, payload: PaymentPayload, requirements: PaymentRequirements) -> VerifyResponse:
        return self._facilitator_scheme.verify(payload, requirements)

    def settle(self, payload: PaymentPayload, requirements: PaymentRequirements) -> SettleResponse:
        return self._facilitator_scheme.settle(payload, requirements)

    def get_supported(self):
        from x402.schemas import SupportedKind, SupportedResponse

        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=self.x402_version,
                    scheme=self.scheme,
                    network=self.network,
                    extra=self._facilitator_scheme.get_extra(self.network),
                )
            ],
            extensions=[],
            signers={self.network: self._facilitator_scheme.get_signers(self.network)},
        )
