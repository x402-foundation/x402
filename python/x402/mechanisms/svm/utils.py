"""SVM utility functions for network, address, and amount handling."""

import base64
import binascii
import hashlib
import re
from collections.abc import Sequence
from decimal import Decimal
from typing import TYPE_CHECKING

try:
    from solders.hash import Hash, ParseHashError
    from solders.instruction import Instruction
    from solders.keypair import Keypair
    from solders.message import (
        Message,
        MessageV0,
        MessageV1,
        TransactionConfig,
        to_bytes_versioned,
    )
    from solders.pubkey import Pubkey
    from solders.signature import Signature
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from ...schemas.helpers import convert_to_token_amount
from .constants import (
    ACCEPTED_TRANSACTION_VERSIONS,
    ADVERTISED_TRANSACTION_VERSIONS,
    CLIENT_SUPPORTED_TRANSACTION_VERSIONS,
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    DEFAULT_COMPUTE_UNIT_LIMIT,
    DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    ERR_COMPUTE_LIMIT_TOO_HIGH,
    ERR_COMPUTE_PRICE_TOO_HIGH,
    ERR_INVALID_COMPUTE_LIMIT,
    ERR_INVALID_COMPUTE_PRICE,
    ERR_INVALID_INSTRUCTION_COUNT,
    ERR_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_MISSING,
    ERR_UNSUPPORTED_TRANSACTION_VERSION,
    ERR_V1_COMPUTE_BUDGET_INSTRUCTION,
    ERR_V1_HEAP_SIZE,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MAX_TRANSACTION_SIZE_V0,
    MAX_TRANSACTION_SIZE_V1,
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


def peek_wire_transaction_version(transaction_b64: str) -> int | str | None:
    """Read a wire transaction's message version from its raw bytes.

    Legacy and version-0 transactions start with the compact-u16 signature
    count (always below ``0x80`` within the size limit), then the signatures,
    then the message, whose first byte carries the version prefix when its
    high bit is set. Version 1 (SIMD-0385) puts the message first, so its first
    byte is the version byte itself (``0x81``).

    Verifiers call this before decoding so a newer format is reported as
    ``unsupported_transaction_version`` whether the installed solders rejects
    it, misreads it, or decodes it.

    Args:
        transaction_b64: The base64-encoded wire transaction.

    Returns:
        The message version (``"legacy"`` or an int), or None when the bytes
        cannot be read or are too short to tell.
    """
    try:
        raw = base64.b64decode(transaction_b64, validate=True)
    except (ValueError, TypeError):
        return None
    if not raw:
        return None
    if raw[0] & 0x80:
        return raw[0] & 0x7F
    prefix_offset = 1 + 64 * raw[0]
    if prefix_offset >= len(raw):
        return None
    prefix = raw[prefix_offset]
    return prefix & 0x7F if prefix & 0x80 else "legacy"


def priority_fee_lamports(compute_unit_limit: int, micro_lamports_per_cu: int) -> int:
    """Convert a per-compute-unit price into version 1's total lamport fee.

    Rounds up, matching how the runtime charges a version 0
    ``SetComputeUnitPrice`` on the requested limit.

    Args:
        compute_unit_limit: Requested compute units.
        micro_lamports_per_cu: Price in microlamports per compute unit.

    Returns:
        The total priority fee in lamports.
    """
    return -(-(compute_unit_limit * micro_lamports_per_cu) // 1_000_000)


def compile_payment_message(
    version: int,
    payer: Pubkey,
    instructions: list[Instruction],
    recent_blockhash: Hash,
    compute_unit_limit: int = DEFAULT_COMPUTE_UNIT_LIMIT,
    compute_unit_price_micro_lamports: int = DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
) -> MessageV0 | MessageV1:
    """Compile a client payment message in the negotiated transaction version.

    ``instructions`` are the payment instructions only; this function adds the
    compute budget in the form the version uses. Version 0 gets a
    ``SetComputeUnitLimit`` + ``SetComputeUnitPrice`` prefix. Version 1 gets
    no ComputeBudget instructions (the runtime ignores them there) and sets
    ``compute_unit_limit``, ``loaded_accounts_data_size_limit`` and the total
    ``priority_fee`` in the message config instead.

    Args:
        version: Version returned by ``resolve_transaction_version``.
        payer: Fee payer for the message.
        instructions: Payment instructions to compile.
        recent_blockhash: Transaction lifetime.
        compute_unit_limit: Requested compute units.
        compute_unit_price_micro_lamports: Priority price per compute unit.

    Returns:
        The compiled message.

    Raises:
        ValueError: If this client has no builder for ``version``.
    """
    if version == 0:
        compute_budget_program = Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS)
        set_cu_limit_ix = Instruction(
            program_id=compute_budget_program,
            accounts=[],
            data=bytes([2]) + compute_unit_limit.to_bytes(4, "little"),
        )
        set_cu_price_ix = Instruction(
            program_id=compute_budget_program,
            accounts=[],
            data=bytes([3]) + compute_unit_price_micro_lamports.to_bytes(8, "little"),
        )
        return MessageV0.try_compile(
            payer=payer,
            instructions=[set_cu_limit_ix, set_cu_price_ix, *instructions],
            address_lookup_table_accounts=[],
            recent_blockhash=recent_blockhash,
        )
    if version == 1:
        fee = priority_fee_lamports(compute_unit_limit, compute_unit_price_micro_lamports)
        config = TransactionConfig(
            priority_fee=fee if fee > 0 else None,
            compute_unit_limit=compute_unit_limit,
            loaded_accounts_data_size_limit=DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
        )
        return MessageV1.try_compile(payer, instructions, recent_blockhash, config)
    raise ValueError(
        f"{ERR_UNSUPPORTED_TRANSACTION_VERSION}: this client cannot build transaction "
        f"version {version!r}"
    )


def max_transaction_size(version: int | str) -> int:
    """Return the serialized size limit for a transaction message version.

    Args:
        version: Version reported by ``get_transaction_version``.

    Returns:
        4096 bytes for version 1, 1232 bytes for legacy and version 0.
    """
    return MAX_TRANSACTION_SIZE_V1 if version == 1 else MAX_TRANSACTION_SIZE_V0


def transaction_size_exceeded(transaction_b64: str, version: int | str) -> bool:
    """Whether a wire transaction exceeds its message version's size limit.

    Verifiers call this after the version gate: the decoder accepts an
    oversized transaction, but the network would drop it after the sponsor
    co-signed it. Legacy is policed as version 0.

    Args:
        transaction_b64: The base64-encoded wire transaction.
        version: Its message version, as ``get_transaction_version`` reports it.

    Returns:
        True when the serialized transaction is larger than the limit.
    """
    try:
        size = len(base64.b64decode(transaction_b64, validate=True))
    except (binascii.Error, ValueError):
        return True
    return size > max_transaction_size(version)


def encode_partially_signed_transaction(message: MessageV0 | MessageV1, keypair: Keypair) -> str:
    """Sign a payment message as the token authority and encode it for the wire.

    The facilitator's fee-payer slot (index 0) is left empty for it to fill
    at settlement. The signed bytes are the message behind its version prefix
    (0x80 for version 0, 0x81 for version 1), as ``to_bytes_versioned``
    serializes them.

    Args:
        message: Compiled payment message whose fee payer is the facilitator.
        keypair: Client keypair, the only other required signer.

    Returns:
        The base64-encoded wire transaction.

    Raises:
        ValueError: If the transaction exceeds its version's size limit.
    """
    client_signature = keypair.sign_message(to_bytes_versioned(message))
    tx = VersionedTransaction.populate(message, [Signature.default(), client_signature])
    raw = bytes(tx)
    limit = max_transaction_size(get_transaction_version(message))
    if len(raw) > limit:
        raise ValueError(f"payment transaction is {len(raw)} bytes, above the {limit}-byte limit")
    return base64.b64encode(raw).decode("utf-8")


def check_transaction_v1_config(
    config: TransactionConfig,
    max_compute_unit_price_micro_lamports: int,
    max_compute_units: int | None = None,
) -> str | None:
    """Apply the sponsor's compute budget caps to a version-1 message config.

    solders rejects a config mask that sets only one of the two priority-fee
    bits at decode, so a decoded config already has both or neither. An unset
    value takes its minimum (SIMD-0385): an unset compute unit limit or
    loaded-account-data limit requests 0, so both must be set for the
    instructions to run. The fee is a total in lamports, compared against the
    per-compute-unit cap as ``priority_fee * 1_000_000 <= cap * limit`` (Python
    integers cannot overflow).

    Args:
        config: ``message.config`` of a decoded version-1 message.
        max_compute_unit_price_micro_lamports: Price cap in microlamports per CU.
        max_compute_units: Compute unit cap, or None for no cap.

    Returns:
        The invalid reason, or None when the config is within policy.
    """
    if config.heap_size is not None:
        return ERR_V1_HEAP_SIZE
    compute_unit_limit = config.compute_unit_limit
    if compute_unit_limit is None:
        return ERR_INVALID_COMPUTE_LIMIT
    if max_compute_units is not None and compute_unit_limit > max_compute_units:
        return ERR_COMPUTE_LIMIT_TOO_HIGH
    if config.loaded_accounts_data_size_limit is None:
        return ERR_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_MISSING
    priority_fee = config.priority_fee or 0
    if priority_fee * 1_000_000 > max_compute_unit_price_micro_lamports * compute_unit_limit:
        return ERR_COMPUTE_PRICE_TOO_HIGH
    return None


# Lighthouse/Memo slots allowed after the TransferChecked. Version 1 follows
# the spec's four slots (Phantom can inject three Lighthouse instructions plus
# the memo); legacy and version 0 keep this verifier's existing three.
MAX_OPTIONAL_INSTRUCTIONS_V0 = 3
MAX_OPTIONAL_INSTRUCTIONS_V1 = 4


def check_exact_compute_budget(
    message: Message | MessageV0 | MessageV1,
    max_compute_unit_price_micro_lamports: int = MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
) -> tuple[str | None, int]:
    """Check an exact payment's instruction count and compute budget.

    Legacy and version 0 carry the budget as a ``SetComputeUnitLimit`` +
    ``SetComputeUnitPrice`` prefix, so the TransferChecked is at index 2.
    Version 1 carries it in ``message.config``, so the transfer comes first and
    no ComputeBudget instruction may appear anywhere in the message.

    Args:
        message: Decoded message of an accepted version.
        max_compute_unit_price_micro_lamports: Price cap in microlamports per CU.

    Returns:
        ``(invalid_reason, transfer_index)``; the reason is None when the
        layout and budget are within policy.
    """
    transfer_index = exact_budget_prefix_length(message)
    max_optional = (
        MAX_OPTIONAL_INSTRUCTIONS_V1
        if isinstance(message, MessageV1)
        else MAX_OPTIONAL_INSTRUCTIONS_V0
    )
    if not transfer_index + 1 <= len(message.instructions) <= transfer_index + 1 + max_optional:
        return ERR_INVALID_INSTRUCTION_COUNT, transfer_index
    return (
        check_exact_budget(message, max_compute_unit_price_micro_lamports),
        transfer_index,
    )


def exact_budget_prefix_length(message: Message | MessageV0 | MessageV1) -> int:
    """Number of ComputeBudget instructions an exact payment starts with.

    Two (``SetComputeUnitLimit`` + ``SetComputeUnitPrice``) on legacy and
    version 0; none on version 1, which carries its budget in the message config.

    Args:
        message: Decoded message of an accepted version.

    Returns:
        The index of the first payment instruction.
    """
    return 0 if isinstance(message, MessageV1) else 2


def check_exact_budget(
    message: Message | MessageV0 | MessageV1,
    max_compute_unit_price_micro_lamports: int = MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
) -> str | None:
    """Check an exact payment's compute budget, whatever its instruction count.

    The caller checks the instruction count for its layout first; on legacy
    and version 0 the message must hold at least the two-instruction prefix.

    Args:
        message: Decoded message of an accepted version.
        max_compute_unit_price_micro_lamports: Price cap in microlamports per CU.

    Returns:
        The invalid reason, or None when the budget is within policy.
    """
    instructions = message.instructions
    static_accounts = list(message.account_keys)
    compute_budget_program = Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS)

    if isinstance(message, MessageV1):
        if any(
            static_accounts[ix.program_id_index] == compute_budget_program for ix in instructions
        ):
            return ERR_V1_COMPUTE_BUDGET_INSTRUCTION
        return check_transaction_v1_config(message.config, max_compute_unit_price_micro_lamports)

    cu_limit_ix = instructions[0]
    cu_limit_data = bytes(cu_limit_ix.data)
    if (
        static_accounts[cu_limit_ix.program_id_index] != compute_budget_program
        or len(cu_limit_data) < 1
        or cu_limit_data[0] != 2  # SetComputeUnitLimit discriminator
    ):
        return ERR_INVALID_COMPUTE_LIMIT

    cu_price_ix = instructions[1]
    cu_price_data = bytes(cu_price_ix.data)
    if (
        static_accounts[cu_price_ix.program_id_index] != compute_budget_program
        or len(cu_price_data) < 9
        or cu_price_data[0] != 3  # SetComputeUnitPrice discriminator
    ):
        return ERR_INVALID_COMPUTE_PRICE

    # microLamports is a u64, little-endian
    micro_lamports = int.from_bytes(cu_price_data[1:9], "little")
    if micro_lamports > max_compute_unit_price_micro_lamports:
        return ERR_COMPUTE_PRICE_TOO_HIGH
    return None


