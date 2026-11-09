"""SVM client implementation for the Exact payment scheme (V2)."""

import binascii
import os
from collections.abc import Sequence
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
    MAX_MEMO_BYTES,
    MEMO_PROGRAM_ADDRESS,
    SCHEME_EXACT,
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
)


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
    ):
        """Create ExactSvmScheme.

        Args:
            signer: SVM signer for payment authorizations.
            rpc_url: Optional custom RPC URL.
            transaction_versions: Transaction message versions this client's
                signer can build (``0`` and/or ``1``). Defaults to both; the
                highest version the facilitator also advertises is built.
        """
        self._signer = signer
        self._transaction_versions = normalize_client_transaction_versions(transaction_versions)
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
        dest_ata_str = derive_ata(requirements.pay_to, requirements.asset, str(token_program))
        source_ata = Pubkey.from_string(source_ata_str)
        dest_ata = Pubkey.from_string(dest_ata_str)

        # TransferChecked instruction
        # Data: [12 (discriminator), u64 amount (little-endian), u8 decimals]
        amount = int(requirements.amount)
        transfer_data = bytes([12]) + amount.to_bytes(8, "little") + bytes([decimals])
        transfer_ix = Instruction(
            program_id=token_program,
            accounts=[
                AccountMeta(source_ata, is_signer=False, is_writable=True),
                AccountMeta(mint, is_signer=False, is_writable=False),
                AccountMeta(dest_ata, is_signer=False, is_writable=True),
                AccountMeta(payer_pubkey, is_signer=True, is_writable=False),
            ],
            data=transfer_data,
        )

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
            instructions=[transfer_ix, memo_ix],
            recent_blockhash=blockhash,
        )

        # Partially sign as the token authority; the facilitator fills the
        # fee-payer slot (index 0) at settlement.
        tx_base64 = encode_partially_signed_transaction(message, self._signer.keypair)

        payload = ExactSvmPayload(transaction=tx_base64)

        # Return inner payload dict - x402Client wraps this
        return payload.to_dict()
