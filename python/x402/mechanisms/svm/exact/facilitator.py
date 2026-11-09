"""SVM facilitator implementation for the Exact payment scheme (V2)."""

from __future__ import annotations

import random
from collections.abc import Sequence
from typing import Any

try:
    from solders.pubkey import Pubkey
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from ....pending_settlement_store import InMemoryPendingSettlementStore, PendingSettlementStore
from ....schemas import (
    Network,
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    VerifyResponse,
)
from ..constants import (
    ERR_AMOUNT_INSUFFICIENT,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_FEE_PAYER_MISSING,
    ERR_FEE_PAYER_NOT_MANAGED,
    ERR_FEE_PAYER_TRANSFERRING,
    ERR_INVALID_COMPUTE_LIMIT,
    ERR_INVALID_COMPUTE_PRICE,
    ERR_MEMO_COUNT,
    ERR_MEMO_MISMATCH,
    ERR_MINT_MISMATCH,
    ERR_NETWORK_MISMATCH,
    ERR_NO_TRANSFER_INSTRUCTION,
    ERR_RECIPIENT_ATA_MISSING,
    ERR_RECIPIENT_ATA_WRONG_PROGRAM_OWNER,
    ERR_RECIPIENT_MISMATCH,
    ERR_SETTLEMENT_PENDING,
    ERR_SIMULATION_FAILED,
    ERR_TRANSACTION_DECODE_FAILED,
    ERR_TRANSACTION_FAILED,
    ERR_TRANSACTION_SIZE_EXCEEDED,
    ERR_UNSUPPORTED_SCHEME,
    ERR_UNSUPPORTED_TRANSACTION_VERSION,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    SCHEME_EXACT,
)
from ..errors import TransactionOnchainFailureError
from ..settlement_cache import SettlementCache
from ..signer import FacilitatorSvmSigner, FacilitatorSvmSignerWithGetAccountInfo
from ..types import ExactSvmPayload
from ..utils import (
    check_transaction_v1_config,
    decode_transaction_from_payload,
    derive_ata,
    get_token_payer_from_transaction,
    get_transaction_version,
    is_accepted_transaction_version,
    normalize_accepted_transaction_versions,
    peek_wire_transaction_version,
    transaction_message_hash,
    transaction_size_exceeded,
    validate_svm_address,
)
from .instruction_layout import InstructionTuple, LayoutError, resolve_protocol_layout


