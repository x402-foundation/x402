"""SVM utility functions for network, address, and amount handling."""

import base64
import hashlib
import re
from decimal import Decimal
from typing import TYPE_CHECKING

try:
    from solders.hash import Hash, ParseHashError
    from solders.message import (
        Message,
        MessageV1,
        TransactionConfig,
        VersionedMessage,
        to_bytes_versioned,
    )
    from solders.pubkey import Pubkey
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from ...schemas.helpers import convert_to_token_amount
from .constants import (
    NETWORK_CONFIGS,
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    SOLANA_TESTNET_CAIP2,
    SVM_ADDRESS_REGEX,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
    USDC_TESTNET_ADDRESS,
    V1_TO_V2_NETWORK_MAP,
    AssetInfo,
    NetworkConfig,
)
from .types import ExactSvmPayload, TransactionInfo

if TYPE_CHECKING:
    from .rpc import SvmRpcClient


def resolve_blockhash(client: "SvmRpcClient", recent_blockhash: object = None) -> Hash:
    """Use a valid supplied blockhash, falling back to the latest blockhash from RPC."""
    if isinstance(recent_blockhash, str) and recent_blockhash:
        try:
            return Hash.from_string(recent_blockhash)
        except ParseHashError:
            pass

    return client.get_latest_blockhash().value.blockhash


def normalize_network(network: str) -> str:
    """Normalize network identifier to CAIP-2 format.

    Handles both V1 names (solana, solana-devnet) and V2 CAIP-2 format.

    Args:
        network: Network identifier (V1 or V2 format).

    Returns:
        CAIP-2 network identifier.

    Raises:
        ValueError: If network is not supported.
    """
    # If it's already CAIP-2 format (contains ":"), validate it's supported
    if ":" in network:
        supported = [SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2, SOLANA_TESTNET_CAIP2]
        if network not in supported:
            raise ValueError(f"Unsupported SVM network: {network}")
        return network

    # Otherwise, it's a V1 network name, convert to CAIP-2
    caip2_network = V1_TO_V2_NETWORK_MAP.get(network)
    if not caip2_network:
        raise ValueError(f"Unsupported SVM network: {network}")
    return caip2_network


def get_network_config(network: str) -> NetworkConfig:
    """Return transport endpoints for a supported Solana network."""
    caip2_network = normalize_network(network)
    config = NETWORK_CONFIGS.get(caip2_network)
    if not config:
        raise ValueError(f"No configuration for network: {network}")
    return config


def validate_svm_address(address: str) -> bool:
    """Validate Solana address format.

    Args:
        address: Base58 encoded address string.

    Returns:
        True if address is valid, False otherwise.
    """
    return bool(re.match(SVM_ADDRESS_REGEX, address))


def get_usdc_address(network: str) -> str:
    """Get the default USDC mint address for a network.

    Args:
        network: Network identifier (CAIP-2 or V1 format).

    Returns:
        USDC mint address for the network.

    Raises:
        ValueError: If no USDC address configured for network.
    """
    caip2_network = normalize_network(network)

    if caip2_network == SOLANA_MAINNET_CAIP2:
        return USDC_MAINNET_ADDRESS
    if caip2_network == SOLANA_DEVNET_CAIP2:
        return USDC_DEVNET_ADDRESS
    if caip2_network == SOLANA_TESTNET_CAIP2:
        return USDC_TESTNET_ADDRESS

    raise ValueError(f"No USDC address configured for network: {network}")


def get_asset_info(network: str, asset_address: str | None = None) -> AssetInfo:
    """Get asset info for a network.

    Args:
        network: Network identifier.
        asset_address: Optional specific asset address.

    Returns:
        Asset information.

    Raises:
        ValueError: If the address does not match a registered asset for the network.
    """
    from .default_assets import find_default_asset, get_default_asset

    if not asset_address:
        entry = get_default_asset(network)
    else:
        found = find_default_asset(asset_address, network)
        if found is None:
            raise ValueError(
                f"Token {asset_address} is not a registered asset for network {network}."
            )
        entry = found

    return {
        "address": entry["asset"],
        "name": entry["symbol"],
        "decimals": entry["decimals"],
    }


def parse_amount(amount: str, decimals: int) -> int:
    """Convert decimal string to smallest unit.

    Args:
        amount: Decimal string (e.g., "1.50").
        decimals: Token decimals.

    Returns:
        Amount in smallest unit.
    """
    return int(convert_to_token_amount(amount, decimals))


