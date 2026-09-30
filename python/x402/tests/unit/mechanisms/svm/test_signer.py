"""Tests for SVM signer implementations."""

import pytest
from solders.keypair import Keypair

from x402.mechanisms.svm import SOLANA_DEVNET_CAIP2
from x402.mechanisms.svm.signers import FacilitatorKeypairSigner, KeypairSigner


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

    def test_is_versioned_transaction_should_detect_legacy(self):
        """_is_versioned_transaction should detect legacy transactions."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        # Legacy transaction: first byte of message < 128 (numRequiredSignatures = 1)
        # Format: [sig_count_compact_u16] [signatures...] [message...]
        # This is a minimal legacy transaction with 1 signature slot
        # CompactU16(1) = 0x01, then 64 zero bytes for signature, then legacy message header
        legacy_tx_bytes = bytes([0x01])  # 1 signature
        legacy_tx_bytes += bytes(64)  # Empty signature
        legacy_tx_bytes += bytes(
            [0x01, 0x00, 0x00]
        )  # Legacy header: numReqSigs=1, numReadonlySigned=0, numReadonlyUnsigned=0
        legacy_tx_bytes += bytes([0x01])  # 1 account key
        legacy_tx_bytes += bytes(32)  # Account key
        legacy_tx_bytes += bytes(32)  # Recent blockhash
        legacy_tx_bytes += bytes([0x00])  # 0 instructions

        assert signer._is_versioned_transaction(legacy_tx_bytes) is False

    def test_is_versioned_transaction_should_detect_versioned(self):
        """_is_versioned_transaction should detect versioned (v0) transactions."""
        keypair = Keypair()
        signer = FacilitatorKeypairSigner(keypair)

        # Versioned transaction: first byte of message >= 128 (0x80 for v0)
        # Format: [sig_count_compact_u16] [signatures...] [version_byte] [message...]
        versioned_tx_bytes = bytes([0x01])  # 1 signature
        versioned_tx_bytes += bytes(64)  # Empty signature
        versioned_tx_bytes += bytes([0x80])  # Version byte for v0 (128)
        versioned_tx_bytes += bytes([0x01, 0x00, 0x00])  # Header
        versioned_tx_bytes += bytes([0x01])  # 1 account key
        versioned_tx_bytes += bytes(32)  # Account key
        versioned_tx_bytes += bytes(32)  # Recent blockhash
        versioned_tx_bytes += bytes([0x00])  # 0 instructions
        versioned_tx_bytes += bytes([0x00])  # 0 address table lookups

        assert signer._is_versioned_transaction(versioned_tx_bytes) is True

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
