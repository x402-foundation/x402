"""Tests for SVM transaction message version negotiation.

Facilitators advertise ``extra.transactionVersions`` in ``/supported``, servers
copy it into the requirements, clients build one of the advertised versions, and
verifiers reject any message version they do not model before inspecting
instructions.
"""

import base64
from unittest.mock import MagicMock, patch

import pytest
from solders.hash import Hash
from solders.instruction import Instruction
from solders.keypair import Keypair
from solders.message import Message, MessageV0
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from x402.mechanisms.svm import (
    ACCEPTED_TRANSACTION_VERSIONS,
    ADVERTISED_TRANSACTION_VERSIONS,
    ERR_UNSUPPORTED_TRANSACTION_VERSION,
    SOLANA_DEVNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    get_transaction_version,
    is_accepted_transaction_version,
    peek_wire_transaction_version,
    resolve_transaction_version,
)
from x402.mechanisms.svm.exact import (
    ExactSvmClientScheme,
    ExactSvmFacilitatorScheme,
    ExactSvmServerScheme,
)
from x402.mechanisms.svm.exact.v1 import ExactSvmSchemeV1Client, ExactSvmSchemeV1Facilitator
from x402.mechanisms.svm.signers import KeypairSigner
from x402.mechanisms.svm.utils import compile_payment_message, transaction_message_hash
from x402.pending_settlement_store import InMemoryPendingSettlementStore
from x402.schemas import PaymentPayload, PaymentRequirements, ResourceInfo, SupportedKind
from x402.schemas.v1 import PaymentPayloadV1, PaymentRequirementsV1

FEE_PAYER = "FeePayer1111111111111111111111111111"
FIXED_BLOCKHASH = "5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF"


class MockFacilitatorSigner:
    def __init__(self, addresses: list[str] | None = None):
        self._addresses = addresses or [FEE_PAYER]

    def get_addresses(self) -> list[str]:
        return self._addresses

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        pass

    def send_transaction(self, tx_base64: str, network: str) -> str:
        return "mockSignature123"

    def confirm_transaction(self, signature: str, network: str) -> None:
        pass


def _noop_instruction(payer: Pubkey) -> Instruction:
    return Instruction(Pubkey.from_string("11111111111111111111111111111111"), b"", [])


def _legacy_tx() -> VersionedTransaction:
    kp = Keypair()
    msg = Message.new_with_blockhash(
        [_noop_instruction(kp.pubkey())], kp.pubkey(), Hash.from_string(FIXED_BLOCKHASH)
    )
    return VersionedTransaction(msg, [kp])


def _v0_tx() -> VersionedTransaction:
    kp = Keypair()
    msg = MessageV0.try_compile(
        kp.pubkey(), [_noop_instruction(kp.pubkey())], [], Hash.from_string(FIXED_BLOCKHASH)
    )
    return VersionedTransaction(msg, [kp])


def _tx_base64(tx: VersionedTransaction) -> str:
    return base64.b64encode(bytes(tx)).decode()


def _retagged_v1_wire() -> str:
    """A signed v0 transaction with its message prefix replaced by 0x81, as the Go tests do."""
    raw = bytearray(bytes(_v0_tx()))
    offset = 1 + 64 * raw[0]
    assert raw[offset] == 0x80
    raw[offset] = 0x81
    return base64.b64encode(bytes(raw)).decode()


def _simd0385_v1_wire() -> str:
    """A version 1 wire transaction in the SIMD-0385 layout: message first, signatures last."""
    raw = bytearray(1 + 3 + 4 + 32 + 1 + 1 + 32 + 64)
    raw[0:4] = bytes([0x81, 1, 0, 0])
    raw[40] = 0  # NumInstructions
    raw[41] = 1  # NumAddresses (the fee payer)
    raw[42:74] = bytes([7] * 32)
    return base64.b64encode(bytes(raw)).decode()


class CountingFacilitatorSigner(MockFacilitatorSigner):
    def __init__(self):
        super().__init__()
        self.sign_calls = 0
        self.simulate_calls = 0

    def sign_transaction(self, tx_base64: str, fee_payer: str, network: str) -> str:
        self.sign_calls += 1
        return tx_base64

    def simulate_transaction(self, tx_base64: str, network: str) -> None:
        self.simulate_calls += 1


