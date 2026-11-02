"""Tests for transaction version 1 (SIMD-0385) exact payments.

Version 1 carries its compute budget in ``message.config`` rather than
ComputeBudget instructions, so the static layout starts with the
TransferChecked, the facilitator applies its caps to the config, and any
ComputeBudget instruction is rejected.
"""

import base64
from unittest.mock import MagicMock, patch

import pytest
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import MessageV1, TransactionConfig, to_bytes_versioned
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import (
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    DEFAULT_COMPUTE_UNIT_LIMIT,
    DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    ERR_COMPUTE_LIMIT_TOO_HIGH,
    ERR_COMPUTE_PRICE_TOO_HIGH,
    ERR_INVALID_COMPUTE_LIMIT,
    ERR_INVALID_INSTRUCTION_COUNT,
    ERR_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_MISSING,
    ERR_MEMO_MISMATCH,
    ERR_NO_TRANSFER_INSTRUCTION,
    ERR_TRANSACTION_SIZE_EXCEEDED,
    ERR_UNKNOWN_FOURTH_INSTRUCTION,
    ERR_UNKNOWN_SEVENTH_INSTRUCTION,
    ERR_V1_COMPUTE_BUDGET_INSTRUCTION,
    ERR_V1_HEAP_SIZE,
    LIGHTHOUSE_PROGRAM_ADDRESS,
    MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
    MEMO_PROGRAM_ADDRESS,
    SOLANA_DEVNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    check_transaction_v1_config,
    derive_ata,
)
from x402.mechanisms.svm.exact import ExactSvmClientScheme, ExactSvmFacilitatorScheme
from x402.mechanisms.svm.exact.v1 import ExactSvmSchemeV1Facilitator
from x402.mechanisms.svm.signers import KeypairSigner
from x402.mechanisms.svm.utils import (
    compile_payment_message,
    encode_partially_signed_transaction,
    priority_fee_lamports,
)
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

CLIENT = Keypair.from_seed(bytes([1] * 32))
FEE_PAYER = Keypair.from_seed(bytes([2] * 32))
PAY_TO = Keypair.from_seed(bytes([3] * 32))
BLOCKHASH = Hash.from_string("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
AMOUNT = 100_000


class RecordingFacilitatorSigner:
    """A facilitator signer whose simulation always succeeds."""

    def __init__(self):
        self.signed: list[str] = []

    def get_addresses(self) -> list[str]:
        return [str(FEE_PAYER.pubkey())]

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        self.signed.append(tx_base64)
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        pass

    def send_transaction(self, tx_base64: str, network: str) -> str:
        return "mockSignature123"

    def confirm_transaction(self, signature: str, network: str) -> None:
        pass


def _requirements(extra: dict | None = None) -> PaymentRequirements:
    return PaymentRequirements(
        scheme="exact",
        network=SOLANA_DEVNET_CAIP2,
        asset=USDC_DEVNET_ADDRESS,
        amount=str(AMOUNT),
        pay_to=str(PAY_TO.pubkey()),
        max_timeout_seconds=3600,
        extra={
            "feePayer": str(FEE_PAYER.pubkey()),
            "transactionVersions": [0, 1],
            **(extra or {}),
        },
    )


def _payload(transaction: str, requirements: PaymentRequirements) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        resource=ResourceInfo(
            url="http://example.com/protected",
            description="Test resource",
            mime_type="application/json",
        ),
        accepted=requirements,
        payload={"transaction": transaction},
    )


def _transfer_ix() -> Instruction:
    source = derive_ata(str(CLIENT.pubkey()), USDC_DEVNET_ADDRESS, TOKEN_PROGRAM_ADDRESS)
    destination = derive_ata(str(PAY_TO.pubkey()), USDC_DEVNET_ADDRESS, TOKEN_PROGRAM_ADDRESS)
    return Instruction(
        program_id=Pubkey.from_string(TOKEN_PROGRAM_ADDRESS),
        accounts=[
            AccountMeta(Pubkey.from_string(source), is_signer=False, is_writable=True),
            AccountMeta(
                Pubkey.from_string(USDC_DEVNET_ADDRESS), is_signer=False, is_writable=False
            ),
            AccountMeta(Pubkey.from_string(destination), is_signer=False, is_writable=True),
            AccountMeta(CLIENT.pubkey(), is_signer=True, is_writable=False),
        ],
        data=bytes([12]) + AMOUNT.to_bytes(8, "little") + bytes([6]),
    )


def _program_ix(program: str, data: bytes = b"") -> Instruction:
    return Instruction(Pubkey.from_string(program), data, [])


