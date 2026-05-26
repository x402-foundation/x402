"""EVM client implementation for Exact payment scheme (V1 legacy)."""

from __future__ import annotations

import json
import time
from typing import Any

from .....schemas.v1 import PaymentRequirementsV1
from ...constants import SCHEME_EXACT
from ...eip712 import build_typed_data_for_signing
from ...signer import ClientEvmSigner
from ...types import ExactEIP3009Authorization, ExactEIP3009Payload, TypedDataField
from ...utils import create_nonce
from ...v1.utils import get_asset_info, get_evm_chain_id


class ExactEvmSchemeV1:
    """EVM client implementation for Exact payment scheme (V1).

    Implements SchemeNetworkClientV1 protocol. Returns the inner payload dict,
    which x402Client wraps into a full PaymentPayloadV1.

    V1 differences:
    - Uses maxAmountRequired from requirements
    - Legacy network names (base-sepolia, not eip155:84532)

    Attributes:
        scheme: The scheme identifier ("exact").
    """

    scheme = SCHEME_EXACT

    def __init__(self, signer: ClientEvmSigner):
        """Create ExactEvmSchemeV1.

        Args:
            signer: EVM signer for payment authorizations. Can also be an
                eth_account LocalAccount, which will be auto-wrapped in
                EthAccountSigner.
        """
        from ..client import _wrap_if_local_account

        self._signer = _wrap_if_local_account(signer)

    def create_payment_payload(
        self,
        requirements: PaymentRequirementsV1,
    ) -> dict[str, Any]:
        """Create signed EIP-3009 inner payload (V1 format).

        Args:
            requirements: V1 payment requirements.

        Returns:
            Inner payload dict (authorization + signature).
            x402Client wraps this with x402_version, scheme, network.
        """
        nonce = create_nonce()
        now = int(time.time())

        # V1: validAfter is 10 minutes before now
        valid_after = now - 600

        # V1: Uses maxTimeoutSeconds (default 10 min)
        timeout = requirements.max_timeout_seconds or 600
        valid_before = now + timeout

        authorization = ExactEIP3009Authorization(
            from_address=self._signer.address,
            to=requirements.pay_to,
            value=requirements.max_amount_required,  # V1 field name
            valid_after=str(valid_after),
            valid_before=str(valid_before),
            nonce=nonce,
        )

        signature = self._sign_authorization(authorization, requirements)

        payload = ExactEIP3009Payload(authorization=authorization, signature=signature)

        # Return inner payload dict - x402Client wraps this
        return payload.to_dict()

    def _sign_authorization(
        self,
        authorization: ExactEIP3009Authorization,
        requirements: PaymentRequirementsV1,
    ) -> str:
        """Sign EIP-3009 authorization using EIP-712.

        V1 uses legacy network names for chain ID lookup.

        Args:
            authorization: The authorization to sign.
            requirements: V1 payment requirements.

        Returns:
            Hex-encoded signature.
        """
        # V1: Legacy network name -> chain ID
        chain_id = get_evm_chain_id(requirements.network)

        # V1: extra is JSON-encoded, need to parse
        extra = requirements.extra or {}
        if isinstance(extra, str):
            extra = json.loads(extra)

        if "name" not in extra or "version" not in extra:
            # Try to get from asset info
            try:
                asset_info = get_asset_info(requirements.network, requirements.asset)
                extra.setdefault("name", asset_info["name"])
                extra.setdefault("version", asset_info["version"])
            except ValueError:
                pass

        if "name" not in extra:
            raise ValueError("EIP-712 domain name required in extra")

        domain, types, primary_type, message = build_typed_data_for_signing(
            authorization,
            chain_id,
            requirements.asset,
            extra["name"],
            extra.get("version", "1"),
        )

        # Convert types dict to match signer protocol
        typed_fields: dict[str, list[TypedDataField]] = {}
        for type_name, fields in types.items():
            typed_fields[type_name] = [
                TypedDataField(name=f["name"], type=f["type"]) for f in fields
            ]

        sig_bytes = self._signer.sign_typed_data(domain, typed_fields, primary_type, message)

        return "0x" + sig_bytes.hex()
