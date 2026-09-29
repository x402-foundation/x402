"""EVM facilitator implementation for the Exact payment scheme (V2)."""

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from ....pending_settlement_store import InMemoryPendingSettlementStore, PendingSettlementStore
from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..asset_cache import start_asset_contract_check
from ..constants import (
    ERR_AUTHORIZATION_VALUE_MISMATCH,
    ERR_FACTORY_NOT_ALLOWED,
    ERR_FAILED_TO_GET_NETWORK_CONFIG,
    ERR_FAILED_TO_VERIFY_SIGNATURE,
    ERR_INVALID_SIGNATURE,
    ERR_MISSING_EIP712_DOMAIN,
    ERR_NETWORK_MISMATCH,
    ERR_RECIPIENT_MISMATCH,
    ERR_SMART_WALLET_DEPLOYMENT_FAILED,
    ERR_TRANSACTION_FAILED,
    ERR_TRANSACTION_SIMULATION_FAILED,
    ERR_TRANSFER_EVENT_MISMATCH,
    ERR_UNDEPLOYED_SMART_WALLET,
    ERR_UNSUPPORTED_SCHEME,
    ERR_VALID_AFTER_FUTURE,
    ERR_VALID_BEFORE_EXPIRED,
    SCHEME_EXACT,
    TX_STATUS_SUCCESS,
)
from ..data_suffix import resolve_data_suffix
from ..erc6492 import has_deployment_info
from ..exact.eip3009_utils import (
    EIP3009SignatureClassification,
    ParsedEIP3009Authorization,
    classify_eip3009_signature,
    diagnose_eip3009_simulation_failure,
    execute_transfer_with_authorization,
    parse_eip3009_authorization,
    parse_eip3009_transfer_error,
    simulate_eip3009_transfer_result,
    verify_eip3009_transfer_event,
)
from ..exact.permit2_utils import settle_permit2, verify_permit2
from ..settle_receipt import wait_for_receipt_and_build_response
from ..signer import FacilitatorEvmSigner
from ..types import (
    ERC6492SignatureData,
    ExactEIP3009Payload,
    TransactionReceipt,
    is_permit2_payload,
)
from ..utils import (
    bytes_to_hex,
    get_evm_chain_id,
    hex_to_bytes,
    is_contract_revert,
    normalize_address,
)

logger = logging.getLogger(__name__)