def _memo_ix(memo: bytes = b"0123456789abcdef") -> Instruction:
    return _program_ix(MEMO_PROGRAM_ADDRESS, memo)


def _default_config(**overrides) -> TransactionConfig:
    values = {
        "priority_fee": 1,
        "compute_unit_limit": DEFAULT_COMPUTE_UNIT_LIMIT,
        "loaded_accounts_data_size_limit": DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    }
    values.update(overrides)
    return TransactionConfig(**values)


def _v1_wire(
    instructions: list[Instruction] | None = None,
    config: TransactionConfig | None = None,
) -> str:
    message = MessageV1.try_compile(
        FEE_PAYER.pubkey(),
        instructions if instructions is not None else [_transfer_ix(), _memo_ix()],
        BLOCKHASH,
        config if config is not None else _default_config(),
    )
    return encode_partially_signed_transaction(message, CLIENT)


def _verify(transaction: str, extra: dict | None = None):
    requirements = _requirements(extra)
    facilitator = ExactSvmFacilitatorScheme(RecordingFacilitatorSigner())
    return facilitator.verify(_payload(transaction, requirements), requirements)


def _mock_rpc_client() -> MagicMock:
    client = MagicMock()
    client.get_latest_blockhash.return_value.value.blockhash = BLOCKHASH
    account_info = MagicMock()
    account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
    account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
    client.get_account_info.return_value = account_info
    return client


class TestClientBuildsVersion1:
    def _build(self, extra: dict | None = None) -> str:
        client = ExactSvmClientScheme(KeypairSigner(CLIENT))
        with patch.object(client, "_get_client", return_value=_mock_rpc_client()):
            payload = client.create_payment_payload(_requirements(extra))
        return payload["transaction"]

    def test_client_message_carries_its_budget_in_config(self):
        tx = VersionedTransaction.from_bytes(base64.b64decode(self._build()))
        assert isinstance(tx.message, MessageV1)
        config = tx.message.config
        assert config.compute_unit_limit == DEFAULT_COMPUTE_UNIT_LIMIT
        assert config.loaded_accounts_data_size_limit == DEFAULT_LOADED_ACCOUNTS_DATA_SIZE_LIMIT
        assert config.priority_fee == priority_fee_lamports(DEFAULT_COMPUTE_UNIT_LIMIT, 1)
        assert config.heap_size is None
        compute_budget = Pubkey.from_string(COMPUTE_BUDGET_PROGRAM_ADDRESS)
        keys = tx.message.account_keys
        assert all(keys[ix.program_id_index] != compute_budget for ix in tx.message.instructions)
        tx.verify_with_results()  # fee-payer slot is empty, client slot verifies
        assert tx.signatures[1].verify(CLIENT.pubkey(), bytes([0x81]) + bytes(tx.message))

    def test_client_built_v1_verifies(self):
        result = _verify(self._build())
        assert result.is_valid is True, result.invalid_reason
        assert result.payer == str(CLIENT.pubkey())

    def test_client_built_v1_with_seller_memo_verifies(self):
        result = _verify(self._build({"memo": "order-42"}), {"memo": "order-42"})
        assert result.is_valid is True, result.invalid_reason

    def test_client_built_v1_settles(self):
        requirements = _requirements()
        transaction = self._build()
        signer = RecordingFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)
        result = facilitator.settle(_payload(transaction, requirements), requirements)
        assert result.success is True, result.error_reason
        assert result.transaction == "mockSignature123"
        assert signer.signed and signer.signed[-1] == transaction


