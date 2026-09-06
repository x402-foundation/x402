"""SVM signer protocol definitions."""

from typing import Protocol

try:
    from solders.keypair import Keypair
    from solders.transaction import VersionedTransaction
except ImportError as e:
    raise ImportError(
        "SVM mechanism requires solana packages. Install with: pip install x402[svm]"
    ) from e


class ClientSvmSigner(Protocol):
    """Client-side SVM signer for payment transactions.

    Implement this protocol to integrate with your Solana wallet provider.
    The signer must be able to sign transactions as the token authority.
    """

    @property
    def address(self) -> str:
        """The signer's Solana address (base58 encoded).

        Returns:
            Base58 encoded public key.
        """
        ...

    @property
    def keypair(self) -> Keypair:
        """The underlying keypair for signing.

        Returns:
            Solders Keypair instance.
        """
        ...

    def sign_transaction(self, tx: VersionedTransaction) -> VersionedTransaction:
        """Sign a transaction.

        Args:
            tx: The transaction to sign.

        Returns:
            Signed transaction.
        """
        ...


class FacilitatorSvmSigner(Protocol):
    """Facilitator-side SVM signer for verification and settlement.

    Implement this protocol to integrate with your Solana infrastructure.
    The facilitator pays transaction fees and submits transactions.
    """

    def get_addresses(self) -> list[str]:
        """Get all addresses this facilitator can use as fee payers.

        Enables dynamic address selection for load balancing and key rotation.

        Returns:
            List of base58 encoded public keys.
        """
        ...

    def sign_transaction(
        self,
        tx_base64: str,
        fee_payer: str,
        network: str,
    ) -> str:
        """Sign a partially-signed transaction with the signer matching fee_payer.

        Transaction is decoded, signed, and re-encoded internally.

        Args:
            tx_base64: Base64 encoded partially-signed transaction.
            fee_payer: Fee payer address (determines which signer to use).
            network: CAIP-2 network identifier.

        Returns:
            Base64 encoded fully-signed transaction.

        Raises:
            ValueError: If no signer exists for fee_payer.
        """
        ...

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        """Simulate a signed transaction to verify it would succeed.

        Args:
            tx_base64: Base64 encoded signed transaction.
            network: CAIP-2 network identifier.

        Raises:
            RuntimeError: If simulation fails.
        """
        ...

    def send_transaction(self, tx_base64: str, network: str) -> str:
        """Send a signed transaction to the network.

        Args:
            tx_base64: Base64 encoded signed transaction.
            network: CAIP-2 network identifier.

        Returns:
            Transaction signature (base58 encoded).

        Raises:
            RuntimeError: If send fails.
        """
        ...

    def confirm_transaction(self, signature: str, network: str) -> None:
        """Wait for transaction confirmation.

        Args:
            signature: Transaction signature to confirm.
            network: CAIP-2 network identifier.

        Raises:
            RuntimeError: If confirmation fails or times out.
        """
        ...
