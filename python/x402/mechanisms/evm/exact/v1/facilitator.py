"""EVM facilitator implementation for Exact payment scheme (V1 legacy)."""

import json
import time
from dataclasses import dataclass
from typing import Any

from .....schemas import Network, SettleResponse, VerifyResponse
from .....schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1
from ...constants import (
    ERR_AUTHORIZATION_VALUE_MISMATCH,
    ERR_FAILED_TO_GET_NETWORK_CONFIG,
    ERR_FAILED_TO_VERIFY_SIGNATURE,
    ERR_INVALID_SIGNATURE,
    ERR_MISSING_EIP712_DOMAIN,
    ERR_NETWORK_MISMATCH,
    ERR_RECIPIENT_MISMATCH,
    ERR_SMART_WALLET_DEPLOYMENT_FAILED,
    ERR_TRANSACTION_FAILED,
    ERR_UNDEPLOYED_SMART_WALLET,
    ERR_UNSUPPORTED_SCHEME,
    ERR_VALID_AFTER_FUTURE,
    ERR_VALID_BEFORE_EXPIRED,
    SCHEME_EXACT,
    TX_STATUS_SUCCESS,
)
from ...erc6492 import has_deployment_info, parse_erc6492_signature
from ...signer import FacilitatorEvmSigner
from ...types import ERC6492SignatureData, ExactEIP3009Payload
from ...utils import bytes_to_hex, hex_to_bytes, normalize_address
from ...v1.utils import get_evm_chain_id
from ..eip3009_utils import (
    classify_eip3009_signature,
    diagnose_eip3009_simulation_failure,
    execute_transfer_with_authorization,
    parse_eip3009_authorization,
    simulate_eip3009_transfer,
)


@dataclass
class ExactEvmSchemeV1Config:
    """Configuration for ExactEvmSchemeV1 facilitator."""

    deploy_erc4337_with_eip6492: bool = False
    """Enable automatic smart wallet deployment via EIP-6492."""

    simulate_in_settle: bool = False
    """Rerun transfer simulation during settle."""


