"""Tests for SVM signer implementations."""

import base64
from unittest.mock import MagicMock, patch

import pytest
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message, MessageV0, MessageV1, TransactionConfig, to_bytes_versioned
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import MEMO_PROGRAM_ADDRESS, SOLANA_DEVNET_CAIP2
from x402.mechanisms.svm.rpc import CONFIRMED
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

    @pytest.mark.parametrize("version", ["legacy", 0, 1])
    def test_sign_transaction_signs_behind_the_version_prefix(self, version):
        """The fee-payer signature must verify for legacy, version 0 and version 1."""
        fee_payer = Keypair()
        client = Keypair()
        signer = FacilitatorKeypairSigner(fee_payer)
        memo_ix = Instruction(
            Pubkey.from_string(MEMO_PROGRAM_ADDRESS),
            b"x402",
            [AccountMeta(client.pubkey(), is_signer=True, is_writable=False)],
        )
        blockhash = Hash.new_unique()
        if version == "legacy":
            message = Message.new_with_blockhash([memo_ix], fee_payer.pubkey(), blockhash)
        elif version == 0:
            message = MessageV0.try_compile(fee_payer.pubkey(), [memo_ix], [], blockhash)
        else:
            message = MessageV1.try_compile(
                fee_payer.pubkey(),
                [memo_ix],
                blockhash,
                TransactionConfig(compute_unit_limit=1_000, loaded_accounts_data_size_limit=1),
            )
        client_signature = client.sign_message(to_bytes_versioned(message))
        partial = VersionedTransaction.populate(message, [Signature.default(), client_signature])

        signed_b64 = signer.sign_transaction(
            base64.b64encode(bytes(partial)).decode(), str(fee_payer.pubkey()), SOLANA_DEVNET_CAIP2
        )

        signed = VersionedTransaction.from_bytes(base64.b64decode(signed_b64))
        signed_bytes = to_bytes_versioned(signed.message)
        assert signed.signatures[0].verify(fee_payer.pubkey(), signed_bytes)
        assert signed.signatures[1].verify(client.pubkey(), signed_bytes)
        signed.verify_with_results()

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

    def test_get_account_info_returns_none_when_account_is_missing(self):
        signer = FacilitatorKeypairSigner(Keypair())
        address = str(Keypair().pubkey())
        client = MagicMock()
        client.get_account_info.return_value = MagicMock(value=None)

        with patch.object(signer, "_get_client", return_value=client) as get_client:
            assert signer.get_account_info(address, SOLANA_DEVNET_CAIP2) is None

        get_client.assert_called_once_with(SOLANA_DEVNET_CAIP2)
        client.get_account_info.assert_called_once_with(
            Pubkey.from_string(address),
            commitment=CONFIRMED,
        )

    def test_get_account_info_returns_owner_base58(self):
        signer = FacilitatorKeypairSigner(Keypair())
        address = str(Keypair().pubkey())
        owner = Keypair().pubkey()
        account = MagicMock()
        account.owner = owner
        client = MagicMock()
        client.get_account_info.return_value = MagicMock(value=account)

        with patch.object(signer, "_get_client", return_value=client) as get_client:
            assert signer.get_account_info(address, SOLANA_DEVNET_CAIP2) == str(owner)

        get_client.assert_called_once_with(SOLANA_DEVNET_CAIP2)
        client.get_account_info.assert_called_once_with(
            Pubkey.from_string(address),
            commitment=CONFIRMED,
        )

    def test_get_account_info_propagates_rpc_errors(self):
        signer = FacilitatorKeypairSigner(Keypair())
        address = str(Keypair().pubkey())
        client = MagicMock()
        client.get_account_info.side_effect = RuntimeError("rpc unavailable")

        with (
            patch.object(signer, "_get_client", return_value=client) as get_client,
            pytest.raises(RuntimeError, match="rpc unavailable"),
        ):
            signer.get_account_info(address, SOLANA_DEVNET_CAIP2)

        get_client.assert_called_once_with(SOLANA_DEVNET_CAIP2)
        client.get_account_info.assert_called_once_with(
            Pubkey.from_string(address),
            commitment=CONFIRMED,
        )


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
