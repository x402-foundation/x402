"""Cardano verification and broadcast-once settlement for the Exact scheme (V2)."""

import secrets
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast

from pycardano import Address, VerificationKeyHash

from ....interfaces import FacilitatorContext
from ....schemas import PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse
from .. import constants as c
from ..limits import MAX_CARDANO_INPUT_LOOKUP_CONCURRENCY, MAX_CARDANO_TRANSACTION_INPUTS
from ..policy import ResolvedCardanoPolicies, resolve_cardano_policies
from ..settlement_store import (
    CardanoSettlementClaim,
    CardanoSettlementStore,
    InMemoryCardanoSettlementStore,
)
from ..signer import FacilitatorCardanoSigner
from ..types import (
    CardanoProtocolParameters,
    CardanoSettlementEvidence,
    CardanoUtxoSnapshot,
    DecodedCardanoTransaction,
    ExactCardanoPayload,
)
from ..utils import (
    decode_cardano_payload,
    decode_cardano_transaction,
    min_utxo_lovelace,
    parse_utxo_ref,
    slot_to_posix_ms,
)
from .masumi.digests import build_signed_terms, compute_terms_digest
from .masumi.schema import validate_masumi_extra
from .masumi.verify import MasumiAuthorizationOptions, MasumiLockCheck, verify_masumi_lock
from .phase1 import Phase1Check, check_minimum_fee, check_value_conservation
from .script_address import script_address_matches


class _Rejected(Exception):
    def __init__(self, reason: str, detail: str | None = None):
        self.reason, self.detail = reason, detail
        super().__init__(detail or reason)