class TestConstants:
    def test_legacy_is_accepted_but_never_advertised(self):
        assert ADVERTISED_TRANSACTION_VERSIONS == [0]
        assert "legacy" in ACCEPTED_TRANSACTION_VERSIONS
        assert 0 in ACCEPTED_TRANSACTION_VERSIONS
        assert "legacy" not in ADVERTISED_TRANSACTION_VERSIONS
        assert set(ADVERTISED_TRANSACTION_VERSIONS) <= set(ACCEPTED_TRANSACTION_VERSIONS)


class TestGetTransactionVersion:
    def test_legacy_message(self):
        assert get_transaction_version(_legacy_tx().message) == "legacy"

    def test_v0_message(self):
        assert get_transaction_version(_v0_tx().message) == 0

    def test_round_trip_through_wire_decode(self):
        legacy = VersionedTransaction.from_bytes(bytes(_legacy_tx()))
        v0 = VersionedTransaction.from_bytes(bytes(_v0_tx()))
        assert get_transaction_version(legacy.message) == "legacy"
        assert get_transaction_version(v0.message) == 0

    def test_unknown_message_type_is_not_accepted(self):
        assert get_transaction_version(object()) == -1


class TestIsAcceptedTransactionVersion:
    @pytest.mark.parametrize("version", ["legacy", 0])
    def test_accepts_legacy_and_v0(self, version):
        assert is_accepted_transaction_version(version) is True

    @pytest.mark.parametrize("version", [1, 2, -1, "1", False, True, None])
    def test_rejects_everything_else(self, version):
        assert is_accepted_transaction_version(version) is False


class TestResolveTransactionVersion:
    @pytest.mark.parametrize("extra", [None, {}])
    def test_absent_defaults_to_v0(self, extra):
        assert resolve_transaction_version(extra) == 0

    @pytest.mark.parametrize("advertised", ["0", 0, None])
    def test_rejects_malformed_metadata(self, advertised):
        with pytest.raises(ValueError, match=f"^{ERR_UNSUPPORTED_TRANSACTION_VERSION}"):
            resolve_transaction_version({"transactionVersions": advertised})

    @pytest.mark.parametrize("advertised", [[0], [0, 1], [1, 0]])
    def test_picks_v0_when_advertised(self, advertised):
        assert resolve_transaction_version({"transactionVersions": advertised}) == 0

    def test_picks_highest_mutually_supported_version(self, monkeypatch):
        monkeypatch.setattr(
            "x402.mechanisms.svm.utils.CLIENT_SUPPORTED_TRANSACTION_VERSIONS",
            [0, 1],
        )
        assert resolve_transaction_version({"transactionVersions": [0, 1]}) == 1

    @pytest.mark.parametrize(
        "advertised",
        [
            [1],
            ["legacy"],
            [],
            [False],
            ["0"],
            ["legacy", 0],
            ["1", 0],
            [None, 0],
            [2, 1, 0],
            [True, 0],
        ],
    )
    def test_raises_when_v0_not_advertised_or_field_invalid(self, advertised):
        with pytest.raises(ValueError, match=f"^{ERR_UNSUPPORTED_TRANSACTION_VERSION}"):
            resolve_transaction_version({"transactionVersions": advertised})


class TestCompilePaymentMessage:
    def test_compiles_v0(self):
        kp = Keypair()
        message = compile_payment_message(
            0,
            payer=kp.pubkey(),
            instructions=[_noop_instruction(kp.pubkey())],
            recent_blockhash=Hash.from_string(FIXED_BLOCKHASH),
        )
        assert get_transaction_version(message) == 0

    def test_refuses_a_version_it_cannot_build(self):
        kp = Keypair()
        with pytest.raises(ValueError, match=f"^{ERR_UNSUPPORTED_TRANSACTION_VERSION}"):
            compile_payment_message(
                1,
                payer=kp.pubkey(),
                instructions=[_noop_instruction(kp.pubkey())],
                recent_blockhash=Hash.from_string(FIXED_BLOCKHASH),
            )


