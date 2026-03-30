"""EVM signer protocol definitions."""

from typing import Any, Protocol, runtime_checkable

from .types import TransactionReceipt, TypedDataDomain, TypedDataField


class ClientEvmSigner(Protocol):
    """Client-side EVM signer for payment authorizations.

    Implement this protocol to integrate with your wallet provider
    (e.g., web3.py Account, eth-account, hardware wallet SDK).
    """

    @property
    def address(self) -> str:
        """The signer's Ethereum address (checksummed).

        Returns:
            Checksummed Ethereum address (0x...).
        """
        ...

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
            types: Type definitions.
            primary_type: Primary type name.
            message: Message data.

        Returns:
            65-byte ECDSA signature (r, s, v) or longer for smart wallets.
        """
        ...


class FacilitatorEvmSigner(Protocol):
    """Facilitator-side EVM signer for verification and settlement.

    Implement this protocol to integrate with your blockchain provider
    (e.g., web3.py, viem via adapter).
    """

    def get_addresses(self) -> list[str]:
        """Get all addresses this facilitator can use.

        Enables dynamic address selection for load balancing and key rotation.

        Returns:
            List of checksummed Ethereum addresses.
        """
        ...

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
        ...

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
        ...

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
        ...

    def send_transaction(self, to: str, data: bytes) -> str:
        """Send raw transaction.

        Args:
            to: Recipient address.
            data: Transaction data.

        Returns:
            Transaction hash.
        """
        ...

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        """Wait for transaction to be mined.

        Args:
            tx_hash: Transaction hash to wait for.

        Returns:
            Transaction receipt.
        """
        ...

    def get_balance(self, address: str, token_address: str) -> int:
        """Get token balance for address.

        Args:
            address: Account address.
            token_address: Token contract address.

        Returns:
            Balance in smallest unit.
        """
        ...

    def get_chain_id(self) -> int:
        """Get connected network's chain ID.

        Returns:
            Chain ID.
        """
        ...

    def get_code(self, address: str) -> bytes:
        """Get bytecode at address.

        Args:
            address: Address to check.

        Returns:
            Bytecode (empty if EOA).
        """
        ...


@runtime_checkable
class ClientEvmSignerWithReadContract(Protocol):
    """Extension of ClientEvmSigner that adds on-chain read capability.

    Required for EIP-2612 gas sponsoring (needs to read nonces from token).
    """

    @property
    def address(self) -> str: ...

    def sign_typed_data(
        self,
        domain: TypedDataDomain,
        types: dict[str, list[TypedDataField]],
        primary_type: str,
        message: dict[str, Any],
    ) -> bytes: ...

    def read_contract(
        self,
        address: str,
        abi: list[dict[str, Any]],
        function_name: str,
        *args: Any,
    ) -> Any:
        """Read data from a smart contract."""
        ...


@runtime_checkable
class ClientEvmSignerWithSignTransaction(Protocol):
    """Extension of ClientEvmSigner that adds raw transaction signing.

    Required for ERC-20 approval gas sponsoring (signs approve tx off-chain).
    """

    @property
    def address(self) -> str: ...

    def sign_typed_data(
        self,
        domain: TypedDataDomain,
        types: dict[str, list[TypedDataField]],
        primary_type: str,
        message: dict[str, Any],
    ) -> bytes: ...

    def sign_transaction(self, tx: dict[str, Any]) -> str:
        """Sign an EIP-1559 transaction and return the RLP-encoded hex string."""
        ...

    def get_transaction_count(self, address: str) -> int:
        """Get the pending nonce for an address."""
        ...