class ExactCardanoScheme:
    """Verify signed payments and reconcile retries against chain evidence."""

    scheme = c.SCHEME_EXACT
    caip_family = "cardano:*"

    def __init__(
        self,
        signer: FacilitatorCardanoSigner,
        *,
        settlement_store: CardanoSettlementStore | None = None,
        accept_mempool: bool = False,
        confirmation_timeout_ms: int = 75_000,
        confirmation_poll_ms: int = 5_000,
        validate_registry_claim: Callable[[dict[str, Any]], bool] | None = None,
        validate_custom_masumi_deployment: Callable[[dict[str, Any]], bool] | None = None,
    ):
        """Configure synchronous verification, submission and confirmation polling.

        Args:
            signer: Provider-backed chain operations; no signing key is required.
            settlement_store: Atomic transaction/terms claims. The default is local
                to this instance; multiple workers need a shared store.
            accept_mempool: Explicitly allow a server's -1 confirmation policy.
            confirmation_timeout_ms: Maximum polling window in milliseconds; zero
                checks evidence once and returns pending when it is insufficient.
            confirmation_poll_ms: Positive delay between evidence reads, in milliseconds.
            validate_registry_claim: Synchronous approval of a signed Masumi registry
                claim against the resource, seller and price supplied in the callback.
            validate_custom_masumi_deployment: Synchronous approval of non-default
                deployment parameters after seller authorization has been checked.

        Async applications must run verification and settlement in a worker thread.
        """
        if type(confirmation_timeout_ms) is not int or confirmation_timeout_ms < 0:
            raise ValueError("confirmation_timeout_ms must be a non-negative integer")
        if type(confirmation_poll_ms) is not int or confirmation_poll_ms <= 0:
            raise ValueError("confirmation_poll_ms must be a positive integer")
        self._signer = signer
        self._store = settlement_store or InMemoryCardanoSettlementStore()
        self._accept_mempool = accept_mempool
        self._confirmation_timeout_ms = confirmation_timeout_ms
        self._confirmation_poll_ms = confirmation_poll_ms
        self._validate_registry_claim = validate_registry_claim
        self._validate_custom_deployment = validate_custom_masumi_deployment

    def _can_authenticate_evidence(self) -> bool:
        return callable(getattr(self._signer, "get_transaction_evidence", None))

    def _max_l1_confirmations(self) -> int:
        if not self._can_authenticate_evidence():
            return 0
        maximum = getattr(self._signer, "max_l1_confirmations", c.MAX_L1_CONFIRMATIONS)
        if type(maximum) is not int or not 0 <= maximum <= c.MAX_L1_CONFIRMATIONS:
            raise ValueError("Signer max_l1_confirmations must be an integer from 0 to 20")
        return maximum

    def _get_evidence(self, tx_hash: str, network: str) -> CardanoSettlementEvidence:
        reader = getattr(self._signer, "get_transaction_evidence", None)
        if not callable(reader):
            raise ValueError("Cardano signer does not provide settlement evidence")
        return cast(CardanoSettlementEvidence, reader(tx_hash, network))

    def get_extra(self, network: str) -> dict[str, Any]:
        return {
            "assetTransferMethods": ["default", "masumi", "script"],
            "areFeesSponsored": False,
            "l1Confirmations": {
                "minimum": -1 if self._accept_mempool else 0,
                "maximum": self._max_l1_confirmations(),
            },
        }

    def get_signers(self, network: str) -> list[str]:
        return list(self._signer.get_addresses())

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> VerifyResponse:
        """Validate the signed payment against requirements and current chain data.

        Returns a rejection response for invalid payments without broadcasting.
        Provider work is synchronous, including concurrent funding-input lookups.
        """
        return self._run_verification(payload, requirements)

    def verify_broadcast(
        self, payload: PaymentPayload, requirements: PaymentRequirements
    ) -> VerifyResponse:
        """Recheck a broadcast transaction without requiring its inputs to remain unspent."""
        return self._run_verification(payload, requirements, already_broadcast=True)

    @staticmethod
    def _resolve(
        payload: PaymentPayload, requirements: PaymentRequirements
    ) -> tuple[ExactCardanoPayload, DecodedCardanoTransaction, ResolvedCardanoPolicies]:
        try:
            inner = decode_cardano_payload(payload.payload)
        except (ValueError, TypeError, AttributeError) as exc:
            raise _Rejected(c.ERR_INVALID_PAYLOAD, str(exc)) from exc
        try:
            decoded = decode_cardano_transaction(inner.transaction)
        except Exception as exc:
            raise _Rejected(c.ERR_TRANSACTION_DECODE_FAILED, str(exc)) from exc
        policies = resolve_cardano_policies(requirements.extra)
        if policies is None:
            raise _Rejected(c.ERR_POLICY_INVALID)
        return inner, decoded, policies

    def _run_verification(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        already_broadcast: bool = False,
    ) -> VerifyResponse:
        payer = ""
        try:
            if payload.x402_version != 2:
                raise _Rejected(c.ERR_INVALID_PAYLOAD + "_unsupported_version")
            if payload.accepted.scheme != self.scheme or requirements.scheme != self.scheme:
                raise _Rejected(c.ERR_UNSUPPORTED_SCHEME)
            if c.normalize_cardano_network(payload.accepted.network) != c.normalize_cardano_network(
                requirements.network
            ) or not c.is_cardano_network(requirements.network):
                raise _Rejected(c.ERR_NETWORK_MISMATCH)
            if not c.POSITIVE_CANONICAL_AMOUNT_REGEX.fullmatch(
                requirements.amount
            ) or not c.CANONICAL_CARDANO_ASSET_REGEX.fullmatch(requirements.asset):
                raise _Rejected(
                    c.ERR_REQUIREMENTS_INVALID,
                    "amount and asset must use their positive canonical wire forms",
                )
            inner, decoded, policies = self._resolve(payload, requirements)
            try:
                tx_hash, index = parse_utxo_ref(inner.nonce)
                nonce = f"{tx_hash}#{index}"
            except ValueError as exc:
                raise _Rejected(c.ERR_NONCE_INVALID) from exc
            if len(decoded.inputs) > MAX_CARDANO_TRANSACTION_INPUTS:
                raise _Rejected(c.ERR_TRANSACTION_PHASE1_INVALID, "too many transaction inputs")
            if decoded.network_id is not None and decoded.network_id != c.get_cardano_network_id(
                requirements.network
            ):
                raise _Rejected(c.ERR_NETWORK_ID_MISMATCH)
            if decoded.vkey_witness_count == 0 and decoded.script_witness_count == 0:
                raise _Rejected(c.ERR_TRANSACTION_UNSIGNED)
            if not decoded.signatures_valid:
                raise _Rejected(c.ERR_INVALID_SIGNATURE)
            inputs = [ref.lower() for ref in decoded.inputs]
            if len(set(inputs)) != len(inputs):
                raise _Rejected(
                    c.ERR_TRANSACTION_PHASE1_INVALID, "transaction contains duplicate inputs"
                )
            if nonce not in inputs:
                raise _Rejected(c.ERR_NONCE_NOT_IN_INPUTS)
            if not decoded.is_valid:
                raise _Rejected(c.ERR_TRANSACTION_PHASE2_INVALID)
            accepted = already_broadcast
            if self._can_authenticate_evidence():
                try:
                    accepted |= (
                        self._get_evidence(decoded.tx_hash, requirements.network).status
                        != "unknown"
                    )
                except Exception:
                    pass
            if not accepted and decoded.ttl_slot is None:
                raise _Rejected(
                    c.ERR_TTL_TOO_FAR,
                    "transaction TTL is required to bound the payment validity window",
                )
            if decoded.ttl_slot is not None or decoded.validity_start_slot is not None:
                try:
                    slot = self._signer.get_current_slot(requirements.network)
                except Exception as exc:
                    raise _Rejected(c.ERR_CHAIN_LOOKUP_FAILED, str(exc)) from exc
                if decoded.ttl_slot is not None:
                    if not accepted and decoded.ttl_slot <= slot:
                        raise _Rejected(c.ERR_TTL_EXPIRED)
                    if (
                        slot_to_posix_ms(requirements.network, decoded.ttl_slot)
                        > slot_to_posix_ms(requirements.network, slot)
                        + requirements.max_timeout_seconds * 1000
                    ):
                        raise _Rejected(c.ERR_TTL_TOO_FAR)
                if decoded.validity_start_slot is not None and decoded.validity_start_slot > slot:
                    raise _Rejected(c.ERR_VALIDITY_NOT_YET_VALID)
            try:
                with ThreadPoolExecutor(
                    max_workers=MAX_CARDANO_INPUT_LOOKUP_CONCURRENCY
                ) as executor:
                    snapshots = list(
                        executor.map(
                            lambda ref: self._signer.get_utxo(ref, requirements.network),
                            decoded.inputs,
                        )
                    )
            except Exception as exc:
                raise _Rejected(c.ERR_CHAIN_LOOKUP_FAILED, str(exc)) from exc
            nonce_snapshot = snapshots[inputs.index(nonce)]
            payer = nonce_snapshot.address or ""
            if not accepted:
                if not nonce_snapshot.exists:
                    raise _Rejected(c.ERR_NONCE_NOT_ON_CHAIN)
                if any(not item.exists for item in snapshots):
                    raise _Rejected(c.ERR_INPUT_NOT_AVAILABLE)
            if not payer:
                raise _Rejected(
                    c.ERR_NONCE_NOT_ON_CHAIN, "could not resolve the owner of the nonce UTxO"
                )
            parameters = None
            get_parameters = getattr(self._signer, "get_protocol_parameters", None)
            if callable(get_parameters):
                try:
                    parameters = cast(
                        CardanoProtocolParameters,
                        get_parameters(requirements.network),
                    )
                except Exception as exc:
                    raise _Rejected(c.ERR_CHAIN_LOOKUP_FAILED, str(exc)) from exc
            if not accepted:
                phase1 = self._check_phase1(
                    inner.transaction, decoded, snapshots, parameters, requirements.network
                )
                if not phase1.ok:
                    raise _Rejected(
                        phase1.reason or c.ERR_TRANSACTION_PHASE1_INVALID, phase1.detail
                    )
            recipients = [
                output for output in decoded.outputs if output.address == requirements.pay_to
            ]
            if not recipients:
                raise _Rejected(c.ERR_RECIPIENT_MISMATCH)
            asset = requirements.asset.lower()
            matching = [
                (output, output.coin if asset == "lovelace" else output.assets.get(asset))
                for output in recipients
            ]
            if all(amount is None for _, amount in matching):
                raise _Rejected(c.ERR_ASSET_MISMATCH)
            output = next(
                (
                    output
                    for output, amount in matching
                    if amount is not None and amount >= int(requirements.amount)
                ),
                None,
            )
            if output is None:
                raise _Rejected(c.ERR_AMOUNT_INSUFFICIENT)
            if (
                parameters
                and output.serialized_size is not None
                and output.coin
                < min_utxo_lovelace(output.serialized_size, parameters.coins_per_utxo_byte)
            ):
                raise _Rejected(c.ERR_MIN_UTXO_INSUFFICIENT)
            method = self.run_method_specific_checks(
                requirements,
                decoded,
                payer,
                parameters.coins_per_utxo_byte if parameters else None,
                payload.resource,
            )
            if not method.ok:
                raise _Rejected(method.reason or c.ERR_UNSUPPORTED_SCHEME, method.detail)
            evaluate = getattr(self._signer, "evaluate_transaction", None)
            if not accepted and callable(evaluate):
                try:
                    evaluate(inner.transaction, requirements.network)
                except Exception as exc:
                    raise _Rejected(c.ERR_CHAIN_LOOKUP_FAILED, str(exc)) from exc
            if policies.confirmation_policy.l1_confirmations > self._max_l1_confirmations():
                raise _Rejected(c.ERR_EVIDENCE_UNAVAILABLE)
            return VerifyResponse(is_valid=True, payer=payer)
        except _Rejected as exc:
            return VerifyResponse(
                is_valid=False, invalid_reason=exc.reason, invalid_message=exc.detail, payer=payer
            )
        except Exception as exc:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=c.ERR_INVALID_PAYLOAD + "_verification_error",
                invalid_message=str(exc),
                payer="",
            )

    def _check_phase1(
        self,
        transaction: str,
        decoded: DecodedCardanoTransaction,
        inputs: list[CardanoUtxoSnapshot],
        parameters: CardanoProtocolParameters | None,
        network: str,
    ) -> Phase1Check:
        validator = getattr(self._signer, "validate_phase1_transaction", None)
        if not set(decoded.required_signer_hashes) <= set(decoded.vkey_hashes):
            return Phase1Check(
                False,
                c.ERR_TRANSACTION_PHASE1_INVALID,
                "transaction is missing a required signer's signature",
            )
        for snapshot in inputs:
            credential = Address.from_primitive(snapshot.address).payment_part
            if isinstance(credential, VerificationKeyHash):
                if credential.payload.hex() not in decoded.vkey_hashes:
                    return Phase1Check(
                        False,
                        c.ERR_TRANSACTION_PHASE1_INVALID,
                        "funding input is missing its owner's signature",
                    )
            elif not callable(validator):
                return Phase1Check(
                    False,
                    c.ERR_TRANSACTION_PHASE1_INVALID,
                    "non-key funding inputs require a complete phase-1 validator",
                )
        if decoded.balance_changing_operations:
            if not callable(validator):
                return Phase1Check(
                    False,
                    c.ERR_TRANSACTION_PHASE1_INVALID,
                    "balance-changing operations require a complete phase-1 validator",
                )
        else:
            conserved = check_value_conservation(decoded, inputs)
            if not conserved.ok:
                return conserved
        if parameters:
            fee = check_minimum_fee(decoded, parameters)
            if not fee.ok:
                return fee
        if callable(validator):
            try:
                validator(transaction, network)
            except Exception as exc:
                return Phase1Check(False, c.ERR_TRANSACTION_PHASE1_INVALID, str(exc))
        return Phase1Check(True)

    def run_method_specific_checks(
        self,
        requirements: PaymentRequirements,
        decoded: DecodedCardanoTransaction,
        payer: str,
        coins_per_utxo_byte: int | None,
        resource: Any,
    ) -> MasumiLockCheck:
        method = requirements.extra.get("assetTransferMethod", "default")
        if method == "default":
            return MasumiLockCheck(True)
        if method == "masumi":
            return verify_masumi_lock(
                requirements.extra,
                requirements,
                decoded,
                payer,
                coins_per_utxo_byte,
                MasumiAuthorizationOptions(
                    validate_registry_claim=self._validate_registry_claim,
                    resource=resource,
                    validate_custom_deployment=self._validate_custom_deployment,
                ),
            )
        if method == "script":
            return (
                MasumiLockCheck(True)
                if script_address_matches(requirements.extra, requirements.pay_to)
                else MasumiLockCheck(False, c.ERR_SCRIPT_ADDRESS_MISMATCH)
            )
        return MasumiLockCheck(False, c.ERR_UNSUPPORTED_SCHEME)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context: FacilitatorContext | None = None,
    ) -> SettleResponse:
        """Claim and submit a payment, or reconcile an already submitted transaction.

        Args:
            payload: The complete signed payment received from the client.
            requirements: The authoritative payment requirements being satisfied.
            context: Facilitator extension context supplied by the SDK.

        Returns:
            Success once the requested evidence is met, settlement_pending while
            confirmation is outstanding, or a rejection. Pending retries must retain
            the same payload and store so they do not submit another transaction.
        """
        network = payload.accepted.network

        def fail(reason: str, transaction: str = "", message: str | None = None) -> SettleResponse:
            return SettleResponse(
                success=False,
                error_reason=reason,
                error_message=message,
                transaction=transaction,
                network=network,
            )

        try:
            inner, decoded, policies = self._resolve(payload, requirements)
        except _Rejected as exc:
            return fail(exc.reason, message=exc.detail)
        tx_hash = decoded.tx_hash
        required = policies.confirmation_policy.l1_confirmations
        digest = None
        if (
            requirements.extra.get("assetTransferMethod") == "masumi"
            and validate_masumi_extra(requirements.extra, requirements.network).ok
        ):
            digest = compute_terms_digest(build_signed_terms(requirements.extra, requirements))
        owner = secrets.token_hex(16)
        claim = self._store.claim_settlement(CardanoSettlementClaim(tx_hash, owner, digest))
        if claim == "capacity-exceeded":
            return fail(
                c.ERR_SETTLEMENT_FAILED, tx_hash, "the Cardano settlement store is at capacity"
            )
        if claim in ("terms-conflict", "in-flight"):
            return fail(c.ERR_DUPLICATE_SETTLEMENT, tx_hash)
        if claim == "rejected":
            return fail(c.ERR_SETTLEMENT_DEFINITIVELY_REJECTED, tx_hash)
        if claim == "submitted":
            recheck = self.verify_broadcast(payload, requirements)
            if not recheck.is_valid:
                if recheck.invalid_reason in (c.ERR_CHAIN_LOOKUP_FAILED, c.ERR_NONCE_NOT_ON_CHAIN):
                    return self._pending(
                        tx_hash,
                        network,
                        recheck.payer or "",
                        {},
                        "the chain lookup failed while resuming a broadcast transaction",
                    )
                return fail(
                    recheck.invalid_reason or "verification_failed",
                    tx_hash,
                    recheck.invalid_message,
                )
            evidence = self._await_evidence(tx_hash, requirements.network, required)
            return self._evidence_response(
                evidence, network, required, decoded, recheck.payer or "", True
            )
        # Dispatch through the public hook so stricter subclass verification also governs settlement.
        verified = self.verify(payload, requirements)
        if not verified.is_valid:
            self._store.release_claim(tx_hash, owner)
            return fail(
                verified.invalid_reason or "verification_failed", tx_hash, verified.invalid_message
            )
        payer = verified.payer or ""
        try:
            submission = self._signer.submit_transaction(inner.transaction, requirements.network)
            if submission.tx_hash.lower() != tx_hash:
                raise ValueError("submitter returned a different transaction hash")
            self._store.mark_submitted(tx_hash, owner)
        except Exception as exc:
            landed = False
            if self._can_authenticate_evidence():
                try:
                    landed = self._get_evidence(tx_hash, requirements.network).status != "unknown"
                except Exception:
                    landed = True
            if landed:
                self._store.mark_submitted(tx_hash, owner)
                return self._evidence_response(
                    self._await_evidence(tx_hash, requirements.network, required),
                    network,
                    required,
                    decoded,
                    payer,
                    False,
                )
            classifier = getattr(self._signer, "is_definitive_submission_rejection", None)
            definitive = callable(classifier) and classifier(exc) is True
            if definitive:
                self._store.mark_rejected(tx_hash, owner)
            else:
                self._store.mark_submitted(tx_hash, owner)
            return fail(
                c.ERR_SETTLEMENT_DEFINITIVELY_REJECTED if definitive else c.ERR_SETTLEMENT_FAILED,
                tx_hash,
                str(exc),
            )
        if self._accept_mempool and required == -1:
            evidence = CardanoSettlementEvidence(
                submission.status, 0 if submission.status == "confirmed" else -1
            )
        elif self._can_authenticate_evidence():
            evidence = self._await_evidence(tx_hash, requirements.network, required)
            if evidence.status == "unknown":
                evidence = CardanoSettlementEvidence("mempool", -1)
        else:
            evidence = CardanoSettlementEvidence(
                submission.status, 0 if submission.status == "confirmed" else -1
            )
        return self._evidence_response(evidence, network, required, decoded, payer, False)

    @staticmethod
    def _pending(
        tx_hash: str,
        network: str,
        payer: str,
        extra: dict[str, Any],
        message: str = "the transaction was broadcast and is awaiting the required confirmations",
    ) -> SettleResponse:
        return SettleResponse(
            success=False,
            error_reason=c.ERR_SETTLEMENT_PENDING,
            error_message=message,
            transaction=tx_hash,
            network=network,
            payer=payer,
            extra={**extra, "status": "pending", "transactionId": tx_hash},
        )

    def _evidence_response(
        self,
        evidence: CardanoSettlementEvidence,
        network: str,
        required: int,
        decoded: DecodedCardanoTransaction,
        payer: str,
        resumed: bool,
    ) -> SettleResponse:
        base: dict[str, Any] = {"transaction": decoded.tx_hash, "network": network, "payer": payer}
        if evidence.status == "unknown":
            if resumed and self._validity_window_closed(decoded, network):
                return SettleResponse(
                    **base,
                    success=False,
                    error_reason=c.ERR_SETTLEMENT_FAILED,
                    error_message="the transaction's validity window closed before it was included",
                    extra={"status": "expired"},
                )
            return self._pending(decoded.tx_hash, network, payer, {})
        extra = {"status": evidence.status, "confirmations": evidence.confirmations}
        if evidence.status == "mempool":
            if self._accept_mempool and evidence.confirmations >= required:
                return SettleResponse(**base, success=True, extra=extra)
            if self._can_authenticate_evidence():
                return self._pending(decoded.tx_hash, network, payer, extra)
            return SettleResponse(
                **base, success=False, error_reason=c.ERR_SETTLEMENT_NOT_CONFIRMED, extra=extra
            )
        if evidence.confirmations < required:
            return self._pending(decoded.tx_hash, network, payer, extra)
        return SettleResponse(**base, success=True, extra=extra)

    def _validity_window_closed(self, decoded: DecodedCardanoTransaction, network: str) -> bool:
        if decoded.ttl_slot is None:
            return False
        try:
            current = self._signer.get_current_slot(network)
            return (
                slot_to_posix_ms(network, current)
                > slot_to_posix_ms(network, decoded.ttl_slot) + 120_000
            )
        except Exception:
            return False

    def _await_evidence(
        self, tx_hash: str, network: str, required: int
    ) -> CardanoSettlementEvidence:
        latest = CardanoSettlementEvidence("unknown", -2)
        if not self._can_authenticate_evidence():
            return latest
        deadline = time.monotonic() + self._confirmation_timeout_ms / 1000
        while True:
            try:
                latest = self._get_evidence(tx_hash, network)
            except Exception:
                pass
            if latest.status != "unknown" and latest.confirmations >= required:
                return latest
            if time.monotonic() + self._confirmation_poll_ms / 1000 >= deadline:
                return latest
            time.sleep(self._confirmation_poll_ms / 1000)


def supported_cardano_networks() -> tuple[str, ...]:
    return c.CARDANO_NETWORKS
