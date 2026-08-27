"""Tests for transaction version 1 (SIMD-0385) support in the SVM exact schemes.

Version 1 carries its compute budget and priority fee in ``message.config``
instead of ComputeBudget instructions, so the transfer sits at instruction index
0 and the fee policy is enforced against the config.
"""

import base64

import pytest
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message, MessageV0, MessageV1, TransactionConfig, to_bytes_versioned
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ERR_INVALID_INSTRUCTION_COUNT,
    ERR_UNKNOWN_OPTIONAL_INSTRUCTION,
    ERR_UNSUPPORTED_TRANSACTION_VERSION,
    ERR_V1_CONFIG_COMPUTE_LIMIT_MISSING,
    ERR_V1_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_MISSING,
    ERR_V1_CONFIG_PRIORITY_FEE_TOO_HIGH,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MEMO_PROGRAM_ADDRESS,
    SOLANA_DEVNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    check_v1_transaction_config,
    derive_ata,
    get_token_payer_from_transaction,
    get_transaction_version,
    is_supported_transaction_version,
)
from x402.mechanisms.svm.exact import ExactSvmFacilitatorScheme
from x402.mechanisms.svm.exact.v1 import ExactSvmSchemeV1Facilitator
from x402.mechanisms.svm.types import ExactSvmPayload
from x402.mechanisms.svm.utils import decode_transaction_from_payload
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"
AMOUNT = 100_000

FEE_PAYER = Keypair.from_seed(bytes([2] * 32))
AUTHORITY = Keypair.from_seed(bytes([1] * 32))
SOURCE = Keypair.from_seed(bytes([4] * 32))
PAY_TO = Keypair.from_seed(bytes([3] * 32))

DESTINATION_ATA = Pubkey.from_string(
    derive_ata(str(PAY_TO.pubkey()), USDC_DEVNET_ADDRESS, TOKEN_PROGRAM_ADDRESS)
)

VALID_CONFIG = TransactionConfig(compute_unit_limit=20_000, loaded_accounts_data_size_limit=65_536)


def transfer_checked_instruction(amount: int = AMOUNT) -> Instruction:
    """Build a TransferChecked instruction paying the fixture destination ATA."""
    data = bytes([12]) + amount.to_bytes(8, "little") + bytes([6])
    return Instruction(
        Pubkey.from_string(TOKEN_PROGRAM_ADDRESS),
        data,
        [
            AccountMeta(SOURCE.pubkey(), False, True),
            AccountMeta(Pubkey.from_string(USDC_DEVNET_ADDRESS), False, False),
            AccountMeta(DESTINATION_ATA, False, True),
            AccountMeta(AUTHORITY.pubkey(), True, False),
        ],
    )


def memo_instruction(data: bytes = b"unique-nonce") -> Instruction:
    """Build a Memo instruction."""
    return Instruction(Pubkey.from_string(MEMO_PROGRAM_ADDRESS), data, [])


def compute_budget_instruction() -> Instruction:
    """Build a SetComputeUnitLimit instruction, which version 1 must not carry."""
    return Instruction(
        Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS), bytes([2, 160, 134, 1, 0]), []
    )


def build_v1_transaction(
    config: TransactionConfig | None = VALID_CONFIG,
    instructions: list[Instruction] | None = None,
) -> str:
    """Build a base64 version 1 transaction, unsigned in the fee payer's slot.

    Args:
        config: The message config, or None to set no config at all.
        instructions: Instructions to include, defaulting to a single transfer.

    Returns:
        The base64 wire transaction.
    """
    ixs = instructions if instructions is not None else [transfer_checked_instruction()]
    message = MessageV1.try_compile(
        FEE_PAYER.pubkey(), ixs, Hash.from_string(FIXED_BLOCKHASH), config
    )
    signatures = [Signature.default()] * message.header.num_required_signatures
    if len(signatures) > 1:
        signatures[1] = AUTHORITY.sign_message(to_bytes_versioned(message))
    return base64.b64encode(bytes(VersionedTransaction.populate(message, signatures))).decode()


class MockFacilitatorSigner:
    """Signer that accepts the fixture fee payer and never touches the network."""

    def get_addresses(self) -> list[str]:
        return [str(FEE_PAYER.pubkey())]

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        pass

    def send_transaction(self, tx_base64: str, network: str) -> str:
        return "mockSignature123"

    def confirm_transaction(self, signature: str, network: str) -> None:
        pass


def requirements() -> PaymentRequirements:
    """Return payment requirements matching the fixture transfer."""
    return PaymentRequirements(
        scheme="exact",
        network=SOLANA_DEVNET_CAIP2,
        asset=USDC_DEVNET_ADDRESS,
        amount=str(AMOUNT),
        pay_to=str(PAY_TO.pubkey()),
        max_timeout_seconds=3600,
        extra={"feePayer": str(FEE_PAYER.pubkey())},
    )