class TestFacilitatorSupportedExtra:
    def test_v2_facilitator_advertises_transaction_versions(self):
        facilitator = ExactSvmFacilitatorScheme(MockFacilitatorSigner())
        extra = facilitator.get_extra(SOLANA_DEVNET_CAIP2)
        assert extra is not None
        assert extra["feePayer"] == FEE_PAYER
        assert extra["transactionVersions"] == [0]

    def test_v1_facilitator_advertises_transaction_versions(self):
        facilitator = ExactSvmSchemeV1Facilitator(MockFacilitatorSigner())
        extra = facilitator.get_extra("solana-devnet")
        assert extra is not None
        assert extra["feePayer"] == FEE_PAYER
        assert extra["transactionVersions"] == [0]

    def test_advertised_list_is_a_copy(self):
        facilitator = ExactSvmFacilitatorScheme(MockFacilitatorSigner())
        extra = facilitator.get_extra(SOLANA_DEVNET_CAIP2)
        assert extra is not None
        extra["transactionVersions"].append(1)
        assert ADVERTISED_TRANSACTION_VERSIONS == [0]


class TestServerCopiesTransactionVersions:
    @staticmethod
    def _requirements() -> PaymentRequirements:
        return PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={},
        )

    def test_copies_when_present(self):
        server = ExactSvmServerScheme()
        kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            extra={"feePayer": FEE_PAYER, "transactionVersions": [0]},
        )
        result = server.enhance_payment_requirements(self._requirements(), kind, [])
        assert result.extra is not None
        assert result.extra["feePayer"] == FEE_PAYER
        assert result.extra["transactionVersions"] == [0]

    def test_omits_when_absent(self):
        server = ExactSvmServerScheme()
        kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            extra={"feePayer": FEE_PAYER},
        )
        result = server.enhance_payment_requirements(self._requirements(), kind, [])
        assert result.extra is not None
        assert "transactionVersions" not in result.extra

    def test_forwards_malformed_value_for_fail_closed_client_handling(self):
        server = ExactSvmServerScheme()
        kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            extra={"feePayer": FEE_PAYER, "transactionVersions": "0"},
        )
        result = server.enhance_payment_requirements(self._requirements(), kind, [])
        assert result.extra is not None
        assert result.extra["transactionVersions"] == "0"


