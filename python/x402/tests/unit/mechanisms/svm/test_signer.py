"""Tests for SVM signer implementations."""

import base64

import pytest
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message, MessageV0, MessageV1, TransactionConfig, to_bytes_versioned
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import MEMO_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2
from x402.mechanisms.svm.signers import FacilitatorKeypairSigner, KeypairSigner

FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"


def build_transaction(
    version: int | str, fee_payer: Keypair, authority: Keypair | None = None
) -> VersionedTransaction:
    """Build a transaction of the given version with a memo instruction.

    Signature slot 0 is left as a placeholder for the facilitator to fill, which
    is the shape a payer submits. Any co-signer signs for real.

    Args:
        version: "legacy", 0 or 1.
        fee_payer: Keypair that pays fees and owns signature slot 0.
        authority: Optional co-signer occupying signature slot 1.

    Returns:
        The transaction, with slot 0 unsigned.
    """
    accounts = [] if authority is None else [AccountMeta(authority.pubkey(), True, False)]
    memo_ix = Instruction(Pubkey.from_string(MEMO_PROGRAM_ADDRESS), bytes([1]), accounts)
    blockhash = Hash.from_string(FIXED_BLOCKHASH)

    message: Message | MessageV0 | MessageV1
    if version == "legacy":
        message = Message.new_with_blockhash([memo_ix], fee_payer.pubkey(), blockhash)
    elif version == 0:
        message = MessageV0.try_compile(fee_payer.pubkey(), [memo_ix], [], blockhash)
    else:
        message = MessageV1.try_compile(
            fee_payer.pubkey(),
            [memo_ix],
            blockhash,
            TransactionConfig(compute_unit_limit=20_000, loaded_accounts_data_size_limit=65_536),
        )

    signatures = [Signature.default()]
    if authority is not None:
        signatures.append(authority.sign_message(to_bytes_versioned(message)))
    return VersionedTransaction.populate(message, signatures)