@dataclass
class ExactEvmSchemeConfig:
    """Configuration for ExactEvmScheme facilitator."""

    eip6492_allowed_factories: list[str] = field(default_factory=list)
    """Allowlist of factory contract addresses (hex strings, case-insensitive).

    A non-empty list enables ERC-4337 smart wallet deployment via EIP-6492. The facilitator will
    only call factories on this list when deploying an undeployed smart wallet. An empty list
    (the default) denies all factory deployment calls. Facilitators must explicitly list every
    factory they trust to prevent arbitrary transaction injection via attacker-controlled ERC-6492
    signature wrappers.
    """

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
        pending_store: PendingSettlementStore | None = None,
    ):
        """Create ExactEvmScheme facilitator.

        Args:
            signer: EVM signer for verification and settlement.
            config: Optional configuration.
            pending_store: Optional store letting a retried settle for the same payload
                reconcile against an already-broadcast transaction instead of
                re-verifying and re-broadcasting (see settlement_pending). Defaults to a
                fresh in-memory store when omitted.
        """
        self._signer = signer
        self._config = config or ExactEvmSchemeConfig()
        self._pending_store: PendingSettlementStore = (
            pending_store or InMemoryPendingSettlementStore()
        )

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
        verify_result, _ = self._verify(payload, requirements, simulate=True)
        return verify_result

    def _verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        simulate: bool,
    ) -> tuple[VerifyResponse, EIP3009SignatureClassification | None]:
        """Verify EIP-3009 payment payload.

        Validates:
        - Scheme and network match
        - Signature is valid (EOA, EIP-1271, or ERC-6492)
        - Recipient matches requirements.pay_to
        - Amount exactly matches requirements.amount
        - Validity window is correct
        - Nonce hasn't been used
        - Payer has sufficient balance

        On success also returns the signature classification so settle can reuse
        the payer code lookup instead of issuing a second eth_getCode.

        Args:
            payload: Payment payload from client.
            requirements: Payment requirements.

        Returns:
            (VerifyResponse, classification) where classification is set on success.
        """
        evm_payload = ExactEIP3009Payload.from_dict(payload.payload)
        payer = evm_payload.authorization.from_address
        network = str(requirements.network)

        # Validate scheme
        if payload.accepted.scheme != SCHEME_EXACT:
            return (
                VerifyResponse(is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer=payer),
                None,
            )

        # Validate network
        if payload.accepted.network != requirements.network:
            return (
                VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer=payer),
                None,
            )

        # Parse chain ID from network identifier
        try:
            chain_id = get_evm_chain_id(network)
        except ValueError as e:
            return (
                VerifyResponse(
                    is_valid=False,
                    invalid_reason=ERR_FAILED_TO_GET_NETWORK_CONFIG,
                    invalid_message=str(e),
                    payer=payer,
                ),
                None,
            )

        token_address = normalize_address(requirements.asset)

        # Check EIP-712 domain params
        extra = requirements.extra or {}
        if "name" not in extra or "version" not in extra:
            return (
                VerifyResponse(
                    is_valid=False, invalid_reason=ERR_MISSING_EIP712_DOMAIN, payer=payer
                ),
                None,
            )

        # Validate recipient
        if evm_payload.authorization.to.lower() != requirements.pay_to.lower():
            return (
                VerifyResponse(is_valid=False, invalid_reason=ERR_RECIPIENT_MISMATCH, payer=payer),
                None,
            )

        # Validate amount
        if int(evm_payload.authorization.value) != int(requirements.amount):
            return (
                VerifyResponse(
                    is_valid=False,
                    invalid_reason=ERR_AUTHORIZATION_VALUE_MISMATCH,
                    payer=payer,
                ),
                None,
            )

        # Validate timing
        now = int(time.time())

        # Check validBefore is in future (6 second buffer)
        if int(evm_payload.authorization.valid_before) < now + 6:
            return (
                VerifyResponse(
                    is_valid=False, invalid_reason=ERR_VALID_BEFORE_EXPIRED, payer=payer
                ),
                None,
            )

        # Check validAfter is not in future
        if int(evm_payload.authorization.valid_after) > now:
            return (
                VerifyResponse(is_valid=False, invalid_reason=ERR_VALID_AFTER_FUTURE, payer=payer),
                None,
            )

        # Verify signature
        if not evm_payload.signature:
            return (
                VerifyResponse(is_valid=False, invalid_reason=ERR_INVALID_SIGNATURE, payer=payer),
                None,
            )

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
                    return (
                        VerifyResponse(
                            is_valid=False,
                            invalid_reason=ERR_UNDEPLOYED_SMART_WALLET,
                            payer=payer,
                        ),
                        None,
                    )

            if not classification.valid and not classification.is_smart_wallet:
                return (
                    VerifyResponse(
                        is_valid=False, invalid_reason=ERR_INVALID_SIGNATURE, payer=payer
                    ),
                    None,
                )
        except Exception as e:
            return (
                VerifyResponse(
                    is_valid=False,
                    invalid_reason=ERR_FAILED_TO_VERIFY_SIGNATURE,
                    invalid_message=str(e),
                    payer=payer,
                ),
                None,
            )

        # Counterfactual ERC-6492 wallet (undeployed + carries factory deployment info):
        # settle will deploy via the factory, which is gated by the allowlist. Enforce the
        # same gate here so verify does not pass for a payment settle will reject.
        if (
            not classification.valid
            and classification.is_undeployed
            and has_deployment_info(classification.sig_data)
        ):
            factory_addr = bytes_to_hex(classification.sig_data.factory).lower()
            allowed = {f.strip().lower() for f in self._config.eip6492_allowed_factories}
            if factory_addr not in allowed:
                return (
                    VerifyResponse(
                        is_valid=False, invalid_reason=ERR_FACTORY_NOT_ALLOWED, payer=payer
                    ),
                    None,
                )

        asset_reason = start_asset_contract_check(
            self._signer, str(requirements.network), requirements.asset
        ).await_result()
        if asset_reason:
            return (
                VerifyResponse(is_valid=False, invalid_reason=asset_reason, payer=payer),
                None,
            )

        if not simulate:
            return VerifyResponse(is_valid=True, payer=payer), classification

        try:
            parsed_authorization = parse_eip3009_authorization(evm_payload.authorization)
        except Exception as e:
            return (
                VerifyResponse(
                    is_valid=False,
                    invalid_reason=ERR_FAILED_TO_VERIFY_SIGNATURE,
                    invalid_message=str(e),
                    payer=payer,
                ),
                None,
            )

        sim_ok, sim_error = simulate_eip3009_transfer_result(
            self._signer,
            token_address,
            parsed_authorization,
            classification.sig_data,
        )
        if not sim_ok:
            # Prefer the concrete on-chain revert reason the simulation surfaced (e.g.
            # insufficient balance / used nonce) over the opaque generic code. Fall back
            # to a diagnostic probe only when the revert could not be classified.
            reason = ERR_TRANSACTION_SIMULATION_FAILED
            if is_contract_revert(sim_error):
                mapped = parse_eip3009_transfer_error(sim_error)
                if mapped != ERR_TRANSACTION_FAILED:
                    reason = mapped
            if reason == ERR_TRANSACTION_SIMULATION_FAILED:
                reason = diagnose_eip3009_simulation_failure(
                    self._signer,
                    token_address,
                    evm_payload.authorization,
                    int(requirements.amount),
                    extra["name"],
                    extra["version"],
                )
            # Log the concrete on-chain revert before returning. The HTTP response only
            # carries the mapped reason code (and the resource server drops invalid_message
            # entirely), so without this the actual revert is invisible to operators.
            logger.warning(
                "exact verify: transfer simulation failed payer=%s reason=%s revert=%s",
                payer,
                reason,
                sim_error,
            )
            return (
                VerifyResponse(
                    is_valid=False,
                    invalid_reason=reason,
                    invalid_message=str(sim_error) if sim_error is not None else None,
                    payer=payer,
                ),
                None,
            )

        return VerifyResponse(is_valid=True, payer=payer), classification

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
            return settle_permit2(
                self._signer, payload, requirements, context, pending_store=self._pending_store
            )

        network = str(requirements.network)

        # Fast path: a prior settle attempt for this exact payload already broadcast a
        # transaction whose receipt wait failed (settlement_pending). The resource server's
        # single automatic retry resends the identical payload, so check the
        # pending-settlement store before re-verifying/re-broadcasting — reconcile against
        # the already-broadcast transaction instead of creating a second one.
        fast_path_payload = ExactEIP3009Payload.from_dict(payload.payload)
        if fast_path_payload.signature:
            cached_tx_hash = self._pending_store.get(fast_path_payload.signature)
            if cached_tx_hash is not None:
                # Remove before reconciling (rather than after) so a concurrent
                # retry of the same payload misses here instead of also
                # reconciling: it falls through to the normal broadcast path,
                # which independently rejects it as an on-chain replay (nonce
                # already consumed).
                self._pending_store.delete(fast_path_payload.signature)
                return self._reconcile_pending_eip3009(
                    fast_path_payload, requirements, network, cached_tx_hash
                )

        # First verify
        verify_result, classification = self._verify(
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
        token_address = normalize_address(requirements.asset)

        if classification is None:
            return SettleResponse(
                success=False,
                error_reason=ERR_FAILED_TO_VERIFY_SIGNATURE,
                error_message="verify returned no signature classification",
                network=network,
                payer=payer,
                transaction="",
            )
        sig_data = classification.sig_data

        try:
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

        # Deploy smart wallet if needed (allowlist is the sole gate)
        if has_deployment_info(sig_data):
            # code_deployed comes from the eth_getCode the verify above already issued for this
            # payer. Both reads happen before any deploy transaction, so reusing it does not
            # reintroduce the post-deploy re-read that races RPC state propagation across replicas.
            if not sig_data.code_deployed:
                factory_addr = bytes_to_hex(sig_data.factory)
                allowed = [f.lower() for f in self._config.eip6492_allowed_factories]
                if factory_addr.lower() not in allowed:
                    return SettleResponse(
                        success=False,
                        error_reason=ERR_FACTORY_NOT_ALLOWED,
                        network=network,
                        payer=payer,
                        transaction="",
                    )

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

                # Do NOT re-simulate the transfer here. The single authoritative pre-check is
                # the atomic deploy+transfer simulation that runs in verify (one eth_call via
                # Multicall3, state carried across both sub-calls). A second standalone
                # eth_call after the real deploy tx is unreliable — the read can race the
                # deploy's state propagation across load-balanced RPC nodes — and was
                # producing false inner-signature-unsupported rejections
                # for valid wallets (e.g. Coinbase Smart Wallet). The on-chain
                # transferWithAuthorization below is the definitive signature check; a
                # genuinely unsupported inner signature reverts there and is classified by
                # parse_eip3009_transfer_error.

        try:
            data_suffix = resolve_data_suffix(context, payload, requirements)
            tx_hash = execute_transfer_with_authorization(
                self._signer,
                token_address,
                parsed_authorization,
                sig_data,
                data_suffix=data_suffix,
            )

            return self._await_eip3009_settlement(
                evm_payload.signature,
                token_address,
                parsed_authorization,
                network,
                payer,
                tx_hash,
            )

        except Exception as e:
            logger.warning(
                "exact settle: transferWithAuthorization failed payer=%s reason=%s revert=%s",
                payer,
                parse_eip3009_transfer_error(e),
                e,
            )
            return SettleResponse(
                success=False,
                error_reason=parse_eip3009_transfer_error(e),
                error_message=str(e),
                network=network,
                payer=payer,
                transaction="",
            )

    def _reconcile_pending_eip3009(
        self,
        evm_payload: ExactEIP3009Payload,
        requirements: PaymentRequirements,
        network: str,
        tx_hash: str,
    ) -> SettleResponse:
        """Handle a pending-settlement store hit.

        Skips verify and broadcast entirely (the payer is taken directly from the payload,
        exactly as the original attempt did) and awaits the previously broadcast transaction.
        """
        token_address = normalize_address(requirements.asset)
        payer = evm_payload.authorization.from_address
        try:
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
        return self._await_eip3009_settlement(
            evm_payload.signature, token_address, parsed_authorization, network, payer, tx_hash
        )

    def _await_eip3009_settlement(
        self,
        pending_key: str | None,
        token_address: str,
        parsed_authorization: ParsedEIP3009Authorization,
        network: str,
        payer: str,
        tx_hash: str,
    ) -> SettleResponse:
        """Wait for the broadcast transaction's receipt and verify its Transfer event.

        Shared by both the normal broadcast path and the pending-settlement reconciliation
        path above. On a receipt-wait failure, the broadcast hash is recorded in the
        pending-settlement store, keyed by the EIP-3009 signature, so a subsequent settle
        attempt for the same payload can reconcile against it instead of broadcasting again.
        """

        def _validate_transfer(receipt: TransactionReceipt) -> SettleResponse | None:
            if receipt.logs is not None and not verify_eip3009_transfer_event(
                receipt.logs,
                token_address,
                from_address=parsed_authorization.from_address,
                to=parsed_authorization.to,
                value=parsed_authorization.value,
            ):
                return SettleResponse(
                    success=False,
                    error_reason=ERR_TRANSFER_EVENT_MISMATCH,
                    transaction=tx_hash,
                    network=network,
                    payer=payer,
                )
            return None

        return wait_for_receipt_and_build_response(
            self._signer,
            tx_hash,
            network,
            payer,
            failed_reason=ERR_TRANSACTION_FAILED,
            validate_receipt=_validate_transfer,
            pending_store=self._pending_store,
            pending_key=pending_key,
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