class TestFacilitatorVersion1Layout:
    def test_transfer_alone_is_valid(self):
        assert _verify(_v1_wire([_transfer_ix()])).is_valid is True

    def test_lighthouse_and_memo_slots_are_allowed(self):
        lighthouse = _program_ix(LIGHTHOUSE_PROGRAM_ADDRESS, b"\x01")
        lighthouse_2 = _program_ix(LIGHTHOUSE_PROGRAM_ADDRESS, b"\x02")
        lighthouse_3 = _program_ix(LIGHTHOUSE_PROGRAM_ADDRESS, b"\x03")
        wire = _v1_wire([_transfer_ix(), lighthouse, lighthouse_2, lighthouse_3, _memo_ix()])
        result = _verify(wire)
        assert result.is_valid is True, result.invalid_reason

    def test_more_than_four_optional_instructions_is_rejected(self):
        extra = [_program_ix(LIGHTHOUSE_PROGRAM_ADDRESS, bytes([i])) for i in range(5)]
        result = _verify(_v1_wire([_transfer_ix(), *extra]))
        assert result.invalid_reason == ERR_INVALID_INSTRUCTION_COUNT

    def test_empty_instruction_list_is_rejected(self):
        assert _verify(_v1_wire([])).invalid_reason == ERR_INVALID_INSTRUCTION_COUNT

    def test_unknown_optional_instruction_uses_slot_codes(self):
        unknown = _program_ix("11111111111111111111111111111111", b"\x09")
        assert _verify(_v1_wire([_transfer_ix(), unknown])).invalid_reason == (
            ERR_UNKNOWN_FOURTH_INSTRUCTION
        )
        lighthouse = [_program_ix(LIGHTHOUSE_PROGRAM_ADDRESS, bytes([i])) for i in range(3)]
        assert _verify(_v1_wire([_transfer_ix(), *lighthouse, unknown])).invalid_reason == (
            ERR_UNKNOWN_SEVENTH_INSTRUCTION
        )

    def test_transfer_must_come_first(self):
        result = _verify(_v1_wire([_memo_ix(), _transfer_ix()]))
        assert result.is_valid is False
        assert result.invalid_reason == ERR_NO_TRANSFER_INSTRUCTION

    def test_memo_is_bound_to_extra_memo(self):
        result = _verify(_v1_wire([_transfer_ix(), _memo_ix(b"other")]), {"memo": "order-42"})
        assert result.invalid_reason == ERR_MEMO_MISMATCH

    @pytest.mark.parametrize(
        "compute_budget_data",
        [
            bytes([2]) + (20_000).to_bytes(4, "little"),
            bytes([3]) + (1).to_bytes(8, "little"),
        ],
        ids=["set-compute-unit-limit", "set-compute-unit-price"],
    )
    def test_compute_budget_instruction_is_rejected(self, compute_budget_data):
        compute_budget = _program_ix(COMPUTE_BUDGET_PROGRAM_ADDRESS, compute_budget_data)
        # Whether in the v0 prefix position or among the optional slots.
        for instructions in (
            [compute_budget, _transfer_ix()],
            [_transfer_ix(), compute_budget],
        ):
            result = _verify(_v1_wire(instructions))
            assert result.invalid_reason == ERR_V1_COMPUTE_BUDGET_INSTRUCTION

    def test_legacy_protocol_facilitator_verifies_v1(self):
        requirements = PaymentRequirementsV1(
            scheme="exact",
            network="solana-devnet",
            asset=USDC_DEVNET_ADDRESS,
            max_amount_required=str(AMOUNT),
            pay_to=str(PAY_TO.pubkey()),
            max_timeout_seconds=3600,
            resource="http://example.com/protected",
            description="",
            mime_type="application/json",
            extra={"feePayer": str(FEE_PAYER.pubkey())},
        )
        facilitator = ExactSvmSchemeV1Facilitator(RecordingFacilitatorSigner())
        for wire, expected in (
            (_v1_wire(), None),
            (_v1_wire(config=_default_config(compute_unit_limit=None)), ERR_INVALID_COMPUTE_LIMIT),
        ):
            payload = PaymentPayloadV1(
                x402_version=1,
                scheme="exact",
                network="solana-devnet",
                payload={"transaction": wire},
            )
            result = facilitator.verify(payload, requirements)
            assert result.invalid_reason == expected


class TestFacilitatorVersion1Config:
    def test_missing_compute_unit_limit_is_rejected(self):
        wire = _v1_wire(config=_default_config(compute_unit_limit=None))
        assert _verify(wire).invalid_reason == ERR_INVALID_COMPUTE_LIMIT

    def test_missing_loaded_accounts_data_size_limit_is_rejected(self):
        wire = _v1_wire(config=_default_config(loaded_accounts_data_size_limit=None))
        assert _verify(wire).invalid_reason == ERR_LOADED_ACCOUNTS_DATA_SIZE_LIMIT_MISSING

    def test_heap_size_is_rejected(self):
        wire = _v1_wire(config=_default_config(heap_size=64 * 1024))
        assert _verify(wire).invalid_reason == ERR_V1_HEAP_SIZE

    def test_unset_priority_fee_is_zero(self):
        assert _verify(_v1_wire(config=_default_config(priority_fee=None))).is_valid is True

    def test_priority_fee_boundary(self):
        limit = 200_000
        # Exactly the cap: fee * 1e6 == cap * limit.
        at_cap = MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS * limit // 1_000_000
        ok = _v1_wire(config=_default_config(compute_unit_limit=limit, priority_fee=at_cap))
        assert _verify(ok).is_valid is True
        over = _v1_wire(config=_default_config(compute_unit_limit=limit, priority_fee=at_cap + 1))
        assert _verify(over).invalid_reason == ERR_COMPUTE_PRICE_TOO_HIGH

    def test_maximal_priority_fee_cannot_wrap(self):
        wire = _v1_wire(config=_default_config(compute_unit_limit=1, priority_fee=2**64 - 1))
        assert _verify(wire).invalid_reason == ERR_COMPUTE_PRICE_TOO_HIGH

    def test_split_priority_fee_mask_does_not_decode(self):
        raw = bytearray(base64.b64decode(_v1_wire()))
        # TransactionConfigMask (u32 LE) follows the 0x81 prefix and 3-byte header.
        assert raw[4] & 0b11 == 0b11
        raw[4] &= ~0b10
        result = _verify(base64.b64encode(bytes(raw)).decode())
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_exact_svm_payload_transaction_could_not_be_decoded"