def payload_for(transaction: str) -> PaymentPayload:
    """Wrap a base64 transaction in a V2 payment payload."""
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="http://example.com/protected",
            description="Test resource",
            mime_type="application/json",
        ),
        accepted=requirements(),
        payload={"transaction": transaction},
    )


def verify_v1(
    config: TransactionConfig | None = VALID_CONFIG,
    trailing: list[Instruction] | None = None,
):
    """Verify a version 1 transfer with the given config and trailing instructions."""
    instructions = [transfer_checked_instruction(), *(trailing or [])]
    transaction = build_v1_transaction(config, instructions)
    facilitator = ExactSvmFacilitatorScheme(MockFacilitatorSigner())
    return facilitator.verify(payload_for(transaction), requirements())


class TestCheckV1TransactionConfig:
    """The version 1 config policy, mirroring the compute budget instruction checks."""

    def test_requires_a_compute_unit_limit(self):
        cap = MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS
        assert check_v1_transaction_config(None, None, cap) == "compute_unit_limit_missing"
        assert (
            check_v1_transaction_config(TransactionConfig(priority_fee=1), None, cap)
            == "compute_unit_limit_missing"
        )
        assert (
            check_v1_transaction_config(TransactionConfig(compute_unit_limit=0), None, cap)
            == "compute_unit_limit_missing"
        )

    def test_enforces_the_compute_unit_cap_when_configured(self):
        cap = MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS
        assert (
            check_v1_transaction_config(TransactionConfig(compute_unit_limit=20_001), 20_000, cap)
            == "compute_unit_limit_too_high"
        )
        assert (
            check_v1_transaction_config(
                TransactionConfig(
                    compute_unit_limit=20_000, loaded_accounts_data_size_limit=65_536
                ),
                20_000,
                cap,
            )
            is None
        )

    def test_requires_a_loaded_accounts_data_size_limit(self):
        assert (
            check_v1_transaction_config(TransactionConfig(compute_unit_limit=20_000), None, 0)
            == "loaded_accounts_data_size_limit_missing"
        )
        assert (
            check_v1_transaction_config(
                TransactionConfig(compute_unit_limit=20_000, loaded_accounts_data_size_limit=0),
                None,
                0,
            )
            == "loaded_accounts_data_size_limit_missing"
        )

    @pytest.mark.parametrize(
        ("priority_fee", "expected"),
        [(100_000, None), (100_001, "priority_fee_too_high")],
    )
    def test_normalizes_the_total_lamport_priority_fee_against_the_per_cu_cap(
        self, priority_fee, expected
    ):
        """5,000,000 micro-lamports/CU over 20,000 CUs allows 100,000 lamports."""
        config = TransactionConfig(
            compute_unit_limit=20_000,
            loaded_accounts_data_size_limit=65_536,
            priority_fee=priority_fee,
        )
        assert (
            check_v1_transaction_config(config, None, MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS)
            == expected
        )

    def test_accepts_a_config_with_no_priority_fee(self):
        config = TransactionConfig(
            compute_unit_limit=20_000, loaded_accounts_data_size_limit=65_536
        )
        assert check_v1_transaction_config(config, None, 0) is None

    def test_leaves_heap_size_uncapped(self):
        """heap_size adds no execution surface beyond the capped compute unit limit."""
        config = TransactionConfig(
            compute_unit_limit=20_000,
            loaded_accounts_data_size_limit=65_536,
            heap_size=256 * 1024,
        )
        assert (
            check_v1_transaction_config(config, None, MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) is None
        )


class TestTransactionVersionAllowlist:
    """The allowlist admits exactly the versions the schemes model."""

    @pytest.mark.parametrize("version", ["legacy", 0, 1])
    def test_allows_legacy_0_and_1(self, version):
        assert is_supported_transaction_version(version) is True

    @pytest.mark.parametrize("version", [2, 127])
    def test_rejects_everything_else(self, version):
        assert is_supported_transaction_version(version) is False


class TestGetTransactionVersion:
    """The version probe reads the version off the serialized message prefix."""

    def test_reports_legacy(self):
        message = Message.new_with_blockhash(
            [transfer_checked_instruction()], FEE_PAYER.pubkey(), Hash.from_string(FIXED_BLOCKHASH)
        )
        assert get_transaction_version(message) == "legacy"

    def test_reports_0(self):
        message = MessageV0.try_compile(
            FEE_PAYER.pubkey(),
            [transfer_checked_instruction()],
            [],
            Hash.from_string(FIXED_BLOCKHASH),
        )
        assert get_transaction_version(message) == 0

    def test_reports_1(self):
        tx = decode_transaction_from_payload(ExactSvmPayload(transaction=build_v1_transaction()))
        assert get_transaction_version(tx.message) == 1


class TestGetTokenPayerFromV1Transaction:
    """The transfer authority is read out of a version 1 transaction unchanged."""

    def test_extracts_the_transfer_authority(self):
        tx = decode_transaction_from_payload(ExactSvmPayload(transaction=build_v1_transaction()))
        assert get_token_payer_from_transaction(tx) == str(AUTHORITY.pubkey())


