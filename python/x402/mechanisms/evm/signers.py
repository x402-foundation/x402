"""EVM signer implementations for common wallet libraries.

Provides ready-to-use signer implementations for popular Python Ethereum
libraries like eth_account and web3.py.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("x402.signers")

try:
    from eth_account import Account
    from eth_account.messages import encode_typed_data
    from eth_account.signers.local import LocalAccount
    from web3 import Web3
    from web3.middleware import ExtraDataToPOAMiddleware
except ImportError as e:
    raise ImportError(
        "EVM signers require eth_account and web3. Install with: pip install x402[evm]"
    ) from e

from .constants import EIP1271_MAGIC_VALUE, IS_VALID_SIGNATURE_ABI, TX_STATUS_SUCCESS  # noqa: E402
from .types import TransactionReceipt, TypedDataDomain, TypedDataField  # noqa: E402

# ERC20 ABI for balance checks
_ERC20_BALANCE_ABI = [
    {
        "inputs": [{"name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]


class EthAccountSigner:
    """Client-side EVM signer using eth_account library.

    Implements the ClientEvmSigner protocol for use with eth_account's
    LocalAccount (from private key or mnemonic).

    Example:
        ```python
        from eth_account import Account
        from x402.mechanisms.evm.signers import EthAccountSigner

        # From private key
        account = Account.from_key("0x...")
        signer = EthAccountSigner(account)

        # Use with x402 client
        from x402 import x402Client
        from x402.mechanisms.evm.exact import register_exact_evm_client

        client = x402Client()
        register_exact_evm_client(client, signer)
        ```

    Args:
        account: eth_account LocalAccount instance.
    """

    def __init__(self, account: LocalAccount) -> None:
        """Initialize signer with eth_account LocalAccount.

        Args:
            account: eth_account LocalAccount instance (from Account.from_key,
                Account.from_mnemonic, etc.).
        """
        self._account = account

    @property
    def address(self) -> str:
        """The signer's Ethereum address (checksummed).

        Returns:
            Checksummed Ethereum address (0x...).
        """
        return self._account.address

    def sign_typed_data(
        self,
        domain: TypedDataDomain,
        types: dict[str, list[TypedDataField]],
        primary_type: str,
        message: dict[str, Any],
    ) -> bytes:
        """Sign EIP-712 typed data.

        Args:
            domain: EIP-712 domain separator.
            types: Type definitions (dict of type name to list of TypedDataField).
            primary_type: Primary type name (unused, inferred by eth_account).
            message: Message data.

        Returns:
            65-byte ECDSA signature (r, s, v).
        """
        # Convert TypedDataField objects to dicts for eth_account
        types_dict: dict[str, list[dict[str, str]]] = {}
        for type_name, fields in types.items():
            types_dict[type_name] = [
                {"name": f.name, "type": f.type} if isinstance(f, TypedDataField) else f
                for f in fields
            ]

        # Convert TypedDataDomain to dict if needed
        domain_dict: dict[str, Any]
        if isinstance(domain, TypedDataDomain):
            domain_dict = {
                "name": domain.name,
                "version": domain.version,
                "chainId": domain.chain_id,
                "verifyingContract": domain.verifying_contract,
            }
        else:
            domain_dict = domain

        logger.info(
            "EthAccountSigner.sign_typed_data: primaryType=%s domain_keys=%s type_names=%s",
            primary_type,
            list(domain_dict.keys()),
            list(types_dict.keys()),
        )
        logger.debug("EthAccountSigner.sign_typed_data: domain=%s message=%s", domain_dict, message)

        # Sign typed data using eth_account
        signed = self._account.sign_typed_data(
            domain_data=domain_dict,
            message_types=types_dict,
            message_data=message,
        )
        return bytes(signed.signature)


class EthAccountSignerWithRPC(EthAccountSigner):
    """Client-side EVM signer with RPC capabilities for gas sponsoring extensions.

    Extends EthAccountSigner with read_contract, sign_transaction, and
    get_transaction_count — the capabilities needed for EIP-2612 and
    ERC-20 approval gas sponsoring.

    Equivalent to TS's toClientEvmSigner(account, publicClient).

    Example:
        ```python
        from eth_account import Account
        from x402.mechanisms.evm.signers import EthAccountSignerWithRPC

        account = Account.from_key("0x...")
        signer = EthAccountSignerWithRPC(account, rpc_url="https://sepolia.base.org")

        # Supports Permit2 with gas sponsoring extensions
        from x402 import x402Client
        from x402.mechanisms.evm.exact import register_exact_evm_client

        client = x402Client()
        register_exact_evm_client(client, signer)
        ```
    """

    def __init__(self, account: LocalAccount, rpc_url: str) -> None:
        """Initialize signer with eth_account LocalAccount and RPC connection.

        Args:
            account: eth_account LocalAccount instance.
            rpc_url: Ethereum RPC endpoint URL for on-chain reads.
        """
        super().__init__(account)
        self._w3 = Web3(Web3.HTTPProvider(rpc_url))

    def read_contract(
        self,
        address: str,
        abi: list[dict[str, Any]],
        function_name: str,
        *args: Any,
    ) -> Any:
        """Read data from a smart contract.

        Args:
            address: Contract address.
            abi: Contract ABI.
            function_name: Function to call.
            *args: Function arguments.

        Returns:
            Function return value.
        """
        contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(address),
            abi=abi,
        )
        return getattr(contract.functions, function_name)(*args).call()

    def sign_transaction(self, tx: dict[str, Any]) -> str:
        """Sign an EIP-1559 transaction and return the RLP-encoded hex string.

        Args:
            tx: Transaction dict with fields like to, data, nonce, gas, etc.

        Returns:
            Hex-encoded signed transaction with 0x prefix.
        """
        signed = self._w3.eth.account.sign_transaction(tx, self._account.key)
        return "0x" + signed.raw_transaction.hex()

    def get_transaction_count(self, address: str) -> int:
        """Get the pending nonce for an address.

        Args:
            address: Account address.

        Returns:
            Pending transaction count.
        """
        return self._w3.eth.get_transaction_count(Web3.to_checksum_address(address))

    def estimate_fees_per_gas(self) -> tuple[int, int]:
        """Estimate EIP-1559 fee parameters from the network.

        Returns:
            Tuple of (maxFeePerGas, maxPriorityFeePerGas) in wei.
        """
        latest = self._w3.eth.get_block("latest")
        base_fee = latest.get("baseFeePerGas", 1_000_000_000)
        max_priority_fee = self._w3.eth.max_priority_fee
        max_fee = base_fee * 2 + max_priority_fee
        return (max_fee, max_priority_fee)


class FacilitatorWeb3Signer:
    """Facilitator-side EVM signer using web3.py.

    Implements the FacilitatorEvmSigner protocol for use with web3.py
    and eth_account, enabling signature verification and on-chain settlement.

    Example:
        ```python
        from x402.mechanisms.evm import FacilitatorWeb3Signer
        from x402 import x402Facilitator
        from x402.mechanisms.evm.exact import register_exact_evm_facilitator

        signer = FacilitatorWeb3Signer(
            private_key="0x...",
            rpc_url="https://sepolia.base.org",
        )

        facilitator = x402Facilitator()
        register_exact_evm_facilitator(facilitator, signer, networks="eip155:84532")
        ```

    Attributes:
        address: The signer's checksummed Ethereum address.
    """

    def __init__(
        self,
        private_key: str,
        rpc_url: str,
    ) -> None:
        """Initialize signer with private key and RPC connection.

        Args:
            private_key: Hex private key with or without 0x prefix.
            rpc_url: Ethereum RPC endpoint URL.

        """
        # Normalize private key format
        if not private_key.startswith("0x"):
            private_key = "0x" + private_key

        self._account = Account.from_key(private_key)
        self._w3 = Web3(Web3.HTTPProvider(rpc_url))

        # Add PoA middleware for testnets (Base, Polygon, etc.)
        self._w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)

        # Cache chain ID
        self._chain_id: int | None = None

    @property
    def address(self) -> str:
        """The signer's Ethereum address (checksummed)."""
        return self._account.address

    def get_addresses(self) -> list[str]:
        """Get all addresses this facilitator can use.

        Returns:
            List containing the single facilitator address.
        """
        return [self._account.address]

    def get_chain_id(self) -> int:
        """Get connected network's chain ID.

        Returns:
            Chain ID.
        """
        if self._chain_id is None:
            self._chain_id = self._w3.eth.chain_id
        return self._chain_id

    def read_contract(
        self,
        address: str,
        abi: list[dict[str, Any]],
        function_name: str,
        *args: Any,
    ) -> Any:
        """Read data from a smart contract.

        Args:
            address: Contract address.
            abi: Contract ABI.
            function_name: Function to call.
            *args: Function arguments.

        Returns:
            Function return value.
        """
        contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(address),
            abi=abi,
        )
        func = getattr(contract.functions, function_name)
        return func(*args).call({"from": Web3.to_checksum_address(self._account.address)})

    def verify_typed_data(
        self,
        address: str,
        domain: TypedDataDomain,
        types: dict[str, list[TypedDataField]],
        primary_type: str,
        message: dict[str, Any],
        signature: bytes,
    ) -> bool:
        """Verify an EIP-712 signature.

        Supports both EOA signatures and EIP-1271 smart wallet signatures.

        Args:
            address: Expected signer address.
            domain: EIP-712 domain separator.
            types: Type definitions.
            primary_type: Primary type name.
            message: Message data.
            signature: Signature bytes.

        Returns:
            True if signature is valid.
        """
        # Build domain dict — handle both TypedDataDomain and raw dict (Permit2 has no version)
        if isinstance(domain, dict):
            domain_dict = domain
        else:
            domain_dict = {
                "name": domain.name,
                "chainId": domain.chain_id,
                "verifyingContract": domain.verifying_contract,
            }
            if domain.version:
                domain_dict["version"] = domain.version

        # Derive EIP712Domain type from actual domain keys
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
                {"name": f.name, "type": f.type} if isinstance(f, TypedDataField) else f
                for f in fields
            ]

        # Handle bytes32 nonce - convert to hex string for eth_account
        msg_copy = message.copy()
        if "nonce" in msg_copy and isinstance(msg_copy["nonce"], bytes):
            msg_copy["nonce"] = "0x" + msg_copy["nonce"].hex()

        try:
            typed_data = {
                "types": full_types,
                "primaryType": primary_type,
                "domain": domain_dict,
                "message": msg_copy,
            }

            logger.info(
                "verify_typed_data: primaryType=%s domain_keys=%s type_names=%s",
                primary_type,
                list(domain_dict.keys()),
                list(full_types.keys()),
            )
            logger.debug("verify_typed_data: full typed_data=%s", typed_data)

            # Try EOA signature verification first
            signable = encode_typed_data(full_message=typed_data)
            recovered = Account.recover_message(signable, signature=signature)

            logger.info(
                "verify_typed_data: expected=%s recovered=%s match=%s",
                address.lower(),
                recovered.lower(),
                recovered.lower() == address.lower(),
            )

            if recovered.lower() == address.lower():
                return True

            # If EOA verification failed, try EIP-1271 for smart contract wallets
            code = self._w3.eth.get_code(Web3.to_checksum_address(address))
            if len(code) > 0:
                # It's a contract, try EIP-1271
                from eth_account._utils.typed_data import hash_typed_data

                struct_hash = hash_typed_data(typed_data)
                contract = self._w3.eth.contract(
                    address=Web3.to_checksum_address(address),
                    abi=IS_VALID_SIGNATURE_ABI,
                )
                try:
                    result = contract.functions.isValidSignature(
                        struct_hash,
                        signature,
                    ).call()
                    return result == EIP1271_MAGIC_VALUE
                except Exception:
                    return False

            return False

        except Exception as e:
            logger.error("Signature verification error: %s", e, exc_info=True)
            return False

    def write_contract(
        self,
        address: str,
        abi: list[dict[str, Any]],
        function_name: str,
        *args: Any,
    ) -> str:
        """Execute a smart contract transaction.

        Args:
            address: Contract address.
            abi: Contract ABI.
            function_name: Function to call.
            *args: Function arguments.

        Returns:
            Transaction hash.
        """
        contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(address),
            abi=abi,
        )
        func = getattr(contract.functions, function_name)

        # Build transaction
        tx = func(*args).build_transaction(
            {
                "from": self._account.address,
                "nonce": self._w3.eth.get_transaction_count(self._account.address),
                "gas": 300000,
                "gasPrice": self._w3.eth.gas_price,
            }
        )

        # Sign and send
        signed_tx = self._account.sign_transaction(tx)
        tx_hash = self._w3.eth.send_raw_transaction(signed_tx.raw_transaction)

        return tx_hash.hex()

    def send_transaction(self, to: str, data: bytes) -> str:
        """Send a raw transaction.

        Args:
            to: Recipient address.
            data: Transaction data.

        Returns:
            Transaction hash.
        """
        tx = {
            "from": self._account.address,
            "to": Web3.to_checksum_address(to),
            "data": data,
            "nonce": self._w3.eth.get_transaction_count(self._account.address),
            "gas": 300000,
            "gasPrice": self._w3.eth.gas_price,
        }

        signed_tx = self._account.sign_transaction(tx)
        tx_hash = self._w3.eth.send_raw_transaction(signed_tx.raw_transaction)

        return tx_hash.hex()

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        """Wait for a transaction to be mined.

        Args:
            tx_hash: Transaction hash to wait for.

        Returns:
            Transaction receipt.
        """
        if not tx_hash.startswith("0x"):
            tx_hash = "0x" + tx_hash

        receipt = self._w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

        return TransactionReceipt(
            status=TX_STATUS_SUCCESS if receipt["status"] == 1 else 0,
            block_number=receipt["blockNumber"],
            tx_hash=tx_hash,
        )

    def get_balance(self, address: str, token_address: str) -> int:
        """Get token balance for address.

        Args:
            address: Account address.
            token_address: Token contract address (or zero address for native).

        Returns:
            Balance in smallest unit.
        """
        # Native balance
        if not token_address or token_address == "0x0000000000000000000000000000000000000000":
            return self._w3.eth.get_balance(Web3.to_checksum_address(address))

        # ERC20 balance
        contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(token_address),
            abi=_ERC20_BALANCE_ABI,
        )
        return contract.functions.balanceOf(Web3.to_checksum_address(address)).call()

    def get_code(self, address: str) -> bytes:
        """Get bytecode at address.

        Args:
            address: Address to check.

        Returns:
            Bytecode (empty bytes if EOA).
        """
        return bytes(self._w3.eth.get_code(Web3.to_checksum_address(address)))
