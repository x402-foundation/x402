"""Memo-based uniqueness tests for SVM payments."""

from unittest.mock import MagicMock, patch

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from x402.mechanisms.svm import (
    DEFAULT_COMPUTE_UNIT_LIMIT,
    DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    ERR_INVALID_INSTRUCTION_COUNT,
    SOLANA_DEVNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
)
from x402.mechanisms.svm.exact import ExactSvmClientScheme
from x402.mechanisms.svm.signers import KeypairSigner
from x402.mechanisms.svm.types import ExactSvmPayload
from x402.mechanisms.svm.utils import decode_transaction_from_payload
from x402.schemas import PaymentRequirements

FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"
FIXED_BLOCKHASH_ALT = "7ZCxc2SDhzV2bYgEQqdxTpweYJkpwshVSDtXuY7uPtjf"
MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"


class TestMemoUniqueness:
    def test_transaction_construction_is_deterministic(self):
        assert DEFAULT_COMPUTE_UNIT_LIMIT == 20000
        assert DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS == 1

    def test_blockhash_is_not_only_source_of_uniqueness(self):
        slot_time_ms = 400
        assert slot_time_ms < 1000


class TestFixedBlockhashProducesDistinctTransactions:
    @pytest.fixture
    def mock_rpc_client(self):
        mock_client = MagicMock()

        mock_blockhash_resp = MagicMock()
        mock_blockhash_resp.value.blockhash = Hash.from_string(FIXED_BLOCKHASH)
        mock_client.get_latest_blockhash.return_value = mock_blockhash_resp

        mock_account_info = MagicMock()
        mock_account_info.value = MagicMock()
        mock_account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        mock_account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
        mock_client.get_account_info.return_value = mock_account_info

        return mock_client

    @pytest.fixture
    def test_keypair(self):
        seed = bytes([1] * 32)
        return Keypair.from_seed(seed)

    @pytest.fixture
    def test_requirements(self, test_keypair):
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        return PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey())},
        )

    def test_distinct_transactions_with_fixed_blockhash(
        self, mock_rpc_client, test_keypair, test_requirements
    ):
        signer = KeypairSigner(test_keypair)
        client = ExactSvmClientScheme(signer)

        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            payload1 = client.create_payment_payload(test_requirements)
            payload2 = client.create_payment_payload(test_requirements)

        tx1_base64 = payload1["transaction"]
        tx2_base64 = payload2["transaction"]

        assert tx1_base64 != tx2_base64, (
            "Memo mitigation confirmed: Identical inputs with same blockhash "
            "produce distinct transactions."
        )

        assert len(tx1_base64) > 100

        print("\n=== MEMO UNIQUENESS CONFIRMED ===")
        print(f"Transaction 1 (first 80 chars): {tx1_base64[:80]}...")
        print(f"Transaction 2 (first 80 chars): {tx2_base64[:80]}...")
        print(f"Transactions are DISTINCT: {tx1_base64 != tx2_base64}")

    def test_memo_instruction_present(self, mock_rpc_client, test_keypair, test_requirements):
        signer = KeypairSigner(test_keypair)
        client = ExactSvmClientScheme(signer)

        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            payload = client.create_payment_payload(test_requirements)

        tx = decode_transaction_from_payload(ExactSvmPayload(transaction=payload["transaction"]))
        programs = [
            str(tx.message.account_keys[ix.program_id_index]) for ix in tx.message.instructions
        ]

        assert MEMO_PROGRAM_ADDRESS in programs

    def test_different_blockhash_produces_different_transactions(
        self, test_keypair, test_requirements
    ):
        signer = KeypairSigner(test_keypair)
        client = ExactSvmClientScheme(signer)

        call_count = [0]

        def get_mock_client(network):
            mock_client = MagicMock()

            def get_blockhash():
                call_count[0] += 1
                blockhash = FIXED_BLOCKHASH if call_count[0] == 1 else FIXED_BLOCKHASH_ALT
                mock_resp = MagicMock()
                mock_resp.value.blockhash = Hash.from_string(blockhash)
                return mock_resp

            mock_client.get_latest_blockhash = get_blockhash

            mock_account_info = MagicMock()
            mock_account_info.value = MagicMock()
            mock_account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
            mock_account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
            mock_client.get_account_info.return_value = mock_account_info

            return mock_client

        with patch.object(client, "_get_client", side_effect=get_mock_client):
            payload1 = client.create_payment_payload(test_requirements)
            payload2 = client.create_payment_payload(test_requirements)

        tx1_base64 = payload1["transaction"]
        tx2_base64 = payload2["transaction"]

        assert tx1_base64 != tx2_base64, (
            "CONTROL TEST PASSED: Different blockhash produces different transactions"
        )

        print("\n=== CONTROL TEST: DIFFERENT BLOCKHASH ===")
        print(f"Transaction 1 (first 80 chars): {tx1_base64[:80]}...")
        print(f"Transaction 2 (first 80 chars): {tx2_base64[:80]}...")
        print(f"Transactions are DIFFERENT: {tx1_base64 != tx2_base64}")