def format_amount(amount: int, decimals: int) -> str:
    """Convert smallest unit to decimal string.

    Args:
        amount: Amount in smallest unit.
        decimals: Token decimals.

    Returns:
        Decimal string.
    """
    d = Decimal(amount)
    divisor = Decimal(10**decimals)
    return str(d / divisor)


def transaction_message_hash(tx: VersionedTransaction) -> str:
    """Return a stable, immutable cache key for a transaction.

    The fee-payer signature (slot 0) is overwritten by the facilitator before
    broadcast, so an attacker can randomize those bytes to bypass a wire-bytes
    cache key. The message is what every signer commits to, so its SHA-256 hash
    uniquely and immutably identifies a payment.

    Args:
        tx: Decoded versioned transaction.

    Returns:
        Base64-encoded SHA-256 hash of the serialized transaction message.
    """
    return base64.b64encode(hashlib.sha256(bytes(tx.message)).digest()).decode()


def decode_transaction_from_payload(payload: ExactSvmPayload) -> VersionedTransaction:
    """Decode a base64 encoded transaction from an SVM payload.

    Args:
        payload: The SVM payload containing a base64 encoded transaction.

    Returns:
        Decoded VersionedTransaction object.

    Raises:
        ValueError: If transaction cannot be decoded.
    """
    try:
        tx_bytes = base64.b64decode(payload.transaction)
        return VersionedTransaction.from_bytes(tx_bytes)
    except Exception as e:
        raise ValueError("invalid_exact_svm_payload_transaction") from e


def get_transaction_version(message: VersionedMessage) -> int | str:
    """Return the version of a decoded transaction message.

    Legacy messages have no version prefix; versioned messages are serialized
    behind a single byte of ``0x80 | version``, so the low seven bits of that
    byte name the version for any version solders can decode — including ones
    newer than this code.

    Args:
        message: Decoded transaction message.

    Returns:
        "legacy" for an unversioned message, otherwise the version number.
    """
    if isinstance(message, Message):
        return "legacy"
    return to_bytes_versioned(message)[0] & 0x7F


def is_supported_transaction_version(version: int | str) -> bool:
    """Return whether a transaction version is one the SVM schemes can police.

    Every SVM verification path derives its sponsorship policy from
    version-specific structure: legacy and version 0 transactions declare their
    compute budget in a ComputeBudget instruction pair, while version 1
    (SIMD-0385) carries it in ``message.config`` and has no ComputeBudget
    instructions at all. A future version could relocate it again, and an
    instruction scan over a layout it does not model finds nothing to reject and
    passes vacuously, leaving the priority fee the facilitator pays unbounded.
    This is therefore an allowlist, not a denylist of known-bad versions:
    anything unmodelled must be rejected the moment solders learns to decode it.

    Args:
        version: Version reported by get_transaction_version.

    Returns:
        True if the version is legacy, 0 or 1, False otherwise.
    """
    return version == "legacy" or version == 0 or version == 1


def get_v1_transaction_config(message: VersionedMessage) -> TransactionConfig | None:
    """Return a version 1 message's compute budget config.

    Args:
        message: Decoded transaction message of any version.

    Returns:
        The message config, or None when the message is not version 1.
    """
    return message.config if isinstance(message, MessageV1) else None


def check_v1_transaction_config(
    config: TransactionConfig | None,
    max_compute_units: int | None,
    max_priority_fee_micro_lamports: int,
) -> str | None:
    """Check a version 1 transaction's config against the facilitator's fee policy.

    This enforces on ``message.config`` what the ComputeBudget instruction checks
    enforce on legacy and version 0 transactions.

    A version 1 transaction that leaves ``compute_unit_limit`` unset is budgeted
    zero compute units, and one that leaves ``loaded_accounts_data_size_limit``
    unset is budgeted zero bytes of account data; either way it cannot execute,
    so both are required. The priority fee is a total in lamports rather than
    micro-lamports per compute unit, so the per-CU cap is normalized against the
    declared compute unit limit: the fee passes when ``priority_fee * 1e6 <=
    max_priority_fee_micro_lamports * compute_unit_limit``, which bounds the
    facilitator's SOL exposure to exactly what the equivalent version 0
    transaction could charge. ``heap_size`` and the magnitude of
    ``loaded_accounts_data_size_limit`` are left uncapped: unlike their version 0
    instruction forms they add no execution surface, and their compute cost is
    already bounded by the capped compute unit limit.

    Args:
        config: The transaction's message.config, or None.
        max_compute_units: Maximum allowed compute_unit_limit, or None for no cap.
        max_priority_fee_micro_lamports: Per-compute-unit price cap the total fee
            is normalized against.

    Returns:
        The name of the first violation found, or None when the config is acceptable.
    """
    compute_unit_limit = config.compute_unit_limit if config else None
    if not compute_unit_limit:
        return "compute_unit_limit_missing"
    if max_compute_units is not None and compute_unit_limit > max_compute_units:
        return "compute_unit_limit_too_high"
    if not (config and config.loaded_accounts_data_size_limit):
        return "loaded_accounts_data_size_limit_missing"
    priority_fee = config.priority_fee or 0
    if priority_fee * 1_000_000 > max_priority_fee_micro_lamports * compute_unit_limit:
        return "priority_fee_too_high"
    return None