class TestClientBuildsAdvertisedVersion:
    @staticmethod
    def _mock_rpc_client() -> MagicMock:
        mock_client = MagicMock()
        blockhash_response = MagicMock()
        blockhash_response.value.blockhash = Hash.from_string(FIXED_BLOCKHASH)
        mock_client.get_latest_blockhash.return_value = blockhash_response
        account_info = MagicMock()
        account_info.value = MagicMock()
        account_info.value.owner = Pubkey.from_string(TOKEN_PROGRAM_ADDRESS)
        account_info.value.data = bytes(44) + bytes([6]) + bytes(37)
        mock_client.get_account_info.return_value = account_info
        return mock_client

    @staticmethod
    def _v2_requirements(extra: dict[str, object]) -> PaymentRequirements:
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))
        return PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            extra={"feePayer": str(fee_payer.pubkey()), **extra},
        )

    @staticmethod
    def _v1_requirements(extra: dict[str, object]) -> PaymentRequirementsV1:
        fee_payer = Keypair.from_seed(bytes([2] * 32))
        pay_to = Keypair.from_seed(bytes([3] * 32))
        return PaymentRequirementsV1(
            scheme="exact",
            network="solana-devnet",
            asset=USDC_DEVNET_ADDRESS,
            max_amount_required="100000",
            pay_to=str(pay_to.pubkey()),
            max_timeout_seconds=3600,
            resource="http://example.com/protected",
            description="",
            mime_type="application/json",
            extra={"feePayer": str(fee_payer.pubkey()), **extra},
        )

    @staticmethod
    def _decode(payload: dict[str, object]) -> VersionedTransaction:
        transaction = payload["transaction"]
        assert isinstance(transaction, str)
        return VersionedTransaction.from_bytes(base64.b64decode(transaction))

    @pytest.mark.parametrize(
        "extra", [{}, {"transactionVersions": [0]}, {"transactionVersions": [0, 1]}]
    )
    def test_v2_client_builds_v0(self, extra):
        client = ExactSvmClientScheme(KeypairSigner(Keypair.from_seed(bytes([1] * 32))))
        with patch.object(client, "_get_client", return_value=self._mock_rpc_client()):
            payload = client.create_payment_payload(self._v2_requirements(extra))
        tx = self._decode(payload)
        assert isinstance(tx.message, MessageV0)
        assert get_transaction_version(tx.message) == 0

    @pytest.mark.parametrize("extra", [{}, {"transactionVersions": [0]}])
    def test_v1_client_builds_v0(self, extra):
        client = ExactSvmSchemeV1Client(KeypairSigner(Keypair.from_seed(bytes([1] * 32))))
        with patch.object(client, "_get_client", return_value=self._mock_rpc_client()):
            payload = client.create_payment_payload(self._v1_requirements(extra))
        tx = self._decode(payload)
        assert isinstance(tx.message, MessageV0)

    @pytest.mark.parametrize("advertised", [[1], ["legacy"]])
    def test_v2_client_refuses_when_v0_not_advertised(self, advertised):
        client = ExactSvmClientScheme(KeypairSigner(Keypair.from_seed(bytes([1] * 32))))
        with (
            patch.object(client, "_get_client") as get_client,
            pytest.raises(ValueError, match=f"^{ERR_UNSUPPORTED_TRANSACTION_VERSION}"),
        ):
            client.create_payment_payload(
                self._v2_requirements({"transactionVersions": advertised})
            )
        get_client.assert_not_called()

    def test_v1_client_refuses_when_v0_not_advertised(self):
        client = ExactSvmSchemeV1Client(KeypairSigner(Keypair.from_seed(bytes([1] * 32))))
        with (
            patch.object(client, "_get_client") as get_client,
            pytest.raises(ValueError, match=f"^{ERR_UNSUPPORTED_TRANSACTION_VERSION}"),
        ):
            client.create_payment_payload(self._v1_requirements({"transactionVersions": [1]}))
        get_client.assert_not_called()


