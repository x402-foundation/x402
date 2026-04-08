"""SVM utility functions for network, address, and amount handling."""

import base64
import hashlib
import re
from decimal import Decimal
from typing import Any

try:
    from solders.pubkey import Pubkey
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from .constants import (
    DEFAULT_DECIMALS,
    MEMO_PROGRAM_ADDRESS,
    NETWORK_CONFIGS,
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    SOLANA_TESTNET_CAIP2,
    SVM_ADDRESS_REGEX,
    SWIG_PROGRAM_ADDRESS,
    TOKEN_2022_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
    USDC_TESTNET_ADDRESS,
    V1_TO_V2_NETWORK_MAP,
    AssetInfo,
    NetworkConfig,
)
from .types import ExactSvmPayload, TransactionInfo, TransferDetails

TOKEN_TRANSFER_CHECKED_DISCRIMINATOR = 12
SWIG_SIGN_V2_DISCRIMINATOR = 11
SWIG_SUBACCOUNT_SIGN_V1_DISCRIMINATOR = 9


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
    """Get configuration for a network.

    Args:
        network: Network identifier (CAIP-2 or V1 format).

    Returns:
        Network configuration.

    Raises:
        ValueError: If network is not supported.
    """
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
        ValueError: If the address does not match the registered asset for the network.
    """
    config = get_network_config(network)
    default_asset = config["default_asset"]

    if not asset_address or asset_address == default_asset["address"]:
        return default_asset

    raise ValueError(
        f"Token {asset_address} is not a registered asset for network {network}."
    )


def convert_to_token_amount(decimal_amount: str, decimals: int) -> str:
    """Convert a decimal amount to token smallest units.

    Args:
        decimal_amount: The decimal amount (e.g., "0.10").
        decimals: The number of decimals for the token (e.g., 6 for USDC).

    Returns:
        The amount in smallest units as a string.

    Raises:
        ValueError: If amount is invalid.
    """
    try:
        amount = Decimal(decimal_amount)
    except Exception as e:
        raise ValueError(f"Invalid amount: {decimal_amount}") from e

    # Convert to smallest unit (e.g., for USDC with 6 decimals: 0.10 * 10^6 = 100000)
    token_amount = int(amount * Decimal(10**decimals))
    return str(token_amount)


def parse_amount(amount: str, decimals: int) -> int:
    """Convert decimal string to smallest unit.

    Args:
        amount: Decimal string (e.g., "1.50").
        decimals: Token decimals.

    Returns:
        Amount in smallest unit.
    """
    d = Decimal(amount)
    multiplier = Decimal(10**decimals)
    return int(d * multiplier)


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


def parse_money_to_decimal(money: str | float | int) -> float:
    """Parse Money to decimal.

    Handles formats like "$1.50", "1.50", 1.50.

    Args:
        money: Money value in various formats.

    Returns:
        Decimal amount as float.
    """
    if isinstance(money, int | float):
        return float(money)

    # Clean string
    clean = money.strip()
    clean = clean.lstrip("$")
    clean = re.sub(r"\s*(USD|USDC|usd|usdc)\s*$", "", clean)
    clean = clean.strip()

    return float(clean)


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


def get_token_payer_from_transaction(tx: VersionedTransaction) -> str:
    """Extract the token sender (owner of source token account) from a TransferChecked instruction.

    Args:
        tx: The decoded versioned transaction.

    Returns:
        The token payer address as a base58 string, or empty string if not found.
    """
    transfer_details = get_transfer_details_from_transaction(tx)
    return transfer_details.authority if transfer_details else ""


def get_transfer_details_from_transaction(
    tx: VersionedTransaction,
) -> TransferDetails | None:
    """Extract canonical transfer details from a transaction."""
    message = tx.message
    static_accounts = list(message.account_keys)
    instructions = message.instructions

    for ix in instructions:
        transfer_details = get_transfer_details_from_instruction(static_accounts, ix)
        if transfer_details is not None:
            return transfer_details

    return None


def get_transfer_details_from_instruction(
    static_accounts: list[Pubkey], ix: Any
) -> TransferDetails | None:
    """Extract canonical transfer details from one compiled instruction."""
    transfer_details = _extract_direct_transfer_details(static_accounts, ix)
    if transfer_details is not None:
        return transfer_details

    return _extract_swig_transfer_details(static_accounts, ix)


def _extract_direct_transfer_details(
    static_accounts: list[Pubkey], ix: Any
) -> TransferDetails | None:
    program_address = static_accounts[ix.program_id_index]
    token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    token_2022_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)

    if program_address != token_program and program_address != token_2022_program:
        return None

    account_indices = list(ix.accounts)
    ix_data = bytes(ix.data)
    if (
        len(account_indices) < 4
        or len(ix_data) < 10
        or ix_data[0] != TOKEN_TRANSFER_CHECKED_DISCRIMINATOR
    ):
        return None

    return TransferDetails(
        token_program=str(program_address),
        source=str(static_accounts[account_indices[0]]),
        mint=str(static_accounts[account_indices[1]]),
        destination=str(static_accounts[account_indices[2]]),
        authority=str(static_accounts[account_indices[3]]),
        amount=int.from_bytes(ix_data[1:9], "little"),
    )


def _extract_swig_transfer_details(
    static_accounts: list[Pubkey], ix: Any
) -> TransferDetails | None:
    swig_program = Pubkey.from_string(SWIG_PROGRAM_ADDRESS)
    if static_accounts[ix.program_id_index] != swig_program:
        return None

    outer_accounts = [static_accounts[index] for index in ix.accounts]
    compact_instructions = _decode_swig_compact_instructions(bytes(ix.data))
    if compact_instructions is None:
        return None

    transfer_details: TransferDetails | None = None
    token_program = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    token_2022_program = Pubkey.from_string(TOKEN_2022_PROGRAM_ADDRESS)
    memo_program = Pubkey.from_string(MEMO_PROGRAM_ADDRESS)

    for compact_instruction in compact_instructions:
        program_index = compact_instruction["program_id_index"]
        if program_index >= len(outer_accounts):
            return None

        program_address = outer_accounts[program_index]
        if program_address == token_program or program_address == token_2022_program:
            if transfer_details is not None:
                return None
            transfer_details = _decode_transfer_details_from_indexes(
                outer_accounts,
                str(program_address),
                compact_instruction["account_indexes"],
                compact_instruction["data"],
            )
            if transfer_details is None:
                return None
            continue

        if program_address == memo_program:
            continue

        return None

    return transfer_details


def _decode_swig_compact_instructions(data: bytes) -> list[dict[str, Any]] | None:
    if len(data) < 4:
        return None

    discriminator = int.from_bytes(data[0:2], "little")
    if discriminator == SWIG_SIGN_V2_DISCRIMINATOR:
        compact_offset = 8
    elif discriminator == SWIG_SUBACCOUNT_SIGN_V1_DISCRIMINATOR:
        compact_offset = 16
    else:
        return None

    compact_length = int.from_bytes(data[2:4], "little")
    if compact_length <= 0 or compact_offset + compact_length > len(data):
        return None

    compact_data = data[compact_offset : compact_offset + compact_length]
    if not compact_data:
        return None

    instruction_count = compact_data[0]
    offset = 1
    instructions: list[dict[str, object]] = []

    for _ in range(instruction_count):
        if offset + 4 > len(compact_data):
            return None

        program_id_index = compact_data[offset]
        offset += 1
        account_count = compact_data[offset]
        offset += 1
        if offset + account_count + 2 > len(compact_data):
            return None

        account_indexes = list(compact_data[offset : offset + account_count])
        offset += account_count
        inner_data_length = int.from_bytes(compact_data[offset : offset + 2], "little")
        offset += 2
        if offset + inner_data_length > len(compact_data):
            return None

        instruction_data = compact_data[offset : offset + inner_data_length]
        offset += inner_data_length
        instructions.append(
            {
                "program_id_index": program_id_index,
                "account_indexes": account_indexes,
                "data": instruction_data,
            }
        )

    if offset != len(compact_data):
        return None

    return instructions


def _decode_transfer_details_from_indexes(
    accounts: list[Pubkey], token_program: str, account_indexes: list[int], data: bytes
) -> TransferDetails | None:
    if (
        len(account_indexes) < 4
        or len(data) < 10
        or data[0] != TOKEN_TRANSFER_CHECKED_DISCRIMINATOR
    ):
        return None

    if any(index >= len(accounts) for index in account_indexes[:4]):
        return None

    return TransferDetails(
        token_program=token_program,
        source=str(accounts[account_indexes[0]]),
        mint=str(accounts[account_indexes[1]]),
        destination=str(accounts[account_indexes[2]]),
        authority=str(accounts[account_indexes[3]]),
        amount=int.from_bytes(data[1:9], "little"),
    )


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
    transfer_details = get_transfer_details_from_transaction(tx)
    if transfer_details is None:
        return None

    return TransactionInfo(
        fee_payer=str(static_accounts[0]),
        payer=transfer_details.authority,
        source_ata=transfer_details.source,
        destination_ata=transfer_details.destination,
        mint=transfer_details.mint,
        amount=transfer_details.amount,
        decimals=DEFAULT_DECIMALS,
        token_program=transfer_details.token_program,
    )


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

    ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    )

    if token_program is None:
        token_program = TOKEN_PROGRAM_ADDRESS

    owner_pubkey = Pubkey.from_string(owner)
    mint_pubkey = Pubkey.from_string(mint)
    program_pubkey = Pubkey.from_string(token_program)

    # PDA derivation: [owner, token_program, mint]
    seeds = [bytes(owner_pubkey), bytes(program_pubkey), bytes(mint_pubkey)]
    ata, _ = Pubkey.find_program_address(seeds, ASSOCIATED_TOKEN_PROGRAM_ID)

    return str(ata)
