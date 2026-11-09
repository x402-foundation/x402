"""Integration-test helpers for real smart-account signature wrapping.

Coinbase Smart Wallet (ERC-4337): replay-safe EIP-712 + SignatureWrapper.
Biconomy Nexus (ERC-7579): ERC-7739 nested EIP-712 + validator prefix.
"""

from __future__ import annotations

import struct
from typing import Any

from eth_abi import encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import to_checksum_address
from web3 import Web3

from x402.mechanisms.evm.constants import EIP1271_MAGIC_VALUE
from x402.mechanisms.evm.types import TypedDataDomain, TypedDataField
from x402.mechanisms.evm.verify import _hash_typed_data

COINBASE_SMART_WALLET_FACTORY = "0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842"
NEXUS_ACCOUNT_FACTORY = "0x000000002c9A405a196f2dc766F2476B731693c3"
NEXUS_BOOTSTRAP = "0x000000007BfEdA33ac982cb38eAaEf5D7bCC954c"
NEXUS_K1_VALIDATOR = "0x0000000002d3cC5642A748B6783F32C032616E03"
NEXUS_DEFAULT_VALIDATOR_PREFIX = bytes(20)

EIP712_DOMAIN_ABI = [
    {
        "name": "eip712Domain",
        "type": "function",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [
            {"name": "fields", "type": "bytes1"},
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"},
            {"name": "salt", "type": "bytes32"},
            {"name": "extensions", "type": "uint256[]"},
        ],
    }
]

IS_VALID_SIGNATURE_ABI = [
    {
        "name": "isValidSignature",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "hash", "type": "bytes32"},
            {"name": "signature", "type": "bytes"},
        ],
        "outputs": [{"type": "bytes4"}],
    }
]


def _domain_dict(domain: TypedDataDomain | dict[str, Any]) -> dict[str, Any]:
    if isinstance(domain, TypedDataDomain):
        return {
            "name": domain.name,
            "version": domain.version,
            "chainId": domain.chain_id,
            "verifyingContract": domain.verifying_contract,
        }
    return domain


def _types_dict(
    types: dict[str, list[TypedDataField | dict[str, str]]],
) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    for type_name, fields in types.items():
        out[type_name] = [
            {"name": f.name, "type": f.type} if isinstance(f, TypedDataField) else f for f in fields
        ]
    return out


def _prepare_message_for_eth_account(message: dict[str, Any]) -> dict[str, Any]:
    msg = dict(message)
    if "nonce" in msg and isinstance(msg["nonce"], bytes):
        msg["nonce"] = "0x" + msg["nonce"].hex()
    return msg


def hash_typed_data_digest(
    domain: TypedDataDomain | dict[str, Any],
    types: dict[str, list[TypedDataField | dict[str, str]]],
    primary_type: str,
    message: dict[str, Any],
) -> bytes:
    return _hash_typed_data(domain, types, primary_type, message)


def wrap_coinbase_signature(signature: bytes, owner_index: int = 0) -> bytes:
    if len(signature) != 65:
        raise ValueError(f"expected 65-byte signature, got {len(signature)}")
    # Coinbase Smart Wallet expects raw r||s||v bytes, not ABI-encoded (bytes32,bytes32,uint8).
    return encode(["uint8", "bytes"], [owner_index, signature])


def wrap_erc7739_typed_data_signature(
    domain: TypedDataDomain | dict[str, Any],
    types: dict[str, list[TypedDataField | dict[str, str]]],
    primary_type: str,
    message: dict[str, Any],
    signature: bytes,
) -> bytes:
    domain_dict = _domain_dict(domain)
    types_dict = _types_dict(types)
    full_message = {
        "types": types_dict,
        "primaryType": primary_type,
        "domain": domain_dict,
        "message": _prepare_message_for_eth_account(message),
    }
    signable = encode_typed_data(full_message=full_message)
    encoded_type = _encode_type(primary_type, types_dict)
    type_bytes = encoded_type.encode("utf-8")
    return (
        signature
        + signable.header
        + signable.body
        + type_bytes
        + struct.pack(">H", len(type_bytes))
    )


def _encode_type(primary_type: str, types: dict[str, list[dict[str, str]]]) -> str:
    deps: list[str] = []
    seen: set[str] = set()

    def collect(type_name: str) -> None:
        if type_name in seen or type_name == "EIP712Domain":
            return
        seen.add(type_name)
        for field in types.get(type_name, []):
            base = field["type"].split("[", 1)[0]
            if base in types and base != "EIP712Domain":
                collect(base)
        if type_name != "EIP712Domain":
            deps.append(type_name)

    collect(primary_type)
    parts: list[str] = []
    for dep in deps:
        fields = types[dep]
        inner = ",".join(f"{f['type']} {f['name']}" for f in fields)
        parts.append(f"{dep}({inner})")
    return "".join(parts)


