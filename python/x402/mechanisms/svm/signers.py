"""Concrete SVM signer implementations."""

import base64
import time

try:
    from solana.rpc.api import Client as SolanaClient
    from solana.rpc.commitment import Confirmed
    from solana.rpc.types import TxOpts
    from solders.keypair import Keypair
    from solders.signature import Signature
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e

from .constants import NETWORK_CONFIGS
from .utils import normalize_network


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
        self._clients: dict[str, SolanaClient] = {}

    def _get_client(self, network: str) -> SolanaClient:
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
            config = NETWORK_CONFIGS.get(caip2_network)
            if not config:
                raise ValueError(f"Unsupported network: {network}")
            rpc_url = config["rpc_url"]

        client = SolanaClient(rpc_url)
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

        Supports both legacy and versioned (v0) transactions:
        - Legacy transactions: Sign message bytes directly
        - Versioned (v0) transactions: Sign with 0x80 version prefix

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

        # Determine if this is a versioned (v0) or legacy transaction
        # Versioned transactions have a version byte prefix >= 128 (0x80)
        # Legacy transactions have their first byte (numRequiredSignatures) < 128
        is_versioned = self._is_versioned_transaction(tx_bytes)

        message = tx.message
        if is_versioned:
            # Versioned transaction (MessageV0): prepend 0x80 version byte before signing
            msg_bytes_with_version = bytes([0x80]) + bytes(message)
            facilitator_signature = keypair.sign_message(msg_bytes_with_version)
        else:
            # Legacy transaction: sign message bytes directly (no version prefix)
            facilitator_signature = keypair.sign_message(bytes(message))

        # Fee payer is always at index 0, client signature at index 1
        signatures = list(tx.signatures)
        signatures[0] = facilitator_signature
        signed_tx = VersionedTransaction.populate(message, signatures)

        # Re-encode
        return base64.b64encode(bytes(signed_tx)).decode("utf-8")

    def _is_versioned_transaction(self, tx_bytes: bytes) -> bool:
        """Determine if transaction bytes represent a versioned or legacy transaction.

        Versioned transactions (v0) have a version byte prefix where the first byte
        of the message portion is >= 128 (0x80). Legacy transactions have their
        first message byte (numRequiredSignatures header) < 128.

        Args:
            tx_bytes: Raw transaction bytes.

        Returns:
            True if versioned (v0), False if legacy.
        """
        # Transaction structure:
        # - CompactU16 length prefix for signatures count
        # - Signatures (64 bytes each)
        # - Message bytes
        #
        # To find where the message starts, we need to skip the signatures.
        # CompactU16: if first byte < 128, it's the value; otherwise it's multi-byte

        offset = 0

        # Read compact u16 for signature count
        first_byte = tx_bytes[offset]
        if first_byte < 0x80:
            # Single byte encoding
            num_signatures = first_byte
            offset += 1
        else:
            # Multi-byte encoding (shouldn't happen for reasonable signature counts)
            num_signatures = (first_byte & 0x7F) | ((tx_bytes[offset + 1] & 0x7F) << 7)
            offset += 2

        # Skip signatures (64 bytes each)
        offset += num_signatures * 64

        # First byte of message determines version
        # >= 128 (0x80) means versioned (v0), < 128 means legacy
        if offset < len(tx_bytes):
            message_first_byte = tx_bytes[offset]
            return message_first_byte >= 0x80

        return False

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
        result = client.simulate_transaction(tx, sig_verify=True, commitment=Confirmed)

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

        # Use send_raw_transaction with skip_preflight option
        # This bypasses preflight checks since transaction was already simulated during verify()
        tx_opts = TxOpts(skip_preflight=True, preflight_commitment=Confirmed)
        result = client.send_raw_transaction(tx_bytes, opts=tx_opts)

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