class TestFacilitatorGate:
    """The verifier rejects any message version it does not model.

    Real version 1 wire bytes are rejected from their raw version byte before
    solders decodes them. The patched tests simulate an SDK that decodes the
    message and reports an unmodelled version.
    """

    @staticmethod
    def _v2_pair(tx: VersionedTransaction | str) -> tuple[PaymentPayload, PaymentRequirements]:
        requirements = PaymentRequirements(
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            asset=USDC_DEVNET_ADDRESS,
            amount="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            extra={"feePayer": FEE_PAYER},
        )
        payload = PaymentPayload(
            x402_version=2,
            resource=ResourceInfo(
                url="http://example.com/protected",
                description="Test resource",
                mime_type="application/json",
            ),
            accepted=requirements,
            payload={"transaction": tx if isinstance(tx, str) else _tx_base64(tx)},
        )
        return payload, requirements

    @staticmethod
    def _v1_pair(
        tx: VersionedTransaction | str,
    ) -> tuple[PaymentPayloadV1, PaymentRequirementsV1]:
        requirements = PaymentRequirementsV1(
            scheme="exact",
            network="solana-devnet",
            asset=USDC_DEVNET_ADDRESS,
            max_amount_required="100000",
            pay_to="PayToAddress11111111111111111111111111",
            max_timeout_seconds=3600,
            resource="http://example.com/protected",
            description="",
            mime_type="application/json",
            extra={"feePayer": FEE_PAYER},
        )
        payload = PaymentPayloadV1(
            x402_version=1,
            scheme="exact",
            network="solana-devnet",
            payload={"transaction": tx if isinstance(tx, str) else _tx_base64(tx)},
        )
        return payload, requirements

    @pytest.mark.parametrize("version", [1, 2, -1])
    def test_v2_verify_rejects_unmodelled_version_before_instruction_checks(self, version):
        facilitator = ExactSvmFacilitatorScheme(MockFacilitatorSigner())
        payload, requirements = self._v2_pair(_v0_tx())
        with patch(
            "x402.mechanisms.svm.exact.facilitator.get_transaction_version",
            return_value=version,
        ):
            result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

    def test_v2_settle_rejects_unmodelled_version(self):
        tx = _v0_tx()
        pending_store = InMemoryPendingSettlementStore()
        pending_store.set(transaction_message_hash(tx), "mockSignature123")
        facilitator = ExactSvmFacilitatorScheme(
            MockFacilitatorSigner(), pending_store=pending_store
        )
        payload, requirements = self._v2_pair(tx)
        with patch(
            "x402.mechanisms.svm.exact.facilitator.get_transaction_version",
            return_value=1,
        ):
            result = facilitator.settle(payload, requirements)
        assert result.success is False
        assert result.error_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

    @pytest.mark.parametrize("build", [_legacy_tx, _v0_tx], ids=["legacy", "v0"])
    def test_v2_verify_passes_gate_for_accepted_versions(self, build):
        facilitator = ExactSvmFacilitatorScheme(MockFacilitatorSigner())
        payload, requirements = self._v2_pair(build())
        result = facilitator.verify(payload, requirements)
        # The gate passes; the toy transaction then fails later structural checks.
        assert result.is_valid is False
        assert result.invalid_reason != ERR_UNSUPPORTED_TRANSACTION_VERSION

    @pytest.mark.parametrize("version", [1, -1])
    def test_v1_verify_rejects_unmodelled_version(self, version):
        facilitator = ExactSvmSchemeV1Facilitator(MockFacilitatorSigner())
        payload, requirements = self._v1_pair(_v0_tx())
        with patch(
            "x402.mechanisms.svm.exact.v1.facilitator.get_transaction_version",
            return_value=version,
        ):
            result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

    def test_v1_settle_rejects_unmodelled_version_via_verify(self):
        facilitator = ExactSvmSchemeV1Facilitator(MockFacilitatorSigner())
        payload, requirements = self._v1_pair(_v0_tx())
        with patch(
            "x402.mechanisms.svm.exact.v1.facilitator.get_transaction_version",
            return_value=1,
        ):
            result = facilitator.settle(payload, requirements)
        assert result.success is False
        assert result.error_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

    @pytest.mark.parametrize(
        "wire", [_retagged_v1_wire, _simd0385_v1_wire], ids=["retagged-0x81", "simd-0385"]
    )
    def test_real_v1_wire_reports_unsupported_before_signing(self, wire):
        transaction = wire()
        assert peek_wire_transaction_version(transaction) == 1

        signer = CountingFacilitatorSigner()
        facilitator = ExactSvmFacilitatorScheme(signer)
        payload, requirements = self._v2_pair(transaction)
        verified = facilitator.verify(payload, requirements)
        assert verified.is_valid is False
        assert verified.invalid_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION
        settled = facilitator.settle(payload, requirements)
        assert settled.success is False
        assert settled.error_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

        v1_facilitator = ExactSvmSchemeV1Facilitator(signer)
        v1_payload, v1_requirements = self._v1_pair(transaction)
        verified = v1_facilitator.verify(v1_payload, v1_requirements)
        assert verified.is_valid is False
        assert verified.invalid_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION
        settled = v1_facilitator.settle(v1_payload, v1_requirements)
        assert settled.success is False
        assert settled.error_reason == ERR_UNSUPPORTED_TRANSACTION_VERSION

        assert signer.sign_calls == 0
        assert signer.simulate_calls == 0

    def test_peek_reads_legacy_and_v0(self):
        assert peek_wire_transaction_version(_tx_base64(_v0_tx())) == 0
        assert peek_wire_transaction_version(_tx_base64(_legacy_tx())) == "legacy"
        assert peek_wire_transaction_version("") is None
        assert peek_wire_transaction_version("not base64!") is None

    @pytest.mark.parametrize("build", [_legacy_tx, _v0_tx], ids=["legacy", "v0"])
    def test_v1_verify_passes_gate_for_accepted_versions(self, build):
        facilitator = ExactSvmSchemeV1Facilitator(MockFacilitatorSigner())
        payload, requirements = self._v1_pair(build())
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason != ERR_UNSUPPORTED_TRANSACTION_VERSION
