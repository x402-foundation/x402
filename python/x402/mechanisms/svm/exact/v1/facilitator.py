"""SVM facilitator implementation for Exact payment scheme (V1 legacy)."""

from __future__ import annotations

import random
from typing import Any

try:
    from solders.pubkey import Pubkey
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from .....schemas import Network, SettleResponse, VerifyResponse
from .....schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1
from ...constants import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ERR_AMOUNT_INSUFFICIENT,
    ERR_DUPLICATE_SETTLEMENT,
    ERR_FEE_PAYER_MISSING,
    ERR_FEE_PAYER_NOT_MANAGED,
    ERR_FEE_PAYER_TRANSFERRING,
    ERR_INVALID_COMPUTE_LIMIT,
    ERR_INVALID_COMPUTE_PRICE,
    ERR_INVALID_INSTRUCTION_COUNT,
    ERR_MINT_MISMATCH,
    ERR_NETWORK_MISMATCH,
    ERR_NO_TRANSFER_INSTRUCTION,
    ERR_RECIPIENT_MISMATCH,
    ERR_SIMULATION_FAILED,
    ERR_TRANSACTION_DECODE_FAILED,
    ERR_TRANSACTION_FAILED,
    ERR_UNKNOWN_FIFTH_INSTRUCTION,
    ERR_UNKNOWN_FOURTH_INSTRUCTION,
    ERR_UNKNOWN_SIXTH_INSTRUCTION,
    ERR_UNSUPPORTED_SCHEME,
    LIGHTHOUSE_PROGRAM_ADDRESS,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MEMO_PROGRAM_ADDRESS,
    SCHEME_EXACT,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
)
from ...settlement_cache import SettlementCache
from ...signer import FacilitatorSvmSigner
from ...types import ExactSvmPayload
from ...utils import (
    decode_transaction_from_payload,
    derive_ata,
    get_token_payer_from_transaction,
)


