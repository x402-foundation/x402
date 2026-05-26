"""Universal signature verification for EOA, EIP-1271, and ERC-6492."""

try:
    from eth_keys import keys
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e

from .constants import EIP1271_MAGIC_VALUE, IS_VALID_SIGNATURE_ABI
from .erc6492 import has_deployment_info, is_eoa_signature, parse_erc6492_signature
from .signer import FacilitatorEvmSigner
from .types import ERC6492SignatureData


def verify_eoa_signature(
    hash: bytes,
    signature: bytes,
    expected_address: str,
) -> bool:
    """Verify ECDSA signature from EOA.

    Uses secp256k1 public key recovery.
    Handles Ethereum v value adjustment (27/28 -> 0/1).

    Args:
        hash: 32-byte message hash.
        signature: 65-byte ECDSA signature (r, s, v).
        expected_address: Expected signer address.

    Returns:
        True if signature is valid.

    Raises:
        ValueError: If signature length is invalid.
    """
    if len(signature) != 65:
        raise ValueError(f"Invalid EOA signature length: expected 65, got {len(signature)}")

    # Extract r, s, v
    r = signature[:32]
    s = signature[32:64]
    v = signature[64]

    # Adjust v value for recovery
    if v >= 27:
        v = v - 27

    if v not in (0, 1):
        raise ValueError(f"Invalid v value: {v}")

    # Reconstruct signature for eth_keys
    sig_bytes = r + s + bytes([v])

    try:
        # Recover public key
        sig = keys.Signature(signature_bytes=sig_bytes)
        public_key = sig.recover_public_key_from_msg_hash(hash)
        recovered_address = public_key.to_checksum_address()

        return recovered_address.lower() == expected_address.lower()
    except Exception:
        return False


def verify_eip1271_signature(
    signer: FacilitatorEvmSigner,
    wallet: str,
    hash: bytes,
    signature: bytes,
) -> bool:
    """Verify EIP-1271 smart contract wallet signature.

    Calls isValidSignature(bytes32, bytes) on the wallet contract.

    Args:
        signer: Facilitator signer for contract calls.
        wallet: Smart wallet address.
        hash: 32-byte message hash.
        signature: Signature bytes (format is wallet-specific).

    Returns:
        True if contract returns magic value 0x1626ba7e.
    """
    try:
        result = signer.read_contract(
            wallet,
            IS_VALID_SIGNATURE_ABI,
            "isValidSignature",
            hash,
            signature,
        )

        # Result should be bytes4 magic value
        if isinstance(result, bytes):
            return result[:4] == EIP1271_MAGIC_VALUE
        elif isinstance(result, str):
            result_bytes = bytes.fromhex(result.removeprefix("0x"))
            return result_bytes[:4] == EIP1271_MAGIC_VALUE

        return False
    except Exception:
        return False


def verify_universal_signature(
    signer: FacilitatorEvmSigner,
    signer_address: str,
    hash: bytes,
    signature: bytes,
    allow_undeployed: bool = True,
) -> tuple[bool, ERC6492SignatureData]:
    """Verify signatures from EOA, EIP-1271, or ERC-6492 sources.

    Unified verification that auto-detects signature type:
    1. Parse ERC-6492 wrapper if present
    2. If inner sig is 65 bytes AND no factory: EOA path (skip GetCode)
    3. Otherwise: check if contract is deployed
    4. If undeployed + has deployment info + allowUndeployed: accept
    5. If undeployed without deployment info: fallback to EOA
    6. If deployed: use EIP-1271 verification

    Args:
        signer: Facilitator signer for blockchain interactions.
        signer_address: Expected signer address.
        hash: 32-byte message hash.
        signature: Signature bytes (may be ERC-6492 wrapped).
        allow_undeployed: Accept ERC-6492 from undeployed wallets.

    Returns:
        (valid, sig_data) tuple.
    """
    sig_data = parse_erc6492_signature(signature)

    # Optimization: skip GetCode for obvious EOA signatures
    if is_eoa_signature(sig_data):
        valid = verify_eoa_signature(hash, sig_data.inner_signature, signer_address)
        return (valid, sig_data)

    # Check if contract is deployed
    code = signer.get_code(signer_address)
    is_deployed = len(code) > 0

    if not is_deployed:
        if has_deployment_info(sig_data):
            if not allow_undeployed:
                raise ValueError("Undeployed smart wallet not allowed")
            # Valid ERC-6492 - deployment happens in settle()
            return (True, sig_data)

        # No deployment info - try EOA verification as fallback
        if len(sig_data.inner_signature) == 65:
            valid = verify_eoa_signature(hash, sig_data.inner_signature, signer_address)
            return (valid, sig_data)

        # Can't verify without deployment
        return (False, sig_data)

    # Deployed contract - use EIP-1271
    valid = verify_eip1271_signature(signer, signer_address, hash, sig_data.inner_signature)
    return (valid, sig_data)