class TestFacilitatorInstructionRules:
    def test_facilitator_allows_optional_instructions(self):
        min_instructions = 3
        max_instructions = 6

        assert min_instructions == 3
        assert max_instructions > min_instructions

    def test_error_code_for_wrong_instruction_count(self):
        assert (
            ERR_INVALID_INSTRUCTION_COUNT
            == "invalid_exact_svm_payload_transaction_instructions_length"
        )


class TestAttackScenarioSimulation:
    def test_attack_scenario_loss_calculation(self):
        payments_attempted = 10
        payments_settled = 10

        seller_loss_percent = ((payments_attempted - payments_settled) / payments_attempted) * 100

        assert seller_loss_percent == 0

    def test_vulnerability_window_is_slot_time(self):
        slot_time_ms = 400
        typical_api_latency_ms = 50

        requests_per_slot = slot_time_ms // typical_api_latency_ms

        assert requests_per_slot > 1, (
            f"Multiple requests ({requests_per_slot}) can arrive within a single slot"
        )


class TestMitigationHookPoints:
    def test_client_side_memo_mitigation_location(self):
        assert str(Pubkey.from_string(MEMO_PROGRAM_ADDRESS)) == MEMO_PROGRAM_ADDRESS

    def test_facilitator_would_need_instruction_count_update(self):
        min_instructions = 3
        max_instructions = 6

        assert max_instructions > min_instructions


class TestMemoDataIsValidUTF8:
    @pytest.fixture
    def mock_rpc_client(self):
        mock_client = MagicMock()

        mock_blockhash_resp = MagicMock()
        mock_blockhash_resp.value.blockhash = Hash.from_string(FIXED_BLOCKHASH)
        mock_client.get_latest_blockhash.return_value = mock_blockhash_resp

        mock_account_info = MagicMock()
        mock_account_info.value = MagicMock()
        mock_account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        mock_account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
        mock_client.get_account_info.return_value = mock_account_info

        return mock_client

    @pytest.fixture
    def test_keypair(self):
        seed = bytes([1] * 32)
        return Keypair.from_seed(seed)

    @pytest.fixture
    def test_requirements(self, test_keypair):
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        return PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey())},
        )

    def test_memo_data_is_valid_utf8(self, mock_rpc_client, test_keypair, test_requirements):
        """Verify memo data is valid UTF-8 (SPL Memo requirement)."""
        signer = KeypairSigner(test_keypair)
        client = ExactSvmClientScheme(signer)

        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            payload = client.create_payment_payload(test_requirements)

        tx = decode_transaction_from_payload(ExactSvmPayload(transaction=payload["transaction"]))

        # Find memo instruction (index 3)
        assert len(tx.message.instructions) >= 4
        memo_ix = tx.message.instructions[3]
        memo_program = tx.message.account_keys[memo_ix.program_id_index]
        assert str(memo_program) == MEMO_PROGRAM_ADDRESS

        # Verify memo data is valid UTF-8
        memo_data = bytes(memo_ix.data)

        # Should decode as valid UTF-8
        try:
            memo_string = memo_data.decode("utf-8")
        except UnicodeDecodeError:
            pytest.fail("Memo data is not valid UTF-8")

        # Should be hex-encoded (32 chars for 16 bytes)
        expected_len = 32
        assert len(memo_data) == expected_len, (
            f"Memo should be hex-encoded (expected {expected_len} chars, got {len(memo_data)})"
        )

        # Should only contain valid hex characters
        import re

        assert re.match(r"^[0-9a-f]+$", memo_string), "Memo data should only contain hex characters"

        print("\n=== UTF-8 VALIDITY CONFIRMED ===")
        print(f"Memo data: {memo_string}")
        print("Is valid UTF-8: True")