class TestKeypairSigner:
    """Test KeypairSigner client-side signer."""

    def test_should_create_signer_from_keypair(self):
        """Should create signer from keypair."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        assert signer.address is not None
        assert len(signer.address) >= 32  # Base58 address

    def test_address_should_return_base58_public_key(self):
        """address property should return base58 public key."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        assert signer.address == str(keypair.pubkey())

    def test_keypair_should_return_underlying_keypair(self):
        """keypair property should return the underlying keypair."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        assert signer.keypair is keypair

    def test_from_base58_should_create_signer_from_base58_key(self):
        """from_base58 should create signer from base58 encoded key."""
        keypair = Keypair()
        base58_key = str(keypair)

        signer = KeypairSigner.from_base58(base58_key)

        # Addresses should match
        assert signer.address == str(keypair.pubkey())

    def test_from_bytes_should_create_signer_from_bytes(self):
        """from_bytes should create signer from key bytes."""
        keypair = Keypair()
        key_bytes = bytes(keypair)

        signer = KeypairSigner.from_bytes(key_bytes)

        # Addresses should match
        assert signer.address == str(keypair.pubkey())


class TestFacilitatorKeypairSigner:
    """Test FacilitatorKeypairSigner facilitator-side signer."""

    def test_should_create_signer_with_single_keypair(self):
        """Should create signer with a single keypair."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        addresses = signer.get_addresses()
        assert len(addresses) == 1
        assert str(keypair.pubkey()) in addresses

    def test_should_create_signer_with_multiple_keypairs(self):
        """Should create signer with multiple keypairs."""
        keypair1 = Keypair()
        keypair2 = Keypair()
        signer = FacilitatorKeypairSigner([keypair1, keypair2])

        addresses = signer.get_addresses()
        assert len(addresses) == 2
        assert str(keypair1.pubkey()) in addresses
        assert str(keypair2.pubkey()) in addresses

    def test_get_addresses_should_return_all_fee_payer_addresses(self):
        """get_addresses should return all fee payer addresses."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        addresses = signer.get_addresses()

        assert isinstance(addresses, list)
        assert all(isinstance(addr, str) for addr in addresses)

    def test_sign_transaction_should_raise_for_unknown_fee_payer(self):
        """sign_transaction should raise error for unknown fee payer address."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        # Use a minimal valid base64 transaction (will fail actual signing but
        # should fail first on fee_payer check)
        tx_base64 = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAEDAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="

        with pytest.raises(ValueError, match="No signer for fee payer"):
            signer.sign_transaction(
                tx_base64, "UnknownAddress11111111111111111111", SOLANA_DEVNET_CAIP2
            )

    @pytest.mark.parametrize("version", ["legacy", 0, 1])
    def test_sign_transaction_signs_the_versioned_message(self, version):
        """The facilitator signature must verify against the message serialized
        behind its own version prefix, which is absent for legacy, 0x80 for
        version 0 and 0x81 for version 1."""
        fee_payer = Keypair()
        signer = FacilitatorKeypairSigner(fee_payer)
        tx = build_transaction(version, fee_payer)

        signed_base64 = signer.sign_transaction(
            base64.b64encode(bytes(tx)).decode(), str(fee_payer.pubkey()), SOLANA_DEVNET_CAIP2
        )

        signed = VersionedTransaction.from_bytes(base64.b64decode(signed_base64))
        message_bytes = to_bytes_versioned(signed.message)
        assert signed.signatures[0].verify(fee_payer.pubkey(), message_bytes)

    def test_sign_transaction_preserves_the_payer_signature_slot(self):
        """Only slot 0 is overwritten; a co-signer's signature must survive."""
        fee_payer = Keypair()
        authority = Keypair()
        signer = FacilitatorKeypairSigner(fee_payer)
        tx = build_transaction(0, fee_payer, authority)
        original = list(tx.signatures)

        signed_base64 = signer.sign_transaction(
            base64.b64encode(bytes(tx)).decode(), str(fee_payer.pubkey()), SOLANA_DEVNET_CAIP2
        )

        signed = VersionedTransaction.from_bytes(base64.b64decode(signed_base64))
        assert signed.signatures[0] != original[0]
        assert signed.signatures[1] == original[1]

    def test_from_base58_with_single_key(self):
        """from_base58 should create signer from single base58 key."""
        keypair = Keypair()
        base58_key = str(keypair)

        signer = FacilitatorKeypairSigner.from_base58(base58_key)

        addresses = signer.get_addresses()
        assert len(addresses) == 1
        assert str(keypair.pubkey()) in addresses

    def test_from_base58_with_multiple_keys(self):
        """from_base58 should create signer from multiple base58 keys."""
        keypair1 = Keypair()
        keypair2 = Keypair()
        keys = [str(keypair1), str(keypair2)]

        signer = FacilitatorKeypairSigner.from_base58(keys)

        addresses = signer.get_addresses()
        assert len(addresses) == 2

    def test_should_support_custom_rpc_url(self):
        """Should create signer with custom RPC URL."""
        keypair = Keypair()
        custom_rpc = "https://custom-rpc.com"

        signer = FacilitatorKeypairSigner(keypair, rpc_url=custom_rpc)

        # Signer should be created without error
        assert signer is not None
        assert len(signer.get_addresses()) == 1

    def test_should_work_with_devnet(self):
        """Should work with devnet network."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        # Verify signer operations are available
        assert signer.get_addresses is not None
        assert signer.sign_transaction is not None
        assert signer.simulate_transaction is not None
        assert signer.send_transaction is not None
        assert signer.confirm_transaction is not None

    def test_should_work_with_mainnet(self):
        """Should work with mainnet network."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        # Verify all required methods exist
        assert callable(signer.get_addresses)
        assert callable(signer.sign_transaction)
        assert callable(signer.simulate_transaction)
        assert callable(signer.send_transaction)
        assert callable(signer.confirm_transaction)


class TestSignerProtocols:
    """Test that signers implement expected protocols."""

    def test_keypair_signer_implements_client_protocol(self):
        """KeypairSigner should implement ClientSvmSigner protocol."""
        keypair = Keypair()
        signer = KeypairSigner(keypair)

        # ClientSvmSigner protocol requires:
        assert hasattr(signer, "address")
        assert hasattr(signer, "keypair")
        assert hasattr(signer, "sign_transaction")

    def test_facilitator_signer_implements_facilitator_protocol(self):
        """FacilitatorKeypairSigner should implement FacilitatorSvmSigner protocol."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        # FacilitatorSvmSigner protocol requires:
        assert hasattr(signer, "get_addresses")
        assert hasattr(signer, "sign_transaction")
        assert hasattr(signer, "simulate_transaction")
        assert hasattr(signer, "send_transaction")
        assert hasattr(signer, "confirm_transaction")
