"""Concrete SVM signer implementations."""

import base64
import time

try:
    from solders.keypair import Keypair
    from solders.message import to_bytes_versioned
    from solders.signature import Signature
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from .rpc import CONFIRMED, SvmRpcClient
from .utils import get_network_config, normalize_network


class KeypairSigner:
    """Client-side signer using a Solana keypair.

    Example:
        ```python
        from solders.keypair import Keypair

        keypair = Keypair.from_base58_string(private_key)
        signer = KeypairSigner(keypair)
        ```
    """

    def __init__(self, keypair: Keypair):
        """Create KeypairSigner.

        Args:
            keypair: Solders Keypair instance.
        """
        self._keypair = keypair

    @property
    def address(self) -> str:
        """Get signer's address.

        Returns:
            Base58 encoded public key.
        """
        return str(self._keypair.pubkey())

    @property
    def keypair(self) -> Keypair:
        """Get underlying keypair.

        Returns:
            Solders Keypair instance.
        """
        return self._keypair

    def sign_transaction(self, tx: VersionedTransaction) -> VersionedTransaction:
        """Sign a transaction.

        Args:
            tx: The transaction to sign.

        Returns:
            Signed transaction.
        """
        tx.sign([self._keypair])
        return tx

    @classmethod
    def from_base58(cls, private_key: str) -> "KeypairSigner":
        """Create signer from base58 encoded private key.

        Args:
            private_key: Base58 encoded private key (64 bytes).

        Returns:
            KeypairSigner instance.
        """
        keypair = Keypair.from_base58_string(private_key)
        return cls(keypair)

    @classmethod
    def from_bytes(cls, private_key: bytes) -> "KeypairSigner":
        """Create signer from private key bytes.

        Args:
            private_key: Private key bytes (64 bytes).

        Returns:
            KeypairSigner instance.
        """
        keypair = Keypair.from_bytes(private_key)
        return cls(keypair)


