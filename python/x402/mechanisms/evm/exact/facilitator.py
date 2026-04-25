"""EVM facilitator implementation for the Exact payment scheme (V2)."""

import time
from dataclasses import dataclass
from typing import Any

from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..constants import (
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
from ..erc6492 import has_deployment_info, parse_erc6492_signature
from ..exact.eip3009_utils import (
    classify_eip3009_signature,
    diagnose_eip3009_simulation_failure,
    execute_transfer_with_authorization,
    parse_eip3009_authorization,
    parse_eip3009_transfer_error,
    simulate_eip3009_transfer,
)
from ..exact.permit2_utils import settle_permit2, verify_permit2
from ..signer import FacilitatorEvmSigner
from ..types import ERC6492SignatureData, ExactEIP3009Payload, is_permit2_payload
from ..utils import bytes_to_hex, get_evm_chain_id, hex_to_bytes, normalize_address


@dataclass
class ExactEvmSchemeConfig:
    """Configuration for ExactEvmScheme facilitator."""

    deploy_erc4337_with_eip6492: bool = False
    """Enable automatic smart wallet deployment via EIP-6492."""

    simulate_in_settle: bool = False
    """Rerun transfer simulation during settle."""


class ExactEvmScheme:
    """EVM facilitator implementation for the Exact payment scheme (V2).

    Verifies and settles EIP-3009 payments on EVM networks.

    Attributes:
        scheme: The scheme identifier ("exact").
        caip_family: The CAIP family pattern ("eip155:*").
    """

    scheme = SCHEME_EXACT
    caip_family = "eip155:*"

    def __init__(
        self,
        signer: FacilitatorEvmSigner,
        config: ExactEvmSchemeConfig | None = None,
    ):
        """Create ExactEvmScheme facilitator.

        Args:
            signer: EVM signer for verification and settlement.
            config: Optional configuration.
        """
        self._signer = signer
        self._config = config or ExactEvmSchemeConfig()

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
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> VerifyResponse:
        if is_permit2_payload(payload.payload):
            return verify_permit2(self._signer, payload, requirements, context)
        return self._verify(payload, requirements, simulate=True)

    def _verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        simulate: bool,
    ) -> VerifyResponse:
        """Verify EIP-3009 payment payload.

        Validates:
        - Scheme and network match
        - Signature is valid (EOA, EIP-1271, or ERC-6492)
        - Recipient matches requirements.pay_to
        - Amount exactly matches requirements.amount
        - Validity window is correct
        - Nonce hasn't been used
        - Payer has sufficient balance

        Args:
            payload: Payment payload from client.
            requirements: Payment requirements.

        Returns:
            VerifyResponse with is_valid and payer.
        """
        evm_payload = ExactEIP3009Payload.from_dict(payload.payload)
        payer = evm_payload.authorization.from_address
        network = str(requirements.network)

        # Validate scheme
        if payload.accepted.scheme != SCHEME_EXACT:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer=payer
            )

        # Validate network
        if payload.accepted.network != requirements.network:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer=payer)

        # Parse chain ID from network identifier
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

        # Check EIP-712 domain params
        extra = requirements.extra or {}
        if "name" not in extra or "version" not in extra:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_MISSING_EIP712_DOMAIN, payer=payer
            )

        # Validate recipient
        if evm_payload.authorization.to.lower() != requirements.pay_to.lower():
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_RECIPIENT_MISMATCH, payer=payer
            )

        # Validate amount
        if int(evm_payload.authorization.value) != int(requirements.amount):
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_AUTHORIZATION_VALUE_MISMATCH,
                payer=payer,
            )

        # Validate timing
        now = int(time.time())

        # Check validBefore is in future (6 second buffer)
        if int(evm_payload.authorization.valid_before) < now + 6:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_VALID_BEFORE_EXPIRED, payer=payer
            )

        # Check validAfter is not in future
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
                    int(requirements.amount),
                    extra["name"],
                    extra["version"],
                ),
                payer=payer,
            )

        return VerifyResponse(is_valid=True, payer=payer)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> SettleResponse:
        """Settle payment on-chain.

        Routes to Permit2 or EIP-3009 settlement based on payload type.
        For EIP-3009:
        - Re-verifies payment
        - Deploys smart wallet if configured and needed (ERC-6492)
        - Calls transferWithAuthorization (v,r,s or bytes overload)
        - Waits for transaction confirmation

        Args:
            payload: Verified payment payload.
            requirements: Payment requirements.

        Returns:
            SettleResponse with success, transaction, and payer.
        """
        if is_permit2_payload(payload.payload):
            return settle_permit2(self._signer, payload, requirements, context)

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
                network=str(payload.accepted.network),
                payer=verify_result.payer,
                transaction="",
            )

        evm_payload = ExactEIP3009Payload.from_dict(payload.payload)
        payer = evm_payload.authorization.from_address
        network = str(requirements.network)
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
                error_reason=parse_eip3009_transfer_error(e),
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
