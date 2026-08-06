"""Universal signature verification for EOA, EIP-1271, and ERC-6492."""

try:
    from eth_account.messages import encode_typed_data as _encode_typed_data
    from eth_keys import keys
    from eth_utils import keccak
except ImportError as e:
    raise ImportError(
        "EVM mechanism requires ethereum packages. Install with: pip install x402[evm]"
    ) from e
from typing import Any

from .constants import EIP1271_MAGIC_VALUE, IS_VALID_SIGNATURE_ABI
from .erc6492 import has_deployment_info, parse_erc6492_signature
from .signer import FacilitatorEvmSigner
from .types import ERC6492SignatureData, TypedDataDomain, TypedDataField


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

    Unified verification that mirrors on-chain SignatureChecker semantics:
    1. Parse ERC-6492 wrapper if present
    2. Always fetch bytecode — routing is determined by code.length, not sig shape.
       Skipping get_code for 65-byte sigs was the pre-7702 optimisation that caused
       pre-verify/on-chain divergence for ERC-7702 delegated EOAs.
    3. If undeployed + has ERC-6492 deployment info + allowUndeployed: accept (defer to settle)
    4. If undeployed without deployment info: ECDSA fallback (covers plain EOAs)
    5. If deployed (contract OR ERC-7702 delegation): strict EIP-1271, no ECDSA fallback

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

    # Always fetch code — routing mirrors on-chain SignatureChecker (code.length-based).
    # The old is_eoa_signature fast-path skipped this for 65-byte sigs, causing
    # pre-verify to return valid for 7702 EOAs whose delegate rejects raw ECDSA on-chain.
    code = signer.get_code(signer_address)
    is_deployed = len(code) > 0

    if not is_deployed:
        if has_deployment_info(sig_data):
            if not allow_undeployed:
                raise ValueError("Undeployed smart wallet not allowed")
            # ERC-6492 counterfactual — wallet not yet deployed. Return (False, sig_data)
            # to signal "deferred to simulation/settle", matching Go's (false, sigData, nil).
            # Callers that check `valid=True` to accept payments must explicitly handle this
            # case: the payment is not valid until simulation confirms the factory deploys
            # the wallet and the transfer succeeds.
            return (False, sig_data)

        # No code, no deployment info — plain EOA path (ecrecover only)
        if len(sig_data.inner_signature) == 65:
            valid = verify_eoa_signature(hash, sig_data.inner_signature, signer_address)
            return (valid, sig_data)

        # Non-65-byte sig with no code and no factory info — cannot verify
        return (False, sig_data)

    # Has code (deployed contract OR ERC-7702 delegation) — strict EIP-1271.
    # No ECDSA fallback: if isValidSignature rejects, the on-chain token also rejects.
    valid = verify_eip1271_signature(signer, signer_address, hash, sig_data.inner_signature)
    return (valid, sig_data)


def _hash_typed_data(
    domain: TypedDataDomain | dict,
    types: dict[str, list[TypedDataField | dict]],
    primary_type: str,
    message: dict[str, Any],
) -> bytes:
    """Hash EIP-712 typed data to a 32-byte digest.

    Mirrors the on-chain keccak256(\\x19\\x01 || domainSeparator || hashStruct(message))
    computation using eth_account's encode_typed_data helper.
    """
    if isinstance(domain, dict):
        domain_dict = domain
    else:
        # Include only non-empty/non-zero fields, matching Go's HashEIP712TypedData.
        # Including empty-string or zero fields would produce a different EIP712Domain
        # typehash than Go, causing cross-SDK hash divergence for any domain that omits
        # a field (e.g. a token without a version, or a chain-agnostic domain).
        domain_dict = {}
        if domain.name:
            domain_dict["name"] = domain.name
        if domain.version:
            domain_dict["version"] = domain.version
        if domain.chain_id:
            domain_dict["chainId"] = domain.chain_id
        if domain.verifying_contract:
            domain_dict["verifyingContract"] = domain.verifying_contract

    domain_field_map = {
        "name": {"name": "name", "type": "string"},
        "version": {"name": "version", "type": "string"},
        "chainId": {"name": "chainId", "type": "uint256"},
        "verifyingContract": {"name": "verifyingContract", "type": "address"},
        "salt": {"name": "salt", "type": "bytes32"},
    }
    eip712_domain_type = [domain_field_map[k] for k in domain_dict if k in domain_field_map]

    full_types: dict[str, list[dict[str, str]]] = {
        "EIP712Domain": eip712_domain_type,
    }
    for type_name, fields in types.items():
        full_types[type_name] = [
            {"name": f.name, "type": f.type} if isinstance(f, TypedDataField) else f for f in fields
        ]

    msg_copy = dict(message)
    if "nonce" in msg_copy and isinstance(msg_copy["nonce"], bytes):
        msg_copy["nonce"] = "0x" + msg_copy["nonce"].hex()

    typed_data = {
        "types": full_types,
        "primaryType": primary_type,
        "domain": domain_dict,
        "message": msg_copy,
    }
    # eth_account.messages.encode_typed_data returns a SignableMessage with:
    #   version = b'\x01' (EIP-712 version byte)
    #   header  = domainSeparator (32 bytes)
    #   body    = hashStruct(message) (32 bytes)
    # The canonical EIP-712 digest is keccak256(b'\x19' + version + header + body).
    # This matches what Account.recover_message() and on-chain keccak256 compute.
    signable = _encode_typed_data(full_message=typed_data)
    return keccak(b"\x19" + signable.version + signable.header + signable.body)


def verify_typed_data_strict(
    signer: FacilitatorEvmSigner,
    address: str,
    domain: TypedDataDomain | dict,
    types: dict[str, list[TypedDataField | dict]],
    primary_type: str,
    message: dict[str, Any],
    signature: bytes,
) -> bool:
    """Strict typed-data signature verification that mirrors on-chain SignatureChecker.

    Routes by code.length — ecrecover for EOAs, strict EIP-1271 for any address
    with code (including ERC-7702 delegated EOAs). Does NOT fall back to ECDSA
    when EIP-1271 returns failure, unlike FacilitatorWeb3Signer.verify_typed_data
    which tries ECDSA first. That fallback causes pre-verify to accept signatures
    that on-chain SignatureChecker (USDC v2.2, Permit2) rejects.

    Args:
        signer: Facilitator signer for on-chain reads.
        address: Expected signer address.
        domain: EIP-712 domain.
        types: EIP-712 type definitions.
        primary_type: Primary type name.
        message: Message data.
        signature: Signature bytes.

    Returns:
        True iff on-chain SignatureChecker would accept the signature.
    """
    try:
        digest = _hash_typed_data(domain, types, primary_type, message)
    except Exception:
        return False

    code = signer.get_code(address)
    if not code:
        # EOA path: pure ecrecover. On-chain ecrecover never reverts — invalid
        # signatures (wrong length, bad encoding) return address(0), so we mirror
        # that by returning False instead of raising.
        try:
            return verify_eoa_signature(digest, signature, address)
        except ValueError:
            return False
    # Has code (contract or ERC-7702 delegation): strict EIP-1271, no ECDSA fallback
    return verify_eip1271_signature(signer, address, digest, signature)