class TestCheckTransactionV1Config:
    def test_within_policy(self):
        assert check_transaction_v1_config(_default_config(), 5_000_000, 400_000) is None

    def test_compute_unit_cap(self):
        config = _default_config(compute_unit_limit=400_001)
        assert check_transaction_v1_config(config, 5_000_000, 400_000) == (
            ERR_COMPUTE_LIMIT_TOO_HIGH
        )
        assert check_transaction_v1_config(config, 5_000_000) is None

    def test_price_cap_scales_with_the_limit(self):
        # 50 microlamports/CU over 20,000 CU is exactly 1 lamport.
        assert check_transaction_v1_config(_default_config(priority_fee=1), 50) is None
        assert check_transaction_v1_config(_default_config(priority_fee=2), 50) == (
            ERR_COMPUTE_PRICE_TOO_HIGH
        )


class TestTransactionSizeLimit:
    def test_v1_payment_may_exceed_the_v0_limit(self):
        big_memo = _memo_ix(b"x" * 1_500)
        wire = _v1_wire([_transfer_ix(), big_memo])
        assert len(base64.b64decode(wire)) > 1232

    def test_v1_payment_over_4096_bytes_is_refused(self):
        memos = [_memo_ix(bytes([i]) * 1_100) for i in range(4)]
        with pytest.raises(ValueError, match="4096-byte limit"):
            _v1_wire([_transfer_ix(), *memos])


def _unchecked_wire(version: int, memo_len: int) -> str:
    """A signed payment padded through its memo, bypassing the client's size check."""
    message = compile_payment_message(
        version, FEE_PAYER.pubkey(), [_transfer_ix(), _memo_ix(b"a" * memo_len)], BLOCKHASH
    )
    signature = CLIENT.sign_message(to_bytes_versioned(message))
    tx = VersionedTransaction.populate(message, [Signature.default(), signature])
    return base64.b64encode(bytes(tx)).decode("utf-8")


def _wire_of_size(version: int, size: int) -> str:
    probe = len(base64.b64decode(_unchecked_wire(version, 500)))
    wire = _unchecked_wire(version, 500 + size - probe)
    assert len(base64.b64decode(wire)) == size
    return wire


class TestVerifierSizeLimit:
    @pytest.mark.parametrize(
        ("version", "size", "accepted"),
        [
            (0, 1232, True),
            (0, 1233, False),
            (1, 1233, True),
            (1, 4096, True),
            (1, 4097, False),
        ],
    )
    def test_exact_verify_enforces_the_version_size_limit(self, version, size, accepted):
        result = _verify(_wire_of_size(version, size))
        if accepted:
            assert result.is_valid, result.invalid_reason
        else:
            assert result.invalid_reason == ERR_TRANSACTION_SIZE_EXCEEDED

    def test_legacy_protocol_facilitator_enforces_the_size_limit(self):
        requirements = PaymentRequirementsV1(
            scheme="exact",
            network="solana-devnet",
            asset=USDC_DEVNET_ADDRESS,
            max_amount_required=str(AMOUNT),
            pay_to=str(PAY_TO.pubkey()),
            max_timeout_seconds=3600,
            resource="http://example.com/protected",
            description="",
            mime_type="application/json",
            extra={"feePayer": str(FEE_PAYER.pubkey())},
        )
        facilitator = ExactSvmSchemeV1Facilitator(RecordingFacilitatorSigner())
        for size, expected in ((4096, None), (4097, ERR_TRANSACTION_SIZE_EXCEEDED)):
            payload = PaymentPayloadV1(
                x402_version=1,
                scheme="exact",
                network="solana-devnet",
                payload={"transaction": _wire_of_size(1, size)},
            )
            assert facilitator.verify(payload, requirements).invalid_reason == expected