class ExactSvmSchemeV1:
    """SVM facilitator implementation for Exact payment scheme (V1).

    V1 differences:
    - scheme/network at payload top level
    - Uses maxAmountRequired from requirements
    - Legacy network names

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
    ):
        """Create ExactSvmSchemeV1 facilitator.

        Args:
            signer: SVM signer for verification/settlement.
            settlement_cache: Optional shared settlement cache (one is created if omitted).
        """
        self._signer = signer
        self._settlement_cache = settlement_cache or SettlementCache()

    def get_extra(self, network: Network) -> dict[str, Any] | None:
        """Get mechanism-specific extra data.

        Args:
            network: Network identifier.

        Returns:
            Extra data with feePayer address.
        """
        _ = network  # Unused
        addresses = self._signer.get_addresses()
        fee_payer = random.choice(addresses)
        return {"feePayer": fee_payer}

    def get_signers(self, network: Network) -> list[str]:
        """Get facilitator wallet addresses.

        Args:
            network: Network identifier.

        Returns:
            List of facilitator addresses.
        """
        _ = network  # Unused
        return list(self._signer.get_addresses())

    def verify(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
        context=None,
    ) -> VerifyResponse:
        """Verify SPL token payment payload (V1).

        V1 validation differences:
        - scheme/network at top level of payload
        - Uses maxAmountRequired for amount check

        Args:
            payload: V1 payment payload.
            requirements: V1 payment requirements.

        Returns:
            VerifyResponse with is_valid and payer.
        """
        svm_payload = ExactSvmPayload.from_dict(payload.payload)
        network = requirements.network

        # V1: Validate scheme at top level
        if payload.scheme != SCHEME_EXACT or requirements.scheme != SCHEME_EXACT:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_UNSUPPORTED_SCHEME, payer="")

        # V1: Validate network at top level
        if payload.network != requirements.network:
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

        # Parse and Validate Transaction Structure
        try:
            tx = decode_transaction_from_payload(svm_payload)
        except Exception:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_TRANSACTION_DECODE_FAILED, payer=""
            )

        message = tx.message
        instructions = message.instructions
        static_accounts = list(message.account_keys)

        # 3-6 instructions: ComputeLimit + ComputePrice + TransferChecked + optional Lighthouse/Memo
        if len(instructions) < 3 or len(instructions) > 6:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_INVALID_INSTRUCTION_COUNT, payer=""
            )

        # Verify Compute Budget Instructions
        compute_budget_program = Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS)

        # Verify compute unit limit instruction (index 0)
        cu_limit_ix = instructions[0]
        cu_limit_program = static_accounts[cu_limit_ix.program_id_index]
        cu_limit_data = bytes(cu_limit_ix.data)

        if cu_limit_program != compute_budget_program or len(cu_limit_data) < 1:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_INVALID_COMPUTE_LIMIT, payer=""
            )
        if cu_limit_data[0] != 2:  # SetComputeUnitLimit discriminator
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_INVALID_COMPUTE_LIMIT, payer=""
            )

        # Verify compute unit price instruction (index 1)
        cu_price_ix = instructions[1]
        cu_price_program = static_accounts[cu_price_ix.program_id_index]
        cu_price_data = bytes(cu_price_ix.data)

        if cu_price_program != compute_budget_program or len(cu_price_data) < 9:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_INVALID_COMPUTE_PRICE, payer=""
            )
        if cu_price_data[0] != 3:  # SetComputeUnitPrice discriminator
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

        # Verify Transfer Instruction
        transfer_ix = instructions[2]
        transfer_program = static_accounts[transfer_ix.program_id_index]
        transfer_program_str = str(transfer_program)

        token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        token_2022_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)

        if transfer_program != token_program and transfer_program != token_2022_program:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=payer
            )

        # Verify optional instructions (if present)
        optional_instructions = instructions[3:]
        if optional_instructions:
            lighthouse_program = Pubkey.from_string(LIGHTHOUSE_PROGRAM_ADDRESS)
            memo_program = Pubkey.from_string(MEMO_PROGRAM_ADDRESS)
            invalid_reasons = [
                ERR_UNKNOWN_FOURTH_INSTRUCTION,
                ERR_UNKNOWN_FIFTH_INSTRUCTION,
                ERR_UNKNOWN_SIXTH_INSTRUCTION,
            ]

            for idx, optional_ix in enumerate(optional_instructions):
                optional_program = static_accounts[optional_ix.program_id_index]
                if optional_program in (lighthouse_program, memo_program):
                    continue

                reason = (
                    invalid_reasons[idx]
                    if idx < len(invalid_reasons)
                    else ERR_UNKNOWN_SIXTH_INSTRUCTION
                )
                return VerifyResponse(is_valid=False, invalid_reason=reason, payer=payer)

        # Parse transfer instruction
        transfer_accounts = list(transfer_ix.accounts)
        transfer_data = bytes(transfer_ix.data)

        # TransferChecked data: [12 (discriminator), u64 amount, u8 decimals]
        if len(transfer_data) < 10 or transfer_data[0] != 12:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_NO_TRANSFER_INSTRUCTION, payer=payer
            )

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
        authority_str = str(authority)
        if authority_str in signer_addresses:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_FEE_PAYER_TRANSFERRING, payer=payer
            )

        # Verify mint address matches requirements
        mint_str = str(mint)
        if mint_str != requirements.asset:
            return VerifyResponse(is_valid=False, invalid_reason=ERR_MINT_MISMATCH, payer=payer)

        # Verify destination ATA
        expected_dest_ata = derive_ata(
            requirements.pay_to, requirements.asset, transfer_program_str
        )
        if str(dest_ata) != expected_dest_ata:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_RECIPIENT_MISMATCH, payer=payer
            )

        # V1: Verify transfer amount meets maxAmountRequired
        required_amount = int(requirements.max_amount_required)
        if amount < required_amount:
            return VerifyResponse(
                is_valid=False, invalid_reason=ERR_AMOUNT_INSUFFICIENT, payer=payer
            )

        # Sign and Simulate Transaction
        try:
            fully_signed_tx = self._signer.sign_transaction(
                svm_payload.transaction, fee_payer_str, network
            )
            self._signer.simulate_transaction(fully_signed_tx, network)
        except Exception as e:
            error_msg = str(e)
            return VerifyResponse(
                is_valid=False,
                invalid_reason=ERR_SIMULATION_FAILED,
                invalid_message=error_msg,
                payer=payer,
            )

        return VerifyResponse(is_valid=True, payer=payer)

    def settle(
        self,
        payload: PaymentPayloadV1,
        requirements: PaymentRequirementsV1,
        context=None,
    ) -> SettleResponse:
        """Settle SPL token payment on-chain (V1).

        Same settlement logic as V2, but uses V1 payload/requirements.

        Args:
            payload: V1 payment payload.
            requirements: V1 payment requirements.

        Returns:
            SettleResponse with success, transaction, and payer.
        """
        svm_payload = ExactSvmPayload.from_dict(payload.payload)
        network = payload.network

        # First verify
        verify_result = self.verify(payload, requirements, context)
        if not verify_result.is_valid:
            return SettleResponse(
                success=False,
                error_reason=verify_result.invalid_reason,
                network=network,
                payer=verify_result.payer,
                transaction="",
            )

        # Duplicate settlement check: reject if this transaction is already being settled.
        tx_key = svm_payload.transaction
        if self._settlement_cache.is_duplicate(tx_key):
            return SettleResponse(
                success=False,
                error_reason=ERR_DUPLICATE_SETTLEMENT,
                network=network,
                payer=verify_result.payer or "",
                transaction="",
            )

        try:
            extra = requirements.extra or {}
            fee_payer = extra["feePayer"]

            # Sign transaction with the feePayer's signer
            fully_signed_tx = self._signer.sign_transaction(
                svm_payload.transaction, fee_payer, network
            )

            # Send transaction to network
            signature = self._signer.send_transaction(fully_signed_tx, network)

            # Wait for confirmation
            self._signer.confirm_transaction(signature, network)

            return SettleResponse(
                success=True,
                transaction=signature,
                network=network,
                payer=verify_result.payer,
            )

        except Exception as e:
            return SettleResponse(
                success=False,
                error_reason=ERR_TRANSACTION_FAILED,
                error_message=str(e),
                transaction="",
                network=network,
                payer=verify_result.payer or "",
            )
