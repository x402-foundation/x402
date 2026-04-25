"""SVM client implementation for the Exact payment scheme (V2)."""

import base64
import binascii
import os
from typing import Any

try:
    from solana.rpc.api import Client as SolanaClient
    from solders.instruction import AccountMeta, Instruction
    from solders.message import MessageV0
    from solders.pubkey import Pubkey
    from solders.signature import Signature
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from ....schemas import PaymentRequirements
from ..constants import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    DEFAULT_COMPUTE_UNIT_LIMIT,
    DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MAX_MEMO_BYTES,
    MEMO_PROGRAM_ADDRESS,
    NETWORK_CONFIGS,
    SCHEME_EXACT,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
)
from ..signer import ClientSvmSigner
from ..types import ExactSvmPayload
from ..utils import derive_ata, normalize_network


class ExactSvmScheme:
    """SVM client implementation for the Exact payment scheme (V2).

    Implements SchemeNetworkClient protocol. Returns the inner payload dict,
    which x402Client wraps into a full PaymentPayload.

    Attributes:
        scheme: The scheme identifier ("exact").
    """

    scheme = SCHEME_EXACT

    def __init__(self, signer: ClientSvmSigner, rpc_url: str | None = None):
        """Create ExactSvmScheme.

        Args:
            signer: SVM signer for payment authorizations.
            rpc_url: Optional custom RPC URL.
        """
        self._signer = signer
        self._custom_rpc_url = rpc_url
        self._clients: dict[str, SolanaClient] = {}

    def _get_client(self, network: str) -> SolanaClient:
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
            config = NETWORK_CONFIGS.get(caip2_network)
            if not config:
                raise ValueError(f"Unsupported network: {network}")
            rpc_url = config["rpc_url"]

        client = SolanaClient(rpc_url)
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
        client = self._get_client(network)

        # Facilitator must provide feePayer to cover transaction fees
        extra = requirements.extra or {}
        fee_payer_str = extra.get("feePayer")
        if not fee_payer_str:
            raise ValueError("feePayer is required in requirements.extra for SVM transactions")
        fee_payer = Pubkey.from_string(fee_payer_str)

        mint = Pubkey.from_string(requirements.asset)
        payer_pubkey = Pubkey.from_string(self._signer.address)

        # Fetch token mint info to get decimals and program
        mint_info = client.get_account_info(mint)
        if not mint_info.value:
            raise ValueError(f"Token mint not found: {requirements.asset}")

        # Determine token program from mint owner
        mint_owner = str(mint_info.value.owner)
        if mint_owner == TOKEN_PROGRAM_ADDRESS:
            token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        elif mint_owner == TOKEN_2022_PROGRAM_ADDRESS:
            token_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)
        else:
            raise ValueError(f"Unknown token program: {mint_owner}")

        # Parse mint data to get decimals
        # SPL Token Mint layout:
        #   0-3:   mintAuthorityOption (4 bytes)
        #   4-35:  mintAuthority (32 bytes)
        #   36-43: supply (8 bytes, u64)
        #   44:    decimals (1 byte, u8)
        #   45:    isInitialized (1 byte)
        #   46-49: freezeAuthorityOption (4 bytes)
        #   50-81: freezeAuthority (32 bytes)
        mint_data = mint_info.value.data
        decimals = mint_data[44]

        # Derive ATAs
        source_ata_str = derive_ata(self._signer.address, requirements.asset, str(token_program))
        dest_ata_str = derive_ata(requirements.pay_to, requirements.asset, str(token_program))
        source_ata = Pubkey.from_string(source_ata_str)
        dest_ata = Pubkey.from_string(dest_ata_str)

        # Build instructions
        compute_budget_program = Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS)

        # 1. SetComputeUnitLimit instruction
        # Data: [2 (discriminator), u32 units (little-endian)]
        set_cu_limit_data = bytes([2]) + DEFAULT_COMPUTE_UNIT_LIMIT.to_bytes(4, "little")
        set_cu_limit_ix = Instruction(
            program_id=compute_budget_program,
            accounts=[],
            data=set_cu_limit_data,
        )

        # 2. SetComputeUnitPrice instruction
        # Data: [3 (discriminator), u64 microLamports (little-endian)]
        set_cu_price_data = bytes([3]) + DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS.to_bytes(
            8, "little"
        )
        set_cu_price_ix = Instruction(
            program_id=compute_budget_program,
            accounts=[],
            data=set_cu_price_data,
        )

        # 3. TransferChecked instruction
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

        # Get latest blockhash
        blockhash_resp = client.get_latest_blockhash()
        blockhash = blockhash_resp.value.blockhash

        # Build message
        message = MessageV0.try_compile(
            payer=fee_payer,
            instructions=[set_cu_limit_ix, set_cu_price_ix, transfer_ix, memo_ix],
            address_lookup_table_accounts=[],
            recent_blockhash=blockhash,
        )

        # Create a partially-signed transaction
        # Signers: index 0 = fee_payer (facilitator), index 1 = payer_pubkey (client)
        # For VersionedTransaction with MessageV0, prepend 0x80 version byte before signing
        msg_bytes_with_version = bytes([0x80]) + bytes(message)
        client_signature = self._signer.keypair.sign_message(msg_bytes_with_version)

        # Client is at index 1, fee_payer placeholder at index 0
        signatures = [Signature.default(), client_signature]
        tx = VersionedTransaction.populate(message, signatures)

        # Encode to base64
        tx_base64 = base64.b64encode(bytes(tx)).decode("utf-8")

        payload = ExactSvmPayload(transaction=tx_base64)

        # Return inner payload dict - x402Client wraps this
        return payload.to_dict()