def get_transaction_version(message: object) -> int | str:
    """Return the version of a decoded transaction message.

    Legacy messages have no version prefix; versioned messages are serialized
    behind a single byte of ``0x80 | version``.

    Args:
        message: Decoded transaction message (``tx.message``).

    Returns:
        ``"legacy"`` for an unversioned message, ``0`` for a v0 message,
        otherwise the version number read from the serialized prefix, or ``-1``
        when it cannot be determined.
    """
    if isinstance(message, Message):
        return "legacy"
    if isinstance(message, MessageV0):
        return 0
    if isinstance(message, MessageV1):
        return 1
    try:
        return to_bytes_versioned(message)[0] & 0x7F  # type: ignore[arg-type]
    except Exception:
        return -1


def is_accepted_transaction_version(
    version: int | str, accepted: Sequence[int] | None = None
) -> bool:
    """Return whether a transaction version is one the SVM verifiers police.

    This is an allowlist (see ``ACCEPTED_TRANSACTION_VERSIONS``), not a denylist:
    the fee-policy checks read ComputeBudget instructions, which a newer message
    version may relocate, so anything unmodelled must be rejected outright.

    Args:
        version: Version reported by ``get_transaction_version``.
        accepted: A facilitator's configured versions (see
            ``normalize_accepted_transaction_versions``); legacy is accepted
            exactly when 0 is. None means every modelled version.

    Returns:
        True if the version is accepted, False otherwise.
    """
    if isinstance(version, bool):
        return False
    if version not in ACCEPTED_TRANSACTION_VERSIONS:
        return False
    if accepted is None:
        return True
    return (0 if version == "legacy" else version) in accepted


