"""SVM-specific payload and data types."""

from dataclasses import dataclass
from typing import Any


@dataclass
class ExactSvmPayload:
    """Exact payment payload for SVM networks.

    Contains a base64 encoded Solana transaction that includes:
    - Compute budget instructions
    - SPL Token TransferChecked instruction
    """

    transaction: str  # Base64 encoded Solana transaction

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for JSON serialization.

        Returns:
            Dict with transaction field.
        """
        return {"transaction": self.transaction}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExactSvmPayload":
        """Create from dictionary.

        Args:
            data: Dict with transaction field.

        Returns:
            ExactSvmPayload instance.
        """
        return cls(transaction=data.get("transaction", ""))


# Type aliases for V1/V2 compatibility
ExactSvmPayloadV1 = ExactSvmPayload
ExactSvmPayloadV2 = ExactSvmPayload


@dataclass
class TransactionInfo:
    """Information extracted from a parsed Solana transaction."""

    fee_payer: str  # Base58 encoded fee payer address
    payer: str  # Base58 encoded token payer (authority) address
    source_ata: str  # Source associated token account
    destination_ata: str  # Destination associated token account
    mint: str  # Token mint address
    amount: int  # Transfer amount in smallest unit
    decimals: int  # Token decimals
    token_program: str  # Token program address (Token or Token-2022)
