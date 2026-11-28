"""EVM client implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

import time
from typing import Any

from ....schemas import PaymentRequirements
from ..constants import SCHEME_EXACT
from ..default_assets import find_default_asset
from ..eip712 import build_typed_data_for_signing
from ..gas_sponsoring import try_sign_gas_sponsoring_extensions
from ..signer import (
    ClientEvmSigner,
)
from ..types import ExactEIP3009Authorization, ExactEIP3009Payload, TypedDataField
from ..utils import (
    create_nonce,
    get_asset_info,
    get_evm_chain_id,
)
from .permit2_utils import create_permit2_payload


def _wrap_if_local_account(signer: Any) -> ClientEvmSigner:
    """Auto-wrap an eth_account-compatible signer (any BaseAccount) in EthAccountSigner."""
    try:
        from eth_account.signers.base import BaseAccount

        if isinstance(signer, BaseAccount):
            from ..signers import EthAccountSigner

            return EthAccountSigner(signer)
    except ImportError:
        pass
    return signer


class ExactEvmScheme:
    """EVM client implementation for the Exact payment scheme (V2).

    Implements SchemeNetworkClient protocol. Returns the inner payload dict,
    which x402Client wraps into a full PaymentPayload.

    For Permit2 flows, if the server advertises gas sponsoring extensions
    and the signer has the required capabilities, the scheme automatically
    signs extension data when Permit2 allowance is insufficient.

    Attributes:
        scheme: The scheme identifier ("exact").
    """

    scheme = SCHEME_EXACT
    find_default_asset = staticmethod(find_default_asset)

    def __init__(self, signer: ClientEvmSigner):
        """Create ExactEvmScheme.

        Args:
            signer: EVM signer for payment authorizations. Can also be an
                eth_account LocalAccount, which will be auto-wrapped in
                EthAccountSigner.
        """
        self._signer = _wrap_if_local_account(signer)

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create signed payment inner payload.

        Routes to Permit2 or EIP-3009 based on requirements.extra.assetTransferMethod.
        For Permit2, enriches with gas sponsoring extensions when advertised.

        Args:
            requirements: Payment requirements from server.
            extensions: Server-declared extensions from PaymentRequired.

        Returns:
            Inner payload dict.
            x402Client wraps this with x402_version, accepted, resource, extensions.
        """
        extra = requirements.extra or {}
        if extra.get("assetTransferMethod") == "permit2":
            result = create_permit2_payload(self._signer, requirements)

            if extensions:
                ext_data = try_sign_gas_sponsoring_extensions(
                    self._signer, requirements, result, extensions
                )
                if ext_data:
                    result["__extensions"] = ext_data

            return result

        nonce = create_nonce()
        now = int(time.time())
        valid_after = "0"
        valid_before = str(now + (requirements.max_timeout_seconds or 3600))

        authorization = ExactEIP3009Authorization(
            from_address=self._signer.address,
            to=requirements.pay_to,
            value=requirements.amount,
            valid_after=valid_after,
            valid_before=valid_before,
            nonce=nonce,
        )

        signature = self._sign_authorization(authorization, requirements)

        payload = ExactEIP3009Payload(authorization=authorization, signature=signature)

        return payload.to_dict()

    def _sign_authorization(
        self,
        authorization: ExactEIP3009Authorization,
        requirements: PaymentRequirements,
    ) -> str:
        """Sign EIP-3009 authorization using EIP-712.

        Requires requirements.extra to contain 'name' and 'version'
        for the EIP-712 domain separator.

        Args:
            authorization: The authorization to sign.
            requirements: Payment requirements with EIP-712 domain info.

        Returns:
            Hex-encoded signature with 0x prefix.

        Raises:
            ValueError: If EIP-712 domain parameters are missing.
        """
        chain_id = get_evm_chain_id(str(requirements.network))

        extra = requirements.extra or {}
        if "name" not in extra:
            # Try to get from asset info
            try:
                asset_info = get_asset_info(str(requirements.network), requirements.asset)
                extra["name"] = asset_info["name"]
                extra["version"] = asset_info.get("version", "1")
            except ValueError:
                raise ValueError(
                    "EIP-712 domain parameters (name, version) required in extra"
                ) from None

        name = extra["name"]
        version = extra.get("version", "1")

        domain, types, primary_type, message = build_typed_data_for_signing(
            authorization,
            chain_id,
            requirements.asset,
            name,
            version,
        )

        # Convert types dict to match signer protocol
        typed_fields: dict[str, list[TypedDataField]] = {}
        for type_name, fields in types.items():
            typed_fields[type_name] = [
                TypedDataField(name=f["name"], type=f["type"]) for f in fields
            ]

        sig_bytes = self._signer.sign_typed_data(domain, typed_fields, primary_type, message)

        return "0x" + sig_bytes.hex()