def normalize_accepted_transaction_versions(versions: Sequence[int] | None) -> list[int]:
    """Validate a facilitator's ``transaction_versions`` option.

    These are the message versions it accepts and advertises as
    ``extra.transactionVersions``.

    Args:
        versions: The configured versions, or None for
            ``ADVERTISED_TRANSACTION_VERSIONS``.

    Returns:
        The accepted versions, deduplicated and ascending.

    Raises:
        ValueError: If ``versions`` is empty or holds anything but 0 and 1.
    """
    if versions is None:
        return [int(version) for version in ADVERTISED_TRANSACTION_VERSIONS]
    checked = _check_transaction_version_entries(versions, "transaction_versions")
    if not checked:
        raise ValueError(
            f"{ERR_UNSUPPORTED_TRANSACTION_VERSION}: transaction_versions must not be empty"
        )
    return sorted(set(checked))


def _check_transaction_version_entries(versions: object, field: str) -> list[int]:
    """Validate a list holding only the integers 0 and 1.

    Any other entry, including Wallet Standard's "legacy" or a stringified
    version, invalidates the whole list rather than being skipped.

    Args:
        versions: The value to validate.
        field: Name used in the error message.

    Returns:
        The validated list.

    Raises:
        ValueError: If ``versions`` is not a list of 0/1 integers.
    """
    if not isinstance(versions, list | tuple):
        raise ValueError(f"{ERR_UNSUPPORTED_TRANSACTION_VERSION}: {field} must be a list")
    for offered in versions:
        if isinstance(offered, bool) or not isinstance(offered, int) or offered not in (0, 1):
            raise ValueError(
                f"{ERR_UNSUPPORTED_TRANSACTION_VERSION}: {field} entries must be "
                f"the integers 0 or 1, got {offered!r}"
            )
    return list(versions)


