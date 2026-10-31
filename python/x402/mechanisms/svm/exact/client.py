"""SVM client implementation for the Exact payment scheme (V2)."""

import binascii
import os
from collections.abc import Callable, Sequence
from typing import Any

try:
    from solders.instruction import AccountMeta, Instruction
    from solders.pubkey import Pubkey
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from ....schemas import PaymentRequirements
from ..constants import (
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    ATA_CREATION_COMPUTE_UNITS,
    DEFAULT_COMPUTE_UNIT_LIMIT,
    MAX_MEMO_BYTES,
    MAX_TRANSACTION_SIZE_V0,
    MAX_TRANSACTION_SIZE_V1,
    MEMO_PROGRAM_ADDRESS,
    SCHEME_EXACT,
    SPLIT_TRANSFER_COMPUTE_UNITS,
    SYSTEM_PROGRAM_ADDRESS,
)
from ..default_assets import find_default_asset
from ..mint_cache import MintMetadataCache, get_cached_mint_metadata
from ..rpc import SvmRpcClient
from ..signer import ClientSvmSigner
from ..types import ExactSvmPayload
from ..utils import (
    compile_payment_message,
    derive_ata,
    encode_partially_signed_transaction,
    get_network_config,
    normalize_client_transaction_versions,
    normalize_network,
    resolve_blockhash,
    resolve_transaction_version,
    transaction_size_exceeded,
)
from .splits import get_splits, parse_payment_legs, uses_split_terms

ApproveSplits = Callable[[list[dict[str, str]], dict[str, Any]], bool]
"""Consent hook for multi-payee splits (scheme_exact_svm.md §5.6).

Called before signing whenever the requirements carry a non-empty
``extra.splits``, as ``approve_splits(splits, context)`` where ``splits`` is a
list of ``{"payTo", "amount", "memo"?}`` dicts and ``context`` is
``{"payTo", "primaryAmount", "requirements"}``. Return True only when every
recipient, amount and memo matches the terms you agreed to; show any memo
alongside its payTo, never in place of it.
"""


