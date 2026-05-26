"""SVM utility functions for network, address, and amount handling."""

import base64
import re
from decimal import Decimal

try:
    from solders.pubkey import Pubkey
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

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

    raise ValueError(f"Token {asset_address} is not a registered asset for network {network}.")


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