class TestExactSvmSchemeStaticPathV1:
    """The exact static path verifies version 1 transfers off message.config."""

    def test_accepts_a_valid_v1_transfer_reading_limits_from_message_config(self):
        result = verify_v1(
            TransactionConfig(
                compute_unit_limit=20_000,
                loaded_accounts_data_size_limit=65_536,
                priority_fee=100_000,
            )
        )
        assert result.invalid_reason is None
        assert result.is_valid is True
        assert result.payer == str(AUTHORITY.pubkey())

    def test_accepts_a_v1_transfer_with_a_trailing_memo(self):
        result = verify_v1(trailing=[memo_instruction()])
        assert result.is_valid is True

    def test_rejects_a_v1_transaction_with_no_compute_unit_limit(self):
        result = verify_v1(None)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_V1_CONFIG_COMPUTE_LIMIT_MISSING

    def test_rejects_a_v1_transaction_with_no_loaded_accounts_data_size_limit(self):
        result = verify_v1(TransactionConfig(compute_unit_limit=20_000))
        assert result.is_valid is False
        assert result.invalid_reason == ERR_V1_CONFIG_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_MISSING

    def test_rejects_a_v1_priority_fee_above_the_normalized_cap(self):
        """The default 5,000,000 micro-lamports/CU cap over 20,000 CUs allows
        100,000 lamports of total priority fee."""
        result = verify_v1(
            TransactionConfig(
                compute_unit_limit=20_000,
                loaded_accounts_data_size_limit=65_536,
                priority_fee=100_001,
            )
        )
        assert result.is_valid is False
        assert result.invalid_reason == ERR_V1_CONFIG_PRIORITY_FEE_TOO_HIGH

    def test_accepts_a_v1_priority_fee_exactly_at_the_normalized_cap(self):
        result = verify_v1(
            TransactionConfig(
                compute_unit_limit=20_000,
                loaded_accounts_data_size_limit=65_536,
                priority_fee=100_000,
            )
        )
        assert result.is_valid is True

    def test_rejects_a_compute_budget_instruction_inside_a_v1_transaction(self):
        """The config is authoritative on version 1, so a ComputeBudget
        instruction there can only be gaming an instruction-scanning check."""
        result = verify_v1(trailing=[compute_budget_instruction()])
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNKNOWN_OPTIONAL_INSTRUCTION

    def test_rejects_a_v1_transaction_above_the_instruction_window(self):
        """Version 1 allows the transfer plus at most four optional instructions."""
        result = verify_v1(trailing=[memo_instruction(bytes([i])) for i in range(5)])
        assert result.is_valid is False
        assert result.invalid_reason == ERR_INVALID_INSTRUCTION_COUNT

    def test_rejects_a_v1_transaction_whose_first_instruction_is_not_a_transfer(self):
        transaction = build_v1_transaction(
            VALID_CONFIG, [memo_instruction(), transfer_checked_instruction()]
        )
        facilitator = ExactSvmFacilitatorScheme(MockFacilitatorSigner())
        result = facilitator.verify(payload_for(transaction), requirements())
        assert result.is_valid is False


class TestUnknownVersionRejection:
    """A version the schemes do not model fails closed on both wire formats."""

    def test_v2_scheme_rejects_a_transaction_reporting_an_unknown_version(self, monkeypatch):
        monkeypatch.setattr(
            "x402.mechanisms.svm.exact.facilitator.get_transaction_version", lambda message: 2
        )
        facilitator = ExactSvmFacilitatorScheme(MockFacilitatorSigner())
        result = facilitator.verify(payload_for(build_v1_transaction()), requirements())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

    def test_legacy_wire_scheme_rejects_a_transaction_reporting_an_unknown_version(
        self, monkeypatch
    ):
        monkeypatch.setattr(
            "x402.mechanisms.svm.exact.v1.facilitator.get_transaction_version", lambda message: 2
        )
        result = self._verify_legacy_wire(build_v1_transaction())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

    def test_legacy_wire_scheme_rejects_a_version_1_transaction(self):
        """The legacy x402 v1 wire scheme is index-based over the compiled
        message and does not model version 1, so it gates rather than supports."""
        result = self._verify_legacy_wire(build_v1_transaction())
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

    @staticmethod
    def _verify_legacy_wire(transaction: str):
        facilitator = ExactSvmSchemeV1Facilitator(MockFacilitatorSigner())
        return facilitator.verify(
            PaymentPayloadV1(
                x402_version=1,
                scheme="exact",
                network="solana-devnet",
                payload={"transaction": transaction},
            ),
            PaymentRequirementsV1(
                scheme="exact",
                network="solana-devnet",
                asset=USDC_DEVNET_ADDRESS,
                max_amount_required=str(AMOUNT),
                pay_to=str(PAY_TO.pubkey()),
                resource="https://example.com",
                description="",
                mime_type="application/json",
                max_timeout_seconds=3600,
                extra={"feePayer": str(FEE_PAYER.pubkey())},
            ),
        )