def normalize_client_transaction_versions(versions: Sequence[int] | None) -> list[int]:
    """Validate a client's own supported-version restriction.

    Args:
        versions: Versions the client (and its signer) can build, or None for
            every version this implementation builds.

    Returns:
        The supported versions.

    Raises:
        ValueError: If ``versions`` is empty or holds anything but 0 and 1.
    """
    if versions is None:
        return list(CLIENT_SUPPORTED_TRANSACTION_VERSIONS)
    checked = _check_transaction_version_entries(versions, "transaction_versions")
    if not checked:
        raise ValueError(
            f"{ERR_UNSUPPORTED_TRANSACTION_VERSION}: transaction_versions must not be empty"
        )
    return checked


def resolve_transaction_version(extra: dict | None, supported: Sequence[int] | None = None) -> int:
    """Pick the transaction message version a client should build.

    Reads ``extra.transactionVersions`` (copied by the server from the
    facilitator's ``/supported`` extra; absent means ``[0]``) and selects the
    highest version it shares with ``supported``. Legacy is deprecated and
    never built.

    Args:
        extra: ``PaymentRequirements.extra`` (may be None).
        supported: Versions this client and its signer can build; defaults to
            ``CLIENT_SUPPORTED_TRANSACTION_VERSIONS``.

    Returns:
        The highest mutually supported version.

    Raises:
        ValueError: If the advertised field is invalid or the sets do not intersect.
    """
    advertised = (
        [0] if extra is None or "transactionVersions" not in extra else extra["transactionVersions"]
    )
    if not isinstance(advertised, list):
        raise ValueError(
            f"{ERR_UNSUPPORTED_TRANSACTION_VERSION}: transactionVersions must be a list"
        )
    advertised = _check_transaction_version_entries(advertised, "transactionVersions")
    client_versions = normalize_client_transaction_versions(supported)
    mutually_supported = [version for version in client_versions if version in advertised]
    if mutually_supported:
        return max(mutually_supported)
    raise ValueError(
        f"{ERR_UNSUPPORTED_TRANSACTION_VERSION}: facilitator accepts {advertised!r}, "
        f"but this client builds only {client_versions!r}"
    )


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

    Finds the first TransferChecked whatever the layout, so it reads legacy,
    version 0 (compute budget prefix) and version 1 (no prefix) alike.

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