def sign_coinbase_smart_wallet_typed_data(
    owner: Account,
    smart_account_address: str,
    domain: TypedDataDomain | dict[str, Any],
    types: dict[str, list[TypedDataField | dict[str, str]]],
    primary_type: str,
    message: dict[str, Any],
    chain_id: int = 84532,
) -> bytes:
    original_hash = hash_typed_data_digest(domain, types, primary_type, message)
    replay_message = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "CoinbaseSmartWalletMessage": [{"name": "hash", "type": "bytes32"}],
        },
        "primaryType": "CoinbaseSmartWalletMessage",
        "domain": {
            "name": "Coinbase Smart Wallet",
            "version": "1",
            "chainId": chain_id,
            "verifyingContract": to_checksum_address(smart_account_address),
        },
        "message": {"hash": "0x" + original_hash.hex()},
    }
    signable = encode_typed_data(full_message=replay_message)
    inner_sig = owner.sign_message(signable).signature
    return wrap_coinbase_signature(inner_sig)


def fetch_nexus_verifier_domain(w3: Web3, nexus_address: str) -> dict[str, Any]:
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(nexus_address),
        abi=EIP712_DOMAIN_ABI,
    )
    result = contract.functions.eip712Domain().call()
    return {
        "name": result[1],
        "version": result[2],
        "chainId": result[3],
        "verifyingContract": to_checksum_address(result[4]),
        "salt": result[5],
    }


def sign_nexus_typed_data(
    owner: Account,
    nexus_address: str,
    validator_address: str,
    domain: TypedDataDomain | dict[str, Any],
    types: dict[str, list[TypedDataField | dict[str, str]]],
    primary_type: str,
    message: dict[str, Any],
    w3: Web3,
) -> bytes:
    verifier_domain = fetch_nexus_verifier_domain(w3, nexus_address)
    types_dict = _types_dict(types)
    types_dict["TypedDataSign"] = [
        {"name": "contents", "type": primary_type},
        {"name": "name", "type": "string"},
        {"name": "version", "type": "string"},
        {"name": "chainId", "type": "uint256"},
        {"name": "verifyingContract", "type": "address"},
        {"name": "salt", "type": "bytes32"},
    ]
    nested_message = {
        "types": types_dict,
        "primaryType": "TypedDataSign",
        "domain": _domain_dict(domain),
        "message": {
            "contents": _prepare_message_for_eth_account(message),
            "name": verifier_domain["name"],
            "version": verifier_domain["version"],
            "chainId": verifier_domain["chainId"],
            "verifyingContract": verifier_domain["verifyingContract"],
            "salt": verifier_domain["salt"],
        },
    }
    signable = encode_typed_data(full_message=nested_message)
    inner_sig = owner.sign_message(signable).signature
    wrapped = wrap_erc7739_typed_data_signature(domain, types, primary_type, message, inner_sig)
    return NEXUS_DEFAULT_VALIDATOR_PREFIX + wrapped


def verify_is_valid_signature(
    w3: Web3,
    account_address: str,
    digest: bytes,
    signature: bytes,
) -> bool:
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(account_address),
        abi=IS_VALID_SIGNATURE_ABI,
    )
    result = contract.functions.isValidSignature(digest, signature).call()
    if isinstance(result, (bytes, bytearray)):
        magic = "0x" + result[:4].hex()
    else:
        magic = result
    return str(magic).lower() == EIP1271_MAGIC_VALUE.lower()


class CoinbaseSmartWalletSigner:
    """Client signer presenting a Coinbase Smart Wallet address with wrapped signatures."""

    def __init__(self, owner: Account, smart_account_address: str, chain_id: int = 84532) -> None:
        self._owner = owner
        self._address = to_checksum_address(smart_account_address)
        self._chain_id = chain_id

    @property
    def address(self) -> str:
        return self._address

    def sign_typed_data(
        self,
        domain: TypedDataDomain,
        types: dict[str, list[TypedDataField]],
        primary_type: str,
        message: dict[str, Any],
    ) -> bytes:
        return sign_coinbase_smart_wallet_typed_data(
            self._owner,
            self._address,
            domain,
            types,
            primary_type,
            message,
            self._chain_id,
        )


class NexusSmartAccountSigner:
    """Client signer presenting a Biconomy Nexus address with ERC-7739 wrapped signatures."""

    def __init__(
        self,
        owner: Account,
        nexus_address: str,
        w3: Web3,
        validator_address: str = NEXUS_K1_VALIDATOR,
    ) -> None:
        self._owner = owner
        self._address = to_checksum_address(nexus_address)
        self._w3 = w3
        self._validator = validator_address

    @property
    def address(self) -> str:
        return self._address

    def sign_typed_data(
        self,
        domain: TypedDataDomain,
        types: dict[str, list[TypedDataField]],
        primary_type: str,
        message: dict[str, Any],
    ) -> bytes:
        return sign_nexus_typed_data(
            self._owner,
            self._address,
            self._validator,
            domain,
            types,
            primary_type,
            message,
            self._w3,
        )