class ExactSvmScheme:
    """SVM facilitator implementation for the Exact payment scheme (V2).

    Verifies and settles SPL token payments on Solana networks.

    Attributes:
        scheme: The scheme identifier ("exact").
        caip_family: The CAIP family pattern ("solana:*").
    """

    scheme = SCHEME_EXACT
    caip_family = "solana:*"

    def __init__(
        self,
        signer: FacilitatorSvmSigner,
        settlement_cache: SettlementCache | None = None,
        pending_store: PendingSettlementStore | None = None,
        transaction_versions: Sequence[int] | None = None,
        preflight_instruction_allowlist: list[InstructionTuple] | None = None,
        postflight_instruction_allowlist: list[InstructionTuple] | None = None,
    ):
        """Create ExactSvmScheme facilitator.

        Args:
            signer: SVM signer for verification and settlement.
            settlement_cache: Optional shared settlement cache (one is created if omitted).
            pending_store: Optional store letting a retried settle for the same
                transaction reconcile against an already-broadcast signature instead of
                re-verifying and re-sending (see settlement_pending). Defaults to a fresh
                in-memory store when omitted.
            transaction_versions: Transaction message versions this facilitator
                accepts and advertises as ``extra.transactionVersions``. Any other
                version is rejected with ``unsupported_transaction_version``; legacy
                is accepted exactly when 0 is. Narrow it to ``[0]`` for a sponsor
                whose signer or RPC does not yet handle version 1. Defaults to
                ``[0, 1]``.

            preflight_instruction_allowlist: Instruction tuples that may appear as a
                contiguous block (guard instructions aside) immediately BEFORE the
                required protocol instructions. Extension point for prefixing the
                payment with out-of-band setup. A matched block is fee-payer-isolation
                checked. Defaults to no allowlisted tuples (current behavior).
            postflight_instruction_allowlist: Instruction tuples that may appear as a
                contiguous block (guard instructions aside) immediately AFTER the
                required protocol instructions. See preflight_instruction_allowlist.

        Raises:
            ValueError: If ``transaction_versions`` is empty or holds anything
                but 0 and 1.
        """
        self._signer = signer
        self._transaction_versions = normalize_accepted_transaction_versions(transaction_versions)
        self._settlement_cache = settlement_cache or SettlementCache()
        self._pending_store: PendingSettlementStore = (
            pending_store or InMemoryPendingSettlementStore()
        )
        self._preflight_instruction_allowlist: list[InstructionTuple] = (
            preflight_instruction_allowlist or []
        )
        self._postflight_instruction_allowlist: list[InstructionTuple] = (
            postflight_instruction_allowlist or []
        )

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get mechanism-specific extra data for the supported kinds endpoint.

        For SVM, this includes a randomly selected fee payer address and the
        transaction message versions this facilitator advertises (versions 0
        and 1; legacy is still accepted on the wire but is deprecated).
        Random selection distributes load across multiple signers.

        Args:
            network: Network identifier (unused for SVM).

        Returns:
            Extra data with feePayer address and transactionVersions.
        """
        _ = network  # Unused
        # Randomly select from available signers to distribute load
        addresses = self._signer.get_addresses()
        fee_payer = random.choice(addresses)

        return {
            "feePayer": fee_payer,
            "transactionVersions": list(self._transaction_versions),
        }

    def get_signers(self, network: Network) -> list[str]:
        """Get facilitator wallet addresses.

        Args:
            network: Network identifier.

        Returns:
            List of facilitator fee payer addresses.
        """
        _ = network  # Unused
        return list(self._signer.get_addresses())

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> VerifyResponse:
        """Verify SPL token payment payload.

        Validates:
        - Scheme and network match
        - Transaction version is legacy, 0 or 1
        - Transaction instructions: ComputeLimit, ComputePrice, TransferChecked, and an
          optional Memo must appear in that fixed relative order, identified by program
          ID + instruction discriminator rather than absolute position. Guard
          instructions (currently only Lighthouse) may appear anywhere in the sequence.
        - Compute budget instructions are valid
        - TransferChecked instruction:
          - Token program is known (Token or Token-2022)
          - Mint matches requirements.asset
          - Destination ATA matches requirements.pay_to
        - Amount >= requirements.amount
          - Authority is not the facilitator (prevent self-transfer)
        - Simulates transaction to catch runtime errors

        Args:
            payload: Payment payload from client.
            requirements: Payment requirements.

        Returns:
            VerifyResponse with is_valid and payer.
        """
        svm_payload = ExactSvmPayload.from_dict(payload.payload)
        network = str(requirements.network)

        # Step 1: Validate Payment Requirements
        if payload.accepted.scheme != SCHEME_EXACT or requirements.scheme != SCHEME_EXACT:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer="")

        if str(payload.accepted.network) != str(requirements.network):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_NETWORK_MISMATCH, payer="")

        extra = requirements.extra or {}
        fee_payer_str = extra.get("feePayer")
        if not fee_payer_str or not isinstance(fee_payer_str, str):
            return VerifyResponse(is_valid=False, invalid_reason=ERR_FEE_PAYER_MISSING, payer="")

        # Verify that the requested feePayer is managed by this facilitator
        signer_addresses = self._signer.get_addresses()
        if fee_payer_str not in signer_addresses:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_FEE_PAYER_NOT_MANAGED, payer=""
            )

        # Step 2: Parse and Validate Transaction Structure
        # Read the version from the raw bytes first so a newer wire format is
        # reported as unsupported however the installed solders handles it.
        wire_version = peek_wire_transaction_version(svm_payload.transaction)
        if wire_version is not None and not is_accepted_transaction_version(
            wire_version, self._transaction_versions
        ):
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_UNSUPPORTED_TRANSACTION_VERSION, payer=""
            )

        try:
            tx = decode_transaction_from_payload(svm_payload)
        except Exception:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_TRANSACTION_DECODE_FAILED, payer=""
            )

        # Version allowlist, checked before any signature or instruction check:
        # every check below reads its fee policy from version-specific structure.
        version = get_transaction_version(tx.message)
        if not is_accepted_transaction_version(version, self._transaction_versions):
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_UNSUPPORTED_TRANSACTION_VERSION, payer=""
            )

        # Size limit of the message version (§1.5): 1232 bytes for legacy and
        # version 0, 4096 for version 1. The decoder accepts larger payloads.
        if transaction_size_exceeded(svm_payload.transaction, version):
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_TRANSACTION_SIZE_EXCEEDED, payer=""
            )

        message = tx.message
        static_accounts = list(message.account_keys)

        # Protocol instructions (ComputeLimit, ComputePrice, TransferChecked, and
        # optional Memo) are identified by program ID + instruction discriminator and
        # MUST appear in that fixed relative order. Guard instructions (currently only
        # permitted Lighthouse assertion variants -- Phantom/Solflare's
        # wallet-protection assertions) may appear anywhere. A configured
        # preflight/postflight allowlist block is stripped (and
        # fee-payer-isolation-checked) first.
        # See: https://github.com/x402-foundation/x402/issues/828
        #  and: https://github.com/x402-foundation/x402/issues/2097
        try:
            partitioned = resolve_protocol_layout(
                static_accounts,
                message.instructions,
                self._preflight_instruction_allowlist,
                self._postflight_instruction_allowlist,
                Pubkey.from_string(fee_payer_str),
                version=version,
            )
        except LayoutError as e:
            return VerifyResponse(is_valid=False, invalid_reason=e.reason, payer="")

        if version == 1:
            budget_error = check_transaction_v1_config(
                message.config, MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS
            )
            if budget_error:
                return VerifyResponse(is_valid=False, invalid_reason=budget_error, payer="")
        # Step 3: Verify Compute Budget Instructions
        if version != 1:
            assert partitioned.compute_limit_ix is not None
            assert partitioned.compute_price_ix is not None
            # Roles (discriminators) were established by classification; check payloads.
            cu_limit_data = bytes(partitioned.compute_limit_ix.data)
            if len(cu_limit_data) < 5:  # discriminator + u32 units
                return VerifyResponse(
                    is_valid=False, invalid_reason=ERR_INVALID_COMPUTE_LIMIT, payer=""
                )

            cu_price_data = bytes(partitioned.compute_price_ix.data)
            if len(cu_price_data) < 9:  # discriminator + u64 microLamports
                return VerifyResponse(
                    is_valid=False, invalid_reason=ERR_INVALID_COMPUTE_PRICE, payer=""
                )

            # Parse microLamports (u64, little-endian) and check against max
            micro_lamports = int.from_bytes(cu_price_data[1:9], "little")
            if micro_lamports > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS:
                return VerifyResponse(
                    is_valid=False,
                    invalid_reason="invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
                    payer="",
                )

        # Get token payer
        payer = get_token_payer_from_transaction(tx)
        if not payer:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=""
            )

        # Step 4: Verify Transfer Instruction
        transfer_ix = partitioned.transfer_ix
        transfer_program = static_accounts[transfer_ix.program_id_index]
        transfer_program_str = str(transfer_program)

        # Step 5: Verify memo content matches extra.memo when present (exactly one
        # Memo instruction is required in that case).
        expected_memo = extra.get("memo")
        if expected_memo and isinstance(expected_memo, str):
            if partitioned.memo_ix is None or partitioned.memo_count != 1:
                return VerifyResponse(is_valid=False, invalid_reason=ERR_MEMO_COUNT, payer=payer)
            actual_memo = bytes(partitioned.memo_ix.data).decode("utf-8")
            if actual_memo != expected_memo:
                return VerifyResponse(is_valid=False, invalid_reason=ERR_MEMO_MISMATCH, payer=payer)

        # Parse transfer instruction
        transfer_accounts = list(transfer_ix.accounts)
        transfer_data = bytes(transfer_ix.data)

        # TransferChecked data: [12 (discriminator), u64 amount, u8 decimals]
        # (discriminator and length were established by classification)
        # TransferChecked accounts: [source, mint, destination, owner]
        if len(transfer_accounts) < 4:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=payer
            )

        _source_ata = static_accounts[transfer_accounts[0]]  # noqa: F841
        mint = static_accounts[transfer_accounts[1]]
        dest_ata = static_accounts[transfer_accounts[2]]
        authority = static_accounts[transfer_accounts[3]]

        amount = int.from_bytes(transfer_data[1:9], "little")

        # Verify facilitator's signers are not transferring their own funds
        # SECURITY: Prevent facilitator from signing away their own tokens
        authority_str = str(authority)
        if authority_str in signer_addresses:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_FEE_PAYER_TRANSFERRING, payer=payer
            )

        # Verify mint address matches requirements
        mint_str = str(mint)
        if mint_str != requirements.asset:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_MINT_MISMATCH, payer=payer)

        # Verify destination ATA matches expected ATA for payTo address
        expected_dest_ata = derive_ata(
            requirements.pay_to, requirements.asset, transfer_program_str
        )
        if str(dest_ata) != expected_dest_ata:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_RECIPIENT_MISMATCH, payer=payer
            )

        # Verify transfer amount meets requirements
        required_amount = int(requirements.amount)
        if amount < required_amount:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_AMOUNT_INSUFFICIENT, payer=payer
            )

        # Step 5: Sign and Simulate Transaction
        # CRITICAL: Simulation proves transaction will succeed
        try:
            # Sign transaction with the feePayer's signer
            fully_signed_tx = self._signer.sign_transaction(
                svm_payload.transaction, fee_payer_str, network
            )
        except Exception as e:
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_SIMULATION_FAILED,
                invalid_message=str(e),
                payer=payer,
            )

        try:
            # Simulate to verify transaction would succeed
            self._signer.simulate_transaction(fully_signed_tx, network)
        except Exception as e:
            error_msg = str(e)
            invalid_reason = ERR_SIMULATION_FAILED
            invalid_message = error_msg
            if isinstance(self._signer, FacilitatorSvmSignerWithGetAccountInfo):
                try:
                    owner = self._signer.get_account_info(str(dest_ata), network)
                except Exception:
                    pass
                else:
                    destination = str(dest_ata)
                    if owner is None:
                        invalid_reason = ERR_RECIPIENT_ATA_MISSING
                        invalid_message = (
                            f"{error_msg}; recipient ATA {destination} was not found "
                            "during diagnostic lookup"
                        )
                    elif validate_svm_address(owner) and owner != transfer_program_str:
                        invalid_reason = ERR_RECIPIENT_ATA_WRONG_PROGRAM_OWNER
                        invalid_message = (
                            f"{error_msg}; recipient ATA {destination} has program "
                            f"owner {owner}, expected {transfer_program_str}"
                        )
            return VerifyResponse(
                is_valid=False,
                invalid_reason=invalid_reason,
                invalid_message=invalid_message,
                payer=payer,
            )

        return VerifyResponse(is_valid=True, payer=payer)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
        context=None,
    ) -> SettleResponse:
        """Settle SPL token payment on-chain.

        - Re-verifies payment
        - Signs transaction with fee payer
        - Sends transaction to network
        - Waits for confirmation

        Args:
            payload: Verified payment payload.
            requirements: Payment requirements.

        Returns:
            SettleResponse with success, transaction, and payer.
        """
        svm_payload = ExactSvmPayload.from_dict(payload.payload)
        network = str(payload.accepted.network)

        # Parse and decode the transaction up front (no RPC calls) so we can key the
        # PendingSettlementStore on the message hash before doing any verify/sign/send work.
        wire_version = peek_wire_transaction_version(svm_payload.transaction)
        if wire_version is not None and not is_accepted_transaction_version(
            wire_version, self._transaction_versions
        ):
            return SettleResponse(
                success=False,
                error_reason=ERR_UNSUPPORTED_TRANSACTION_VERSION,
                network=network,
                payer="",
                transaction="",
            )
        try:
            tx = decode_transaction_from_payload(svm_payload)
            if not is_accepted_transaction_version(
                get_transaction_version(tx.message), self._transaction_versions
            ):
                return SettleResponse(
                    success=False,
                    error_reason=ERR_UNSUPPORTED_TRANSACTION_VERSION,
                    network=network,
                    payer="",
                    transaction="",
                )
            tx_key = transaction_message_hash(tx)
        except Exception as e:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_DECODE_FAILED,
                error_message=str(e),
                network=network,
                payer="",
                transaction="",
            )

        # Pending-settlement fast path: a prior settle for this exact transaction
        # broadcast successfully but its confirm_transaction wait failed. Reconcile
        # against the already-broadcast signature instead of re-verifying and
        # re-sending: Solana transactions embed a recent blockhash that expires (so a
        # resend can fail even when the original is still perfectly valid), and if the
        # original actually did land, a second verify's balance-based simulation could
        # now spuriously fail (funds already moved).
        cached_signature = self._pending_store.get(tx_key)
        if cached_signature is not None:
            # Remove before reconciling (rather than after) so a concurrent
            # retry of the same payload misses here instead of also
            # reconciling: it falls through to the settlement_cache dedup
            # check below, which independently rejects it as a duplicate.
            self._pending_store.delete(tx_key)
            # Best-effort payer for the response; a lookup failure here doesn't block
            # reconciliation (the payload already broadcast successfully).
            try:
                payer = get_token_payer_from_transaction(tx) or ""
            except Exception:
                payer = ""
            return self._reconcile_pending_settlement(tx_key, cached_signature, payer, network)

        # First verify
        verify_result = self.verify(payload, requirements, context)
        if not verify_result.is_valid:
            return SettleResponse(
                success=False,
                error_reason=verify_result.invalid_reason,
                error_message=verify_result.invalid_message,
                network=network,
                payer=verify_result.payer,
                transaction="",
            )

        # Duplicate settlement check keyed on message hash (immune to mutable fee-payer sig at slot 0).
        if self._settlement_cache.is_duplicate(tx_key):
            return SettleResponse(
                success=False,
                error_reason=ERR_DUPLICATE_SETTLEMENT,
                network=network,
                payer=verify_result.payer or "",
                transaction="",
            )

        try:
            # Extract feePayer from requirements (already validated in verify)
            extra = requirements.extra or {}
            fee_payer = extra["feePayer"]

            # Sign transaction with the feePayer's signer
            fully_signed_tx = self._signer.sign_transaction(
                svm_payload.transaction, fee_payer, network
            )
        except Exception as e:
            self._settlement_cache.delete(tx_key)
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                transaction="",
                network=network,
                payer=verify_result.payer or "",
            )

        try:
            # Send transaction to network
            signature = self._signer.send_transaction(fully_signed_tx, network)
        except Exception as e:
            self._settlement_cache.delete(tx_key)
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                transaction="",
                network=network,
                payer=verify_result.payer or "",
            )

        # Wait for confirmation, shared with the pending-settlement reconciliation
        # path in _reconcile_pending_settlement() below.
        return self._await_confirmation(tx_key, signature, verify_result.payer or "", network)

    def _reconcile_pending_settlement(
        self,
        tx_key: str,
        signature: str,
        payer: str,
        network: str,
    ) -> SettleResponse:
        """Handle a PendingSettlementStore cache hit.

        A prior settle call for this transaction (keyed by tx_key, the message hash)
        already broadcast `signature` but couldn't confirm it before returning
        settlement_pending. Re-awaits confirmation of that same signature rather than
        re-verifying/re-signing/re-sending — see the fast-path comment in settle() for
        why re-sending is unsafe here.
        """
        return self._await_confirmation(tx_key, signature, payer, network)

    def _await_confirmation(
        self,
        tx_key: str,
        signature: str,
        payer: str,
        network: str,
    ) -> SettleResponse:
        """Waits for confirmation of an already-broadcast signature and builds the
        settle response, shared by the fresh-broadcast path in settle() and the
        pending-settlement reconciliation path in _reconcile_pending_settlement().

        Confirmed execution failure is terminal. Unknown confirmation outcomes
        retain the signature so a retry reconciles instead of re-sending.
        """
        try:
            self._signer.confirm_transaction(signature, network)
        except TransactionOnchainFailureError as e:
            try:
                self._pending_store.delete(tx_key)
            except Exception:
                pass  # A cleanup error must not mask a confirmed execution failure.
            self._settlement_cache.delete(tx_key)
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                transaction=signature,
                network=network,
                payer=payer,
            )
        except Exception as e:
            try:
                self._pending_store.set(tx_key, signature)
            except Exception as store_error:
                # Can't guarantee a later retry will find this to reconcile
                # against — a blind retry could re-verify/re-broadcast and
                # double-send. Downgrade to terminal, preserving the signature
                # for manual reconciliation.
                return SettleResponse(
                    success=False,
                    error_reason=ERR_TRANSACTION_FAILED,
                    error_message=(
                        f"settlement_pending, but failed to persist for retry: {store_error}"
                    ),
                    transaction=signature,
                    network=network,
                    payer=payer,
                )
            return SettleResponse(
                success=False,
                error_reason=ERR_SETTLEMENT_PENDING,
                error_message=str(e),
                transaction=signature,
                network=network,
                payer=payer,
            )

        try:
            self._pending_store.delete(tx_key)
        except Exception:
            pass  # best-effort; a stale entry merely lingers until TTL expiry
        return SettleResponse(
            success=True,
            transaction=signature,
            network=network,
            payer=payer,
        )
