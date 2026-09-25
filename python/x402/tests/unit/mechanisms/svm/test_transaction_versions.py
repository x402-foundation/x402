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
    resolve_transaction_version,
)
from x402.mechanisms.svm.exact import (
    ExactSvmClientScheme,
    ExactSvmFacilitatorScheme,
    ExactSvmServerScheme,
)
from x402.mechanisms.svm.exact.v1 import ExactSvmSchemeV1Client, ExactSvmSchemeV1Facilitator
from x402.mechanisms.svm.signers import KeypairSigner
from x402.mechanisms.svm.utils import transaction_message_hash
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

    @pytest.mark.parametrize("advertised", [[0], [0, 1], ["legacy", 0], [1, 0]])
    def test_picks_v0_when_advertised(self, advertised):
        assert resolve_transaction_version({"transactionVersions": advertised}) == 0

    @pytest.mark.parametrize("advertised", [[1], ["legacy"], [], [False], ["0"]])
    def test_raises_when_v0_not_advertised(self, advertised):
        with pytest.raises(ValueError, match=f"^{ERR_UNSUPPORTED_TRANSACTION_VERSION}"):
            resolve_transaction_version({"transactionVersions": advertised})


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

    def test_ignores_malformed_value(self):
        server = ExactSvmServerScheme()
        kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network=SOLANA_DEVNET_CAIP2,
            extra={"feePayer": FEE_PAYER, "transactionVersions": "0"},
        )
        result = server.enhance_payment_requirements(self._requirements(), kind, [])
        assert result.extra is not None
        assert "transactionVersions" not in result.extra


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

    solders 0.27 cannot decode a real version 1 wire transaction, so the
    reported version is patched to simulate an SDK that can.
    """

    @staticmethod
    def _v2_pair(tx: VersionedTransaction) -> tuple[PaymentPayload, PaymentRequirements]:
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
            payload={"transaction": _tx_base64(tx)},
        )
        return payload, requirements

    @staticmethod
    def _v1_pair(tx: VersionedTransaction) -> tuple[PaymentPayloadV1, PaymentRequirementsV1]:
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
            payload={"transaction": _tx_base64(tx)},
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

    @pytest.mark.parametrize("build", [_legacy_tx, _v0_tx], ids=["legacy", "v0"])
    def test_v1_verify_passes_gate_for_accepted_versions(self, build):
        facilitator = ExactSvmSchemeV1Facilitator(MockFacilitatorSigner())
        payload, requirements = self._v1_pair(build())
        result = facilitator.verify(payload, requirements)
        assert result.is_valid is False
        assert result.invalid_reason != ERR_UNSUPPORTED_TRANSACTION_VERSION