class ExactEvmSchemeV1:
    """EVM facilitator implementation for Exact payment scheme (V1).

    V1 differences:
    - scheme/network at payload top level
    - Uses maxAmountRequired from requirements
    - Legacy network names
    - extra field is JSON-encoded

    Attributes:
        scheme: The scheme identifier ("exact").
        caip_family: The CAIP family pattern ("eip155:*").
    """

    scheme = SCHEME_EXACT
    caip_family = "eip155:*"

    def __init__(
        self,
        signer: FacilitatorEvmSigner,
        config: ExactEvmSchemeV1Config | None = None,
    ):
        """Create ExactEvmSchemeV1 facilitator.

        Args:
            signer: EVM signer for verification/settlement.
            config: Optional configuration.
        """
        self._signer = signer
        self._config = config or ExactEvmSchemeV1Config()

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get mechanism-specific extra data. EVM: None.

        Args:
            network: Network identifier.

        Returns:
            None for EVM scheme.
        """
        return None

    def get_signers(self, network: Network) -> list[str]:
        """Get facilitator wallet addresses.

        Args:
            network: Network identifier.

        Returns:
            List of facilitator addresses.
        """
        return self._signer.get_addresses()

    def verify(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
        context=None,
    ) -> VerifyResponse:
        return self._verify(payload, requirements, simulate=True)

    def _verify(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
        simulate: bool,
    ) -> VerifyResponse:
        """Verify EIP-3009 payment payload (V1).

        V1 validation differences:
        - scheme/network at top level of payload
        - Uses maxAmountRequired for exact amount validation
        - extra is JSON-encoded

        Args:
            payload: V1 payment payload.
            requirements: V1 payment requirements.

        Returns:
            VerifyResponse with is_valid and payer.
        """
        evm_payload = ExactEIP3009Payload.from_dict(payload.payload)
        payer = evm_payload.authorization.from_address
        network = requirements.network

        # V1: Validate scheme at top level
        if payload.scheme != SCHEME_EXACT or requirements.scheme != SCHEME_EXACT:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer=payer
            )

        # V1: Validate network at top level
        if payload.network != requirements.network:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer=payer)

        # V1: Legacy chain ID lookup
        try:
            chain_id = get_evm_chain_id(network)
        except ValueError as e:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_FAILED_TO_GET_NETWORK_CONFIG,
                invalid_message=str(e),
                payer=payer,
            )

        token_address = normalize_address(requirements.asset)

        # V1: Parse JSON-encoded extra
        extra = requirements.extra or {}
        if isinstance(extra, str):
            extra = json.loads(extra)

        if "name" not in extra or "version" not in extra:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_MISSING_EIP712_DOMAIN, payer=payer
            )

        # Validate recipient
        if evm_payload.authorization.to.lower() != requirements.pay_to.lower():
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_RECIPIENT_MISMATCH, payer=payer
            )

        # V1: Use maxAmountRequired
        if int(evm_payload.authorization.value) != int(requirements.max_amount_required):
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_AUTHORIZATION_VALUE_MISMATCH,
                payer=payer,
            )

        # V1: Check validBefore is in future (6 second buffer)
        now = int(time.time())
        if int(evm_payload.authorization.valid_before) < now + 6:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_VALID_BEFORE_EXPIRED, payer=payer
            )

        # V1: Check validAfter is not in future
        if int(evm_payload.authorization.valid_after) > now:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_VALID_AFTER_FUTURE, payer=payer
            )

        # Verify signature
        if not evm_payload.signature:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_SIGNATURE, payer=payer)

        try:
            signature = hex_to_bytes(evm_payload.signature)
            classification = classify_eip3009_signature(
                self._signer,
                evm_payload.authorization,
                signature,
                chain_id,
                token_address,
                extra["name"],
                extra["version"],
            )
            if not classification.valid and classification.is_undeployed:
                if not has_deployment_info(classification.sig_data):
                    return VerifyResponse(
                        is_valid=False,
                        invalid_reason=ERR_UNDEPLOYED_SMART_WALLET,
                        payer=payer,
                    )

            if not classification.valid and not classification.is_smart_wallet:
                return VerifyResponse(
                    is_valid=False, invalid_reason=ERR_INVALID_SIGNATURE, payer=payer
                )
        except Exception as e:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_FAILED_TO_VERIFY_SIGNATURE,
                invalid_message=str(e),
                payer=payer,
            )

        if not simulate:
            return VerifyResponse(is_valid=True, payer=payer)

        try:
            parsed_authorization = parse_eip3009_authorization(evm_payload.authorization)
        except Exception as e:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_FAILED_TO_VERIFY_SIGNATURE,
                invalid_message=str(e),
                payer=payer,
            )

        if not simulate_eip3009_transfer(
            self._signer,
            token_address,
            parsed_authorization,
            classification.sig_data,
        ):
            return VerifyResponse(
                is_valid=False,
                invalid_reason=diagnose_eip3009_simulation_failure(
                    self._signer,
                    token_address,
                    evm_payload.authorization,
                    int(requirements.max_amount_required),
                    extra["name"],
                    extra["version"],
                ),
                payer=payer,
            )

        return VerifyResponse(is_valid=True, payer=payer)

    def settle(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
        context=None,
    ) -> SettleResponse:
        """Settle EIP-3009 payment on-chain (V1).

        Same settlement logic as V2, but uses V1 payload/requirements.

        Args:
            payload: V1 payment payload.
            requirements: V1 payment requirements.

        Returns:
            SettleResponse with success, transaction, and payer.
        """
        # First verify
        verify_result = self._verify(
            payload,
            requirements,
            simulate=self._config.simulate_in_settle,
        )
        if not verify_result.is_valid:
            return SettleResponse(
                success=False,
                error_reason=verify_result.invalid_reason,
                network=payload.network,
                payer=verify_result.payer,
                transaction="",
            )

        evm_payload = ExactEIP3009Payload.from_dict(payload.payload)
        payer = evm_payload.authorization.from_address
        network = requirements.network
        token_address = normalize_address(requirements.asset)

        try:
            signature = hex_to_bytes(evm_payload.signature or "")
            sig_data = parse_erc6492_signature(signature)
            parsed_authorization = parse_eip3009_authorization(evm_payload.authorization)
        except Exception as e:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                network=network,
                payer=payer,
                transaction="",
            )

        # Deploy smart wallet if needed
        if has_deployment_info(sig_data):
            code = self._signer.get_code(payer)
            if len(code) == 0:
                if self._config.deploy_erc4337_with_eip6492:
                    try:
                        self._deploy_smart_wallet(sig_data)
                    except Exception as e:
                        return SettleResponse(
                            success=False,
                            error_reason=ERR_SMART_WALLET_DEPLOYMENT_FAILED,
                            error_message=str(e),
                            network=network,
                            payer=payer,
                            transaction="",
                        )
                else:
                    return SettleResponse(
                        success=False,
                        error_reason=ERR_UNDEPLOYED_SMART_WALLET,
                        network=network,
                        payer=payer,
                        transaction="",
                    )

        try:
            tx_hash = execute_transfer_with_authorization(
                self._signer,
                token_address,
                parsed_authorization,
                sig_data,
            )
            receipt = self._signer.wait_for_transaction_receipt(tx_hash)
            if receipt.status != TX_STATUS_SUCCESS:
                return SettleResponse(
                    success=False,
                    error_reason=ERR_TRANSACTION_FAILED,
                    transaction=tx_hash,
                    network=network,
                    payer=payer,
                )

            return SettleResponse(
                success=True,
                transaction=tx_hash,
                network=network,
                payer=payer,
            )

        except Exception as e:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                network=network,
                payer=payer,
                transaction="",
            )

    def _deploy_smart_wallet(self, sig_data: ERC6492SignatureData) -> None:
        """Deploy ERC-4337 smart wallet via ERC-6492 factory.

        Args:
            sig_data: Parsed signature with factory and calldata.

        Raises:
            RuntimeError: If deployment fails.
        """
        factory_addr = bytes_to_hex(sig_data.factory)
        tx_hash = self._signer.send_transaction(factory_addr, sig_data.factory_calldata)
        receipt = self._signer.wait_for_transaction_receipt(tx_hash)
        if receipt.status != TX_STATUS_SUCCESS:
            raise RuntimeError(ERR_SMART_WALLET_DEPLOYMENT_FAILED)