def get_token_payer_from_transaction(tx: VersionedTransaction) -> str:
    """Extract the token sender (owner of source token account) from a TransferChecked instruction.

    Args:
        tx: The decoded versioned transaction.

    Returns:
        The token payer address as a base58 string, or empty string if not found.
    """
    message = tx.message
    static_accounts = list(message.account_keys)
    instructions = message.instructions

    token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    token_2022_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)

    for ix in instructions:
        program_index = ix.program_id_index
        program_address = static_accounts[program_index]

        # Check if this is a token program instruction
        if program_address == token_program or program_address == token_2022_program:
            account_indices = list(ix.accounts)
            # TransferChecked account order: [source, mint, destination, owner, ...]
            if len(account_indices) >= 4:
                owner_index = account_indices[3]
                owner_address = static_accounts[owner_index]
                return str(owner_address)

    return ""


def extract_transaction_info(tx: VersionedTransaction) -> TransactionInfo | None:
    """Extract transfer information from a parsed Solana transaction.

    Expects a transaction with compute budget + TransferChecked instructions.

    Args:
        tx: The decoded versioned transaction.

    Returns:
        TransactionInfo if transfer found, None otherwise.
    """
    message = tx.message
    static_accounts = list(message.account_keys)
    instructions = message.instructions

    token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    token_2022_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)

    # Fee payer is always the first account
    fee_payer = str(static_accounts[0])

    for ix in instructions:
        program_index = ix.program_id_index
        program_address = static_accounts[program_index]

        # Check if this is a token program instruction
        if program_address == token_program or program_address == token_2022_program:
            account_indices = list(ix.accounts)
            # TransferChecked account order: [source, mint, destination, owner, ...]
            if len(account_indices) >= 4:
                source_index = account_indices[0]
                mint_index = account_indices[1]
                dest_index = account_indices[2]
                owner_index = account_indices[3]

                # TransferChecked data layout:
                # byte 0: instruction type (12 for TransferChecked)
                # bytes 1-8: amount (u64, little-endian)
                # byte 9: decimals (u8)
                ix_data = bytes(ix.data)
                if len(ix_data) >= 10 and ix_data[0] == 12:  # TransferChecked = 12
                    amount = int.from_bytes(ix_data[1:9], "little")
                    decimals = ix_data[9]

                    return TransactionInfo(
                        fee_payer=fee_payer,
                        payer=str(static_accounts[owner_index]),
                        source_ata=str(static_accounts[source_index]),
                        destination_ata=str(static_accounts[dest_index]),
                        mint=str(static_accounts[mint_index]),
                        amount=amount,
                        decimals=decimals,
                        token_program=str(program_address),
                    )

    return None


def derive_ata(owner: str, mint: str, token_program: str | None = None) -> str:
    """Derive the Associated Token Account (ATA) address.

    Args:
        owner: Owner wallet address.
        mint: Token mint address.
        token_program: Optional token program address (defaults to Token Program).

    Returns:
        ATA address as base58 string.
    """
    from solders.pubkey import Pubkey

    ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

    if token_program is None:
        token_program = TOKEN_PROGRAM_ADDRESS

    owner_pubkey = Pubkey.from_string(owner)
    mint_pubkey = Pubkey.from_string(mint)
    program_pubkey = Pubkey.from_string(token_program)

    # PDA derivation: [owner, token_program, mint]
    seeds = [bytes(owner_pubkey), bytes(program_pubkey), bytes(mint_pubkey)]
    ata, _ = Pubkey.find_program_address(seeds, ASSOCIATED_TOKEN_PROGRAM_ID)

    return str(ata)