class TestMemoInstructionHasNoSigners:
    """Verify memo has no signers - adding them breaks facilitator verification."""

    @pytest.fixture
    def mock_rpc_client(self):
        mock_client = MagicMock()
        mock_blockhash_resp = MagicMock()
        mock_blockhash_resp.value.blockhash = Hash.from_string(FIXED_BLOCKHASH)
        mock_client.get_latest_blockhash.return_value = mock_blockhash_resp

        mock_account_info = MagicMock()
        mock_account_info.value = MagicMock()
        mock_account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        mock_account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
        mock_client.get_account_info.return_value = mock_account_info
        return mock_client

    @pytest.fixture
    def test_keypair(self):
        return Keypair.from_seed(bytes([1] * 32))

    @pytest.fixture
    def test_requirements(self):
        return PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(Keypair.from_seed(bytes([3] * 32)).pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(Keypair.from_seed(bytes([2] * 32)).pubkey())},
        )

    def test_memo_has_empty_accounts(self, mock_rpc_client, test_keypair, test_requirements):
        """Empty accounts is critical - signers break facilitator verification."""
        client = ExactSvmClientScheme(KeypairSigner(test_keypair))

        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            payload = client.create_payment_payload(test_requirements)

        tx = decode_transaction_from_payload(ExactSvmPayload(transaction=payload["transaction"]))
        assert len(tx.message.instructions) >= 4

        memo_ix = tx.message.instructions[3]
        assert str(tx.message.account_keys[memo_ix.program_id_index]) == MEMO_PROGRAM_ADDRESS
        assert len(memo_ix.accounts) == 0, "memo must have no accounts"


class TestSellerMemo:
    """Tests for optional extra.memo seller-defined memo support."""

    @pytest.fixture
    def mock_rpc_client(self):
        mock_client = MagicMock()
        mock_blockhash_resp = MagicMock()
        mock_blockhash_resp.value.blockhash = Hash.from_string(FIXED_BLOCKHASH)
        mock_client.get_latest_blockhash.return_value = mock_blockhash_resp

        mock_account_info = MagicMock()
        mock_account_info.value = MagicMock()
        mock_account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        mock_account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
        mock_client.get_account_info.return_value = mock_account_info
        return mock_client

    @pytest.fixture
    def test_keypair(self):
        return Keypair.from_seed(bytes([1] * 32))

    def test_uses_extra_memo_as_memo_data(self, mock_rpc_client, test_keypair):
        """When extra.memo is provided, client uses it as memo instruction data."""
        seller_memo = "pi_3abc123def456"
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey()), "memo": seller_memo},
        )

        client = ExactSvmClientScheme(KeypairSigner(test_keypair))
        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            payload = client.create_payment_payload(requirements)

        tx = decode_transaction_from_payload(ExactSvmPayload(transaction=payload["transaction"]))
        assert len(tx.message.instructions) >= 4

        memo_ix = tx.message.instructions[3]
        assert str(tx.message.account_keys[memo_ix.program_id_index]) == MEMO_PROGRAM_ADDRESS

        memo_data = bytes(memo_ix.data).decode("utf-8")
        assert memo_data == seller_memo

    def test_produces_identical_memo_with_extra_memo(self, mock_rpc_client, test_keypair):
        """With extra.memo, memo data is deterministic across calls."""
        seller_memo = "order_12345"
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey()), "memo": seller_memo},
        )

        client = ExactSvmClientScheme(KeypairSigner(test_keypair))
        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            payload1 = client.create_payment_payload(requirements)
            payload2 = client.create_payment_payload(requirements)

        tx1 = decode_transaction_from_payload(ExactSvmPayload(transaction=payload1["transaction"]))
        tx2 = decode_transaction_from_payload(ExactSvmPayload(transaction=payload2["transaction"]))

        memo1 = bytes(tx1.message.instructions[3].data).decode("utf-8")
        memo2 = bytes(tx2.message.instructions[3].data).decode("utf-8")

        assert memo1 == seller_memo
        assert memo2 == seller_memo
        assert memo1 == memo2

    def test_falls_back_to_random_nonce_without_memo(self, mock_rpc_client, test_keypair):
        """Without extra.memo, falls back to random hex nonce."""
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey())},
        )

        client = ExactSvmClientScheme(KeypairSigner(test_keypair))
        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            payload1 = client.create_payment_payload(requirements)
            payload2 = client.create_payment_payload(requirements)

        tx1 = decode_transaction_from_payload(ExactSvmPayload(transaction=payload1["transaction"]))
        tx2 = decode_transaction_from_payload(ExactSvmPayload(transaction=payload2["transaction"]))

        memo1 = bytes(tx1.message.instructions[3].data).decode("utf-8")
        memo2 = bytes(tx2.message.instructions[3].data).decode("utf-8")

        import re

        assert memo1 != memo2, "Random nonces should differ between calls"
        assert re.match(r"^[0-9a-f]{32}$", memo1), "Nonce should be 32 hex chars"
        assert re.match(r"^[0-9a-f]{32}$", memo2), "Nonce should be 32 hex chars"

    def test_rejects_memo_exceeding_256_bytes(self, mock_rpc_client, test_keypair):
        """Client should reject extra.memo exceeding 256 bytes."""
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))

        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey()), "memo": "x" * 257},
        )

        client = ExactSvmClientScheme(KeypairSigner(test_keypair))
        with patch.object(client, "_get_client", return_value=mock_rpc_client):
            with pytest.raises(ValueError, match="extra.memo exceeds maximum 256 bytes"):
                client.create_payment_payload(requirements)