class ExactSvmScheme:
    """SVM client implementation for the Exact payment scheme (V2).

    Implements SchemeNetworkClient protocol. Returns the inner payload dict,
    which x402Client wraps into a full PaymentPayload.

    Attributes:
        scheme: The scheme identifier ("exact").
    """

    scheme = SCHEME_EXACT
    find_default_asset = staticmethod(find_default_asset)

    def __init__(
        self,
        signer: ClientSvmSigner,
        rpc_url: str | None = None,
        transaction_versions: Sequence[int] | None = None,
        approve_splits: ApproveSplits | None = None,
    ):
        """Create ExactSvmScheme.

        Args:
            signer: SVM signer for payment authorizations.
            rpc_url: Optional custom RPC URL.
            transaction_versions: Transaction message versions this client's
                signer can build (``0`` and/or ``1``). Defaults to both; the
                highest version the facilitator also advertises is built.
            approve_splits: Consent hook for requirements carrying
                ``extra.splits`` (see :data:`ApproveSplits`). When unset,
                requirements with splits are refused: a server could otherwise
                inject recipients and divert part of the payment.
        """
        self._signer = signer
        self._transaction_versions = normalize_client_transaction_versions(transaction_versions)
        self._approve_splits = approve_splits
        self._custom_rpc_url = rpc_url
        self._clients: dict[str, SvmRpcClient] = {}
        self._mint_cache: MintMetadataCache = {}

    def _get_client(self, network: str) -> SvmRpcClient:
        """Get or create RPC client for network.

        Args:
            network: Network identifier.

        Returns:
            Solana RPC client.
        """
        caip2_network = normalize_network(network)

        if caip2_network in self._clients:
            return self._clients[caip2_network]

        if self._custom_rpc_url:
            rpc_url = self._custom_rpc_url
        else:
            rpc_url = get_network_config(network)["rpc_url"]

        client = SvmRpcClient(rpc_url)
        self._clients[caip2_network] = client
        return client

    def create_payment_payload(
        self,
        requirements: PaymentRequirements,
    ) -> dict[str, Any]:
        """Create signed SPL TransferChecked inner payload.

        Args:
            requirements: Payment requirements from server.

        Returns:
            Inner payload dict (transaction).
            x402Client wraps this with x402_version, accepted, resource, extensions.

        Raises:
            ValueError: If feePayer is missing or invalid.
        """
        network = str(requirements.network)
        extra = requirements.extra or {}
        transaction_version = resolve_transaction_version(extra, self._transaction_versions)

        # Validate splits before any RPC work, and obtain consent for them (§5.6).
        split_terms = uses_split_terms(requirements)
        legs = parse_payment_legs(requirements) if split_terms else []
        splits = get_splits(requirements) if split_terms else []
        if splits:
            if self._approve_splits is None:
                raise ValueError(
                    "Payment requirements carry extra.splits; pass approve_splits to the "
                    "client to consent to them"
                )
            approved = self._approve_splits(
                [
                    {k: split[k] for k in ("payTo", "amount", "memo") if split.get(k) is not None}
                    for split in splits
                ],
                {
                    "payTo": requirements.pay_to,
                    "primaryAmount": str(legs[0].amount),
                    "requirements": requirements,
                },
            )
            if approved is not True:
                raise ValueError("Splits in the payment requirements were not approved")

        client = self._get_client(network)

        # Facilitator must provide feePayer to cover transaction fees
        fee_payer_str = extra.get("feePayer")
        if not fee_payer_str:
            raise ValueError("feePayer is required in requirements.extra for SVM transactions")
        fee_payer = Pubkey.from_string(fee_payer_str)

        mint = Pubkey.from_string(requirements.asset)
        payer_pubkey = Pubkey.from_string(self._signer.address)

        mint_metadata = get_cached_mint_metadata(client, network, mint, self._mint_cache)
        token_program = mint_metadata.token_program
        decimals = mint_metadata.decimals

        # Derive ATAs
        source_ata_str = derive_ata(self._signer.address, requirements.asset, str(token_program))
        source_ata = Pubkey.from_string(source_ata_str)

        def transfer_checked(owner: str, amount: int) -> Instruction:
            # Data: [12 (discriminator), u64 amount (little-endian), u8 decimals]
            dest_ata = Pubkey.from_string(derive_ata(owner, requirements.asset, str(token_program)))
            return Instruction(
                program_id=token_program,
                accounts=[
                    AccountMeta(source_ata, is_signer=False, is_writable=True),
                    AccountMeta(mint, is_signer=False, is_writable=False),
                    AccountMeta(dest_ata, is_signer=False, is_writable=True),
                    AccountMeta(payer_pubkey, is_signer=True, is_writable=False),
                ],
                data=bytes([12]) + amount.to_bytes(8, "little") + bytes([decimals]),
            )

        if split_terms:
            # One TransferChecked per leg: the primary remainder to payTo, then
            # each split in extra.splits order (§5.7). A recipient marked
            # ataCreationRequired gets a fee-payer-funded CreateIdempotent
            # unless its ATA is confirmed to exist (§5.4).
            create_ixs: list[Instruction] = []
            transfer_ixs: list[Instruction] = []
            for leg in legs:
                if leg.ata_creation_required:
                    ata = Pubkey.from_string(
                        derive_ata(leg.owner, requirements.asset, str(token_program))
                    )
                    if not self._account_exists(client, ata):
                        create_ixs.append(
                            self._create_ata_idempotent_ix(
                                fee_payer, ata, Pubkey.from_string(leg.owner), mint, token_program
                            )
                        )
                transfer_ixs.append(transfer_checked(leg.owner, leg.amount))
            payment_ixs = create_ixs + transfer_ixs
            compute_unit_limit = (
                DEFAULT_COMPUTE_UNIT_LIMIT
                + (len(legs) - 1) * SPLIT_TRANSFER_COMPUTE_UNITS
                + len(create_ixs) * ATA_CREATION_COMPUTE_UNITS
            )
        else:
            payment_ixs = [transfer_checked(requirements.pay_to, int(requirements.amount))]
            compute_unit_limit = DEFAULT_COMPUTE_UNIT_LIMIT

        # Memo instruction: use seller-defined memo from extra.memo, or random nonce for uniqueness
        seller_memo = extra.get("memo")
        if seller_memo and isinstance(seller_memo, str):
            memo_data = seller_memo.encode("utf-8")
            if len(memo_data) > MAX_MEMO_BYTES:
                raise ValueError(f"extra.memo exceeds maximum {MAX_MEMO_BYTES} bytes")
        else:
            memo_data = binascii.hexlify(os.urandom(16))
        memo_ix = Instruction(
            program_id=Pubkey.from_string(MEMO_PROGRAM_ADDRESS),
            accounts=[],
            data=memo_data,
        )

        blockhash = resolve_blockhash(client, extra.get("recentBlockhash"))

        # Build message
        message = compile_payment_message(
            transaction_version,
            payer=fee_payer,
            instructions=[*payment_ixs, memo_ix],
            recent_blockhash=blockhash,
            compute_unit_limit=compute_unit_limit,
        )

        # Partially sign as the token authority; the facilitator fills the
        # fee-payer slot (index 0) at settlement.
        tx_base64 = encode_partially_signed_transaction(message, self._signer.keypair)

        # Each split adds a transfer and possibly an ATA creation (§5.2); fail
        # here with the reason rather than send a transaction that cannot land.
        size_limit = (
            MAX_TRANSACTION_SIZE_V1 if transaction_version == 1 else MAX_TRANSACTION_SIZE_V0
        )
        if transaction_size_exceeded(tx_base64, transaction_version):
            raise ValueError(
                f"Transaction is over the {size_limit}-byte limit; reduce extra.splits or "
                "ATA creations"
            )

        payload = ExactSvmPayload(transaction=tx_base64)

        # Return inner payload dict - x402Client wraps this
        return payload.to_dict()

    @staticmethod
    def _account_exists(client: SvmRpcClient, address: Pubkey) -> bool:
        """Whether an account exists.

        An RPC failure counts as "not confirmed", so the caller includes the
        idempotent creation rather than risk a transfer to a missing ATA.
        """
        try:
            return client.get_account_info(address).value is not None
        except Exception:
            return False

    @staticmethod
    def _create_ata_idempotent_ix(
        fee_payer: Pubkey,
        ata: Pubkey,
        owner: Pubkey,
        mint: Pubkey,
        token_program: Pubkey,
    ) -> Instruction:
        """Associated Token Account ``CreateIdempotent`` funded by the fee payer."""
        return Instruction(
            program_id=Pubkey.from_string(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
            accounts=[
                AccountMeta(fee_payer, is_signer=True, is_writable=True),
                AccountMeta(ata, is_signer=False, is_writable=True),
                AccountMeta(owner, is_signer=False, is_writable=False),
                AccountMeta(mint, is_signer=False, is_writable=False),
                AccountMeta(
                    Pubkey.from_string(SYSTEM_PROGRAM_ADDRESS), is_signer=False, is_writable=False
                ),
                AccountMeta(token_program, is_signer=False, is_writable=False),
            ],
            data=bytes([1]),
        )