class FacilitatorKeypairSigner:
    """Facilitator-side signer using Solana keypair(s).

    Supports multiple keypairs for load balancing and key rotation.

    Example:
        ```python
        keypair = Keypair.from_base58_string(private_key)
        signer = FacilitatorKeypairSigner(keypair)

        # Or with multiple keypairs
        signer = FacilitatorKeypairSigner([keypair1, keypair2])
        ```
    """

    def __init__(
        self,
        keypairs: Keypair | list[Keypair],
        rpc_url: str | None = None,
    ):
        """Create FacilitatorKeypairSigner.

        Args:
            keypairs: Single keypair or list of keypairs.
            rpc_url: Optional custom RPC URL. If not provided, uses network-specific default.
        """
        if isinstance(keypairs, Keypair):
            keypairs = [keypairs]
        self._keypairs = {str(kp.pubkey()): kp for kp in keypairs}
        self._custom_rpc_url = rpc_url
        self._clients: dict[str, SvmRpcClient] = {}

    def _get_client(self, network: str) -> SvmRpcClient:
        """Get or create RPC client for network.

        Args:
            network: CAIP-2 network identifier.

        Returns:
            Solana RPC client.
        """
        caip2_network = normalize_network(network)

        if caip2_network in self._clients:
            return self._clients[caip2_network]

        if self._custom_rpc_url:
            rpc_url = self._custom_rpc_url
        else:
            rpc_url = get_network_config(network)["rpc_url"]

        client = SvmRpcClient(rpc_url)
        self._clients[caip2_network] = client
        return client

    def get_addresses(self) -> list[str]:
        """Get all fee payer addresses.

        Returns:
            List of base58 encoded public keys.
        """
        return list(self._keypairs.keys())

    def sign_transaction(
        self,
        tx_base64: str,
        fee_payer: str,
        network: str,
    ) -> str:
        """Sign a partially-signed transaction.

        Args:
            tx_base64: Base64 encoded partially-signed transaction.
            fee_payer: Fee payer address.
            network: CAIP-2 network identifier.

        Returns:
            Base64 encoded fully-signed transaction.

        Raises:
            ValueError: If no signer for fee_payer.
        """
        if fee_payer not in self._keypairs:
            available = ", ".join(self._keypairs.keys())
            raise ValueError(f"No signer for fee payer {fee_payer}. Available: {available}")

        keypair = self._keypairs[fee_payer]

        # Decode transaction
        tx_bytes = base64.b64decode(tx_base64)
        tx = VersionedTransaction.from_bytes(tx_bytes)

        # What every signer commits to is the message behind its version prefix:
        # absent for legacy, 0x80 for version 0, 0x81 for version 1. Serializing
        # through to_bytes_versioned applies the right one for the message at
        # hand, so the signature verifies whatever version the payer built.
        message = tx.message
        facilitator_signature = keypair.sign_message(to_bytes_versioned(message))

        # Fee payer is always at index 0, client signature at index 1
        signatures = list(tx.signatures)
        signatures[0] = facilitator_signature
        signed_tx = VersionedTransaction.populate(message, signatures)

        # Re-encode
        return base64.b64encode(bytes(signed_tx)).decode("utf-8")

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        """Simulate a transaction.

        Args:
            tx_base64: Base64 encoded signed transaction.
            network: CAIP-2 network identifier.

        Raises:
            RuntimeError: If simulation fails.
        """
        client = self._get_client(network)

        # Decode transaction
        tx_bytes = base64.b64decode(tx_base64)
        tx = VersionedTransaction.from_bytes(tx_bytes)

        # Simulate with explicit signature verification
        result = client.simulate_transaction(tx, sig_verify=True, commitment=CONFIRMED)

        if result.value.err:
            raise RuntimeError(f"Simulation failed: {result.value.err}")

    def send_transaction(self, tx_base64: str, network: str) -> str:
        """Send a transaction.

        Args:
            tx_base64: Base64 encoded signed transaction.
            network: CAIP-2 network identifier.

        Returns:
            Transaction signature.

        Raises:
            RuntimeError: If send fails.
        """
        client = self._get_client(network)

        # Decode transaction from base64
        tx_bytes = base64.b64decode(tx_base64)

        # Preflight is skipped because verify() already simulated this transaction.
        result = client.send_raw_transaction(
            tx_bytes, skip_preflight=True, preflight_commitment=CONFIRMED
        )

        return str(result.value)

    def confirm_transaction(
        self,
        signature: str,
        network: str,
        timeout_seconds: int = 30,
    ) -> None:
        """Wait for transaction confirmation.

        Args:
            signature: Transaction signature.
            network: CAIP-2 network identifier.
            timeout_seconds: Maximum time to wait.

        Raises:
            RuntimeError: If confirmation fails or times out.
        """
        from solders.transaction_status import TransactionConfirmationStatus

        client = self._get_client(network)
        sig = Signature.from_string(signature)

        start_time = time.time()
        while time.time() - start_time < timeout_seconds:
            result = client.get_signature_statuses([sig])

            if result.value and result.value[0]:
                status = result.value[0]
                # confirmation_status is an enum, compare properly
                if status.confirmation_status in [
                    TransactionConfirmationStatus.Confirmed,
                    TransactionConfirmationStatus.Finalized,
                ]:
                    return
                if status.err:
                    raise RuntimeError(f"Transaction failed: {status.err}")

            time.sleep(1)

        raise RuntimeError("Transaction confirmation timeout")

    @classmethod
    def from_base58(
        cls,
        private_keys: str | list[str],
        rpc_url: str | None = None,
    ) -> "FacilitatorKeypairSigner":
        """Create signer from base58 encoded private key(s).

        Args:
            private_keys: Single or list of base58 encoded private keys.
            rpc_url: Optional custom RPC URL.

        Returns:
            FacilitatorKeypairSigner instance.
        """
        if isinstance(private_keys, str):
            private_keys = [private_keys]

        keypairs = [Keypair.from_base58_string(pk) for pk in private_keys]
        return cls(keypairs, rpc_url)
