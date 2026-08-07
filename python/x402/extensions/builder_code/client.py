"""Client-side extension for the Builder Code Extension.

Attaches the client's service code(s) (``s``) to the payment payload.
"""

from __future__ import annotations

from ...schemas import PaymentPayload, PaymentRequired
from .types import BUILDER_CODE, BUILDER_CODE_PATTERN, MAX_CLIENT_SERVICE_CODES


class BuilderCodeClientExtension:
    """Client extension that adds builder-code attribution to payment payloads.

    Example:
        ```python
        from x402.extensions.builder_code import BuilderCodeClientExtension

        client.register_extension(BuilderCodeClientExtension("bc_my_client"))
        ```
    """

    key = BUILDER_CODE

    def __init__(self, service_codes: str | list[str]) -> None:
        """Create a client extension attaching the given service code(s).

        Accepts a single code or a list of codes so layered clients (e.g. an MCP
        middleware) can attribute multiple participants. Codes are normalized to a
        list and sent as the ``s`` field.

        Args:
            service_codes: Client service code(s) (``s``), each 1-32 lowercase
                alphanumeric/underscore characters.

        Raises:
            ValueError: If any code is not a valid builder code, or if more than
                ``MAX_CLIENT_SERVICE_CODES`` are given.
        """
        codes = [service_codes] if isinstance(service_codes, str) else list(service_codes)
        if len(codes) > MAX_CLIENT_SERVICE_CODES:
            raise ValueError(
                f"Too many service codes: {len(codes)} exceeds the maximum of "
                f"{MAX_CLIENT_SERVICE_CODES}."
            )
        for code in codes:
            if not BUILDER_CODE_PATTERN.match(code):
                raise ValueError(
                    f'Invalid builder code: "{code}". '
                    "Must be 1-32 characters, lowercase alphanumeric and underscores only."
                )
        self._service_codes = codes

    def enrich_payment_payload(
        self,
        payment_payload: PaymentPayload,
        payment_required: PaymentRequired,
    ) -> PaymentPayload:
        """Attach this client's service code(s) (``s``).

        The core client re-merge restores the server-declared ``a`` and schema after
        enrichment, so this only populates the client-owned ``s`` field.

        Args:
            payment_payload: Payment payload to enrich.
            payment_required: Server payment requirements (unused; core merges server data).

        Returns:
            Payment payload with builder-code service codes attached.
        """
        extensions = dict(payment_payload.extensions or {})
        extensions[BUILDER_CODE] = {"info": {"s": self._service_codes}}
        return payment_payload.model_copy(update={"extensions": extensions})
