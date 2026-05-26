"""EVM client implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from ....schemas import PaymentRequirements
from ..constants import ERC20_ALLOWANCE_ABI, PERMIT2_ADDRESS, SCHEME_EXACT
from ..eip712 import build_typed_data_for_signing
from ..signer import (
    ClientEvmSigner,
    ClientEvmSignerWithReadContract,
    ClientEvmSignerWithSignTransaction,
)
from ..types import ExactEIP3009Authorization, ExactEIP3009Payload, TypedDataField
from ..utils import (
    create_nonce,
    create_validity_window,
    get_asset_info,
    get_evm_chain_id,
    normalize_address,
)
from .permit2_utils import create_permit2_payload


def _wrap_if_local_account(signer: Any) -> ClientEvmSigner:
    """Auto-wrap eth_account LocalAccount in EthAccountSigner if needed."""
    try:
        from eth_account.signers.local import LocalAccount

        if isinstance(signer, LocalAccount):
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
                ext_data = self._try_sign_extensions(requirements, result, extensions)
                if ext_data:
                    result["__extensions"] = ext_data

            return result

        nonce = create_nonce()
        valid_after, valid_before = create_validity_window(
            timedelta(seconds=requirements.max_timeout_seconds or 3600)
        )

        authorization = ExactEIP3009Authorization(
            from_address=self._signer.address,
            to=requirements.pay_to,
            value=requirements.amount,
            valid_after=str(valid_after),
            valid_before=str(valid_before),
            nonce=nonce,
        )

        signature = self._sign_authorization(authorization, requirements)

        payload = ExactEIP3009Payload(authorization=authorization, signature=signature)

        return payload.to_dict()

    def _try_sign_extensions(
        self,
        requirements: PaymentRequirements,
        result: dict[str, Any],
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Try to sign gas sponsoring extensions for Permit2 flows."""

        # Try EIP-2612 first
        eip2612_ext = self._try_sign_eip2612(requirements, result, extensions)
        if eip2612_ext:
            return eip2612_ext

        # Try ERC-20 approval fallback
        erc20_ext = self._try_sign_erc20_approval(requirements, extensions)
        if erc20_ext:
            return erc20_ext

        return None

    def _try_sign_eip2612(
        self,
        requirements: PaymentRequirements,
        result: dict[str, Any],
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Try to sign an EIP-2612 permit for gasless Permit2 approval."""
        from ....extensions.eip2612_gas_sponsoring import EIP2612_GAS_SPONSORING_KEY
        from ....extensions.eip2612_gas_sponsoring.client import sign_eip2612_permit

        if EIP2612_GAS_SPONSORING_KEY not in extensions:
            return None

        if not isinstance(self._signer, ClientEvmSignerWithReadContract):
            return None

        extra = requirements.extra or {}
        token_name = extra.get("name")
        token_version = extra.get("version")
        if not token_name or not token_version:
            return None

        chain_id = get_evm_chain_id(str(requirements.network))
        token_address = normalize_address(requirements.asset)

        try:
            allowance = self._signer.read_contract(
                token_address,
                ERC20_ALLOWANCE_ABI,
                "allowance",
                self._signer.address,
                PERMIT2_ADDRESS,
            )
            if int(allowance) >= int(requirements.amount):
                return None
        except Exception:
            pass  # Allowance check failed, proceed with signing

        permit2_auth = result.get("permit2Authorization", {})
        deadline = permit2_auth.get("deadline", "")
        if not deadline:
            import time

            deadline = str(int(time.time()) + (requirements.max_timeout_seconds or 3600))

        info = sign_eip2612_permit(
            self._signer,
            token_address,
            token_name,
            token_version,
            chain_id,
            deadline,
            requirements.amount,
        )

        return {EIP2612_GAS_SPONSORING_KEY: {"info": info.to_dict()}}

    def _try_sign_erc20_approval(
        self,
        requirements: PaymentRequirements,
        extensions: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Try to sign an ERC-20 approval tx for gasless Permit2 approval."""
        from ....extensions.erc20_approval_gas_sponsoring import (
            ERC20_APPROVAL_GAS_SPONSORING_KEY,
        )
        from ....extensions.erc20_approval_gas_sponsoring.client import (
            sign_erc20_approval_transaction,
        )

        if ERC20_APPROVAL_GAS_SPONSORING_KEY not in extensions:
            return None

        if not isinstance(self._signer, ClientEvmSignerWithSignTransaction):
            return None

        chain_id = get_evm_chain_id(str(requirements.network))
        token_address = normalize_address(requirements.asset)

        # Skip if allowance is already sufficient
        if isinstance(self._signer, ClientEvmSignerWithReadContract):
            try:
                allowance = self._signer.read_contract(
                    token_address,
                    ERC20_ALLOWANCE_ABI,
                    "allowance",
                    self._signer.address,
                    PERMIT2_ADDRESS,
                )
                if int(allowance) >= int(requirements.amount):
                    return None
            except Exception:
                pass

        info = sign_erc20_approval_transaction(
            self._signer,
            token_address,
            chain_id,
        )

        return {ERC20_APPROVAL_GAS_SPONSORING_KEY: {"info": info.to_dict()}}

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
