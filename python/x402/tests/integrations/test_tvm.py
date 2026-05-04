"""TVM integration tests for x402ClientSync, x402ResourceServerSync, and x402FacilitatorSync.

These tests perform REAL blockchain transactions on TON testnet using sync classes.

Required environment variables:
- TVM_CLIENT_PRIVATE_KEY: TON private key used for the payer W5 wallet
- TVM_FACILITATOR_PRIVATE_KEY: TON private key used for the facilitator highload wallet
- TONCENTER_API_KEY: Toncenter API key for TON when TVM_PROVIDER is toncenter
- TONAPI_API_KEY: TonAPI API key when TVM_PROVIDER is tonapi

For backward compatibility, if the split variables are not set the tests fall back to
`TVM_PRIVATE_KEY` for both roles.

Optional environment variables:
- TVM_PROVIDER: TVM RPC provider, "toncenter" by default; set to "tonapi" for TonAPI
- TONCENTER_BASE_URL: custom Toncenter base URL
- TONAPI_BASE_URL: custom TonAPI base URL
- TVM_SECOND_CLIENT_PRIVATE_KEY: second funded W5 client used by the live batch-settlement test

These must correspond to funded testnet wallets with TON and USDT.
"""

from __future__ import annotations

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

pytest.importorskip("pytoniq_core")

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.tvm import (
    SCHEME_EXACT,
    TVM_PROVIDER_TONAPI,
    TVM_PROVIDER_TONCENTER,
    TVM_TESTNET,
    USDT_TESTNET_MINTER,
    ExactTvmPayload,
    FacilitatorHighloadV3Signer,
    HighloadV3Config,
    WalletV5R1Config,
    WalletV5R1MnemonicSigner,
    create_tvm_provider_client,
    parse_exact_tvm_payload,
)
from x402.mechanisms.tvm.constants import (
    ERR_EXACT_TVM_DUPLICATE_SETTLEMENT as ERR_DUPLICATE_SETTLEMENT,
)
from x402.mechanisms.tvm.constants import (
    ERR_EXACT_TVM_INVALID_AMOUNT,
    ERR_EXACT_TVM_INVALID_RECIPIENT,
)
from x402.mechanisms.tvm.constants import (
    ERR_EXACT_TVM_INVALID_SEQNO as ERR_INVALID_SEQNO,
)
from x402.mechanisms.tvm.exact import (
    ExactTvmClientScheme,
    ExactTvmFacilitatorScheme,
    ExactTvmServerScheme,
)
from x402.mechanisms.tvm.provider import TvmProviderClient
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceConfig,
    ResourceInfo,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)

TVM_PRIVATE_KEY = os.environ.get("TVM_PRIVATE_KEY")
TVM_CLIENT_PRIVATE_KEY = os.environ.get("TVM_CLIENT_PRIVATE_KEY", TVM_PRIVATE_KEY)
TVM_SECOND_CLIENT_PRIVATE_KEY = os.environ.get("TVM_SECOND_CLIENT_PRIVATE_KEY")
TVM_FACILITATOR_PRIVATE_KEY = os.environ.get("TVM_FACILITATOR_PRIVATE_KEY", TVM_PRIVATE_KEY)
TONCENTER_API_KEY = os.environ.get("TONCENTER_API_KEY")
TONCENTER_BASE_URL = os.environ.get("TONCENTER_BASE_URL")
TONAPI_API_KEY = os.environ.get("TONAPI_API_KEY")
TONAPI_BASE_URL = os.environ.get("TONAPI_BASE_URL")
TVM_PROVIDER = os.environ.get("TVM_PROVIDER", TVM_PROVIDER_TONCENTER).lower()
TVM_PROVIDER_API_KEY = TONAPI_API_KEY if TVM_PROVIDER == TVM_PROVIDER_TONAPI else TONCENTER_API_KEY
TVM_PROVIDER_BASE_URL = (
    TONAPI_BASE_URL if TVM_PROVIDER == TVM_PROVIDER_TONAPI else TONCENTER_BASE_URL
)

TEST_PAYMENT_AMOUNT = "1000"  # 0.001 USDT with 6 decimals
MIN_FACILITATOR_TON_BALANCE = 1_000_000_000
MIN_CLIENT_USDT_BALANCE = int(TEST_PAYMENT_AMOUNT)

pytestmark = pytest.mark.skipif(
    not TVM_CLIENT_PRIVATE_KEY
    or not TVM_FACILITATOR_PRIVATE_KEY
    or not TVM_PROVIDER_API_KEY
    or TVM_PROVIDER not in {TVM_PROVIDER_TONCENTER, TVM_PROVIDER_TONAPI},
    reason=(
        "TVM_CLIENT_PRIVATE_KEY (or TVM_PRIVATE_KEY), TVM_FACILITATOR_PRIVATE_KEY "
        "(or TVM_PRIVATE_KEY), a supported TVM_PROVIDER, and the provider API key "
        "(TONCENTER_API_KEY or TONAPI_API_KEY) are required for TVM integration tests"
    ),
)


class TvmFacilitatorClientSync:
    """Facilitator client wrapper for x402ResourceServerSync."""

    scheme = SCHEME_EXACT
    network = TVM_TESTNET
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync):
        self._facilitator = facilitator

    def verify(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> VerifyResponse:
        return self._facilitator.verify(payload, requirements)

    def settle(
        self,
        payload: PaymentPayload,
        requirements: PaymentRequirements,
    ) -> SettleResponse:
        return self._facilitator.settle(payload, requirements)

    def get_supported(self) -> SupportedResponse:
        return self._facilitator.get_supported()


def build_tvm_payment_requirements(
    pay_to: str,
    amount: str,
    network: str = TVM_TESTNET,
    asset: str = USDT_TESTNET_MINTER,
) -> PaymentRequirements:
    """Build TVM payment requirements for testing."""
    return PaymentRequirements(
        scheme=SCHEME_EXACT,
        network=network,
        asset=asset,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=300,
        extra={
            "decimals": 6,
            "areFeesSponsored": True,
        },
    )


def _wait_for_jetton_balance_at_least(
    provider: TvmProviderClient,
    jetton_wallet: str,
    expected_balance: int,
    *,
    timeout_seconds: float = 20.0,
) -> int:
    """Wait until the configured provider reflects a target jetton balance."""
    deadline = time.monotonic() + timeout_seconds
    last_balance = 0
    last_error: Exception | None = None

    while time.monotonic() < deadline:
        try:
            last_balance = provider.get_jetton_wallet_data(jetton_wallet).balance
            if last_balance >= expected_balance:
                return last_balance
        except Exception as exc:  # pragma: no cover - retry path for flaky RPC
            last_error = exc
        time.sleep(1.0)

    if last_error is not None:
        raise AssertionError(
            f"Timed out waiting for jetton balance update for {jetton_wallet}: {last_error}"
        ) from last_error
    raise AssertionError(
        f"Timed out waiting for jetton balance {expected_balance}, last balance {last_balance}"
    )


def _configure_client_provider(config: WalletV5R1Config) -> None:
    config.provider = TVM_PROVIDER
    config.api_key = TVM_PROVIDER_API_KEY
    config.provider_base_url = TVM_PROVIDER_BASE_URL


def _configure_facilitator_provider(config: HighloadV3Config) -> None:
    config.provider = TVM_PROVIDER
    config.api_key = TVM_PROVIDER_API_KEY
    config.provider_base_url = TVM_PROVIDER_BASE_URL


class TestTvmIntegrationV2:
    """Integration tests for TVM V2 payment flow with REAL blockchain transactions."""

    def setup_method(self) -> None:
        client_config = WalletV5R1Config.from_private_key(TVM_TESTNET, TVM_CLIENT_PRIVATE_KEY)
        _configure_client_provider(client_config)
        self.client_signer = WalletV5R1MnemonicSigner(client_config)

        facilitator_config = HighloadV3Config.from_private_key(TVM_FACILITATOR_PRIVATE_KEY)
        _configure_facilitator_provider(facilitator_config)
        self.facilitator_signer = FacilitatorHighloadV3Signer({TVM_TESTNET: facilitator_config})

        self.provider = create_tvm_provider_client(
            TVM_TESTNET,
            provider=TVM_PROVIDER,
            api_key=TVM_PROVIDER_API_KEY,
            base_url=TVM_PROVIDER_BASE_URL,
        )

        self.client_address = self.client_signer.address
        self.facilitator_address = self.facilitator_signer.get_addresses()[0]
        self.client_jetton_wallet = self.provider.get_jetton_wallet(
            USDT_TESTNET_MINTER,
            self.client_address,
        )
        self.facilitator_jetton_wallet = self.provider.get_jetton_wallet(
            USDT_TESTNET_MINTER,
            self.facilitator_address,
        )

        self.client = x402ClientSync().register(
            TVM_TESTNET,
            ExactTvmClientScheme(self.client_signer),
        )
        self.facilitator = x402FacilitatorSync().register(
            [TVM_TESTNET],
            ExactTvmFacilitatorScheme(
                self.facilitator_signer,
                batch_flush_interval_seconds=0.05,
                batch_flush_size=1,
            ),
        )

        facilitator_client = TvmFacilitatorClientSync(self.facilitator)
        self.server = x402ResourceServerSync(facilitator_client)
        self.server.register(TVM_TESTNET, ExactTvmServerScheme())
        self.server.initialize()

    def teardown_method(self) -> None:
        self.facilitator_signer.close()
        self.provider.close()

    def _require_live_balances(self) -> None:
        facilitator_state = self.provider.get_account_state(self.facilitator_address)
        client_jetton_balance = self.provider.get_jetton_wallet_data(
            self.client_jetton_wallet
        ).balance

        if facilitator_state.balance < MIN_FACILITATOR_TON_BALANCE:
            pytest.skip(
                "Facilitator wallet "
                f"{self.facilitator_address} needs at least {MIN_FACILITATOR_TON_BALANCE} nanotons"
            )
        if client_jetton_balance < MIN_CLIENT_USDT_BALANCE:
            pytest.skip(
                f"Client jetton wallet {self.client_jetton_wallet} needs at least {MIN_CLIENT_USDT_BALANCE} USDT units"
            )

    def _require_client_balances(self, address: str, jetton_wallet: str) -> None:
        client_jetton_balance = self.provider.get_jetton_wallet_data(jetton_wallet).balance

        if client_jetton_balance < MIN_CLIENT_USDT_BALANCE:
            pytest.skip(
                f"Client jetton wallet {jetton_wallet} needs at least {MIN_CLIENT_USDT_BALANCE} USDT units"
            )

    def test_server_should_successfully_verify_and_settle_tvm_payment_from_client(
        self,
    ) -> None:
        """Test the complete TVM V2 payment flow with REAL blockchain transactions."""
        self._require_live_balances()

        recipient_balance_before = self.provider.get_jetton_wallet_data(
            self.facilitator_jetton_wallet
        ).balance

        accepts = [
            build_tvm_payment_requirements(
                self.facilitator_address,
                TEST_PAYMENT_AMOUNT,
            )
        ]
        resource = ResourceInfo(
            url="https://api.example.com/premium",
            description="Premium API Access",
            mime_type="application/json",
        )
        payment_required = self.server.create_payment_required_response(accepts, resource)

        assert payment_required.x402_version == 2

        payment_payload = self.client.create_payment_payload(payment_required)

        assert payment_payload.x402_version == 2
        assert payment_payload.accepted.scheme == SCHEME_EXACT
        assert payment_payload.accepted.network == TVM_TESTNET
        assert "settlementBoc" in payment_payload.payload
        assert "asset" in payment_payload.payload

        accepted = self.server.find_matching_requirements(accepts, payment_payload)
        assert accepted is not None

        verify_response = self.server.verify_payment(payment_payload, accepted)
        if not verify_response.is_valid:
            print(f"❌ Verification failed: {verify_response.invalid_reason}")
            print(f"Payer: {verify_response.payer}")
            print(f"Client address: {self.client_address}")

        assert verify_response.is_valid is True
        assert verify_response.payer == self.client_address

        settle_response = self.server.settle_payment(payment_payload, accepted)
        if not settle_response.success:
            print(f"❌ Settlement failed: {settle_response.error_reason}")
            if settle_response.transaction:
                print(f"📋 Trace message hash: {settle_response.transaction}")

        assert settle_response.success is True
        assert settle_response.network == TVM_TESTNET
        assert settle_response.transaction != ""
        assert settle_response.payer == self.client_address

        recipient_balance_after = _wait_for_jetton_balance_at_least(
            self.provider,
            self.facilitator_jetton_wallet,
            recipient_balance_before + int(TEST_PAYMENT_AMOUNT),
        )
        assert recipient_balance_after >= recipient_balance_before + int(TEST_PAYMENT_AMOUNT)

    def test_server_should_batch_two_tvm_settlements_into_one_external_message(self, monkeypatch):
        """Test live facilitator batching with two funded W5 clients.

        TVM W5 wallets require each signed settlement to use the wallet's current on-chain seqno.
        Because of that, a live batch cannot use two distinct settlements from the same payer wallet:
        the second relay would hit a seqno mismatch after the first one executes. This test uses two
        funded payer wallets to exercise the facilitator's batch-relay path on TON testnet.
        """
        self._require_live_balances()
        if not TVM_SECOND_CLIENT_PRIVATE_KEY:
            pytest.skip("TVM_SECOND_CLIENT_PRIVATE_KEY is required for the live TVM batch test")

        second_client_config = WalletV5R1Config.from_private_key(
            TVM_TESTNET,
            TVM_SECOND_CLIENT_PRIVATE_KEY,
        )
        _configure_client_provider(second_client_config)
        second_client_signer = WalletV5R1MnemonicSigner(second_client_config)
        second_client = x402ClientSync().register(
            TVM_TESTNET,
            ExactTvmClientScheme(second_client_signer),
        )
        second_client_address = second_client_signer.address
        if second_client_address == self.client_address:
            pytest.skip(
                "TVM_SECOND_CLIENT_PRIVATE_KEY must point to a different funded W5 client wallet"
            )
        second_client_jetton_wallet = self.provider.get_jetton_wallet(
            USDT_TESTNET_MINTER,
            second_client_address,
        )
        self._require_client_balances(second_client_address, second_client_jetton_wallet)

        facilitator = x402FacilitatorSync().register(
            [TVM_TESTNET],
            ExactTvmFacilitatorScheme(
                self.facilitator_signer,
                batch_flush_interval_seconds=5.0,
                batch_flush_size=2,
            ),
        )
        facilitator_client = TvmFacilitatorClientSync(facilitator)
        server = x402ResourceServerSync(facilitator_client)
        server.register(TVM_TESTNET, ExactTvmServerScheme())
        server.initialize()

        batch_build_calls: list[tuple[str, list[str], bool]] = []
        send_calls: list[str] = []
        original_build_batch = self.facilitator_signer.build_relay_external_boc_batch
        original_send_message = self.facilitator_signer.send_external_message

        def build_batch_spy(network: str, relay_requests: list, *, for_emulation: bool = False):
            batch_build_calls.append(
                (
                    network,
                    [relay_request.destination for relay_request in relay_requests],
                    for_emulation,
                )
            )
            return original_build_batch(
                network,
                relay_requests,
                for_emulation=for_emulation,
            )

        def send_message_spy(network: str, external_boc: bytes) -> str:
            send_calls.append(network)
            return original_send_message(network, external_boc)

        monkeypatch.setattr(
            self.facilitator_signer,
            "build_relay_external_boc_batch",
            build_batch_spy,
        )
        monkeypatch.setattr(
            self.facilitator_signer,
            "send_external_message",
            send_message_spy,
        )

        recipient_balance_before = self.provider.get_jetton_wallet_data(
            self.facilitator_jetton_wallet
        ).balance

        accepts = [
            build_tvm_payment_requirements(
                self.facilitator_address,
                TEST_PAYMENT_AMOUNT,
            )
        ]
        payment_required = server.create_payment_required_response(accepts)
        first_payload = self.client.create_payment_payload(payment_required)
        second_payload = second_client.create_payment_payload(payment_required)

        first_accepted = server.find_matching_requirements(accepts, first_payload)
        second_accepted = server.find_matching_requirements(accepts, second_payload)
        assert first_accepted is not None
        assert second_accepted is not None

        first_verify = server.verify_payment(first_payload, first_accepted)
        second_verify = server.verify_payment(second_payload, second_accepted)
        assert first_verify.is_valid is True
        assert first_verify.payer == self.client_address
        assert second_verify.is_valid is True
        assert second_verify.payer == second_client_address

        start_barrier = threading.Barrier(2)

        def settle_payment(
            payload: PaymentPayload, accepted: PaymentRequirements
        ) -> SettleResponse:
            start_barrier.wait(timeout=15.0)
            return server.settle_payment(payload, accepted)

        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(settle_payment, first_payload, first_accepted)
            second_future = executor.submit(settle_payment, second_payload, second_accepted)
            first_settle = first_future.result(timeout=180.0)
            second_settle = second_future.result(timeout=180.0)

        assert first_settle.success is True
        assert first_settle.transaction != ""
        assert first_settle.payer == self.client_address
        assert second_settle.success is True
        assert second_settle.transaction != ""
        assert second_settle.payer == second_client_address

        settlement_batch_build_calls = [
            (network, destinations)
            for network, destinations, for_emulation in batch_build_calls
            if for_emulation is False
        ]
        assert len(settlement_batch_build_calls) == 1
        assert settlement_batch_build_calls[0][0] == TVM_TESTNET
        assert len(settlement_batch_build_calls[0][1]) == 2
        assert set(settlement_batch_build_calls[0][1]) == {
            self.client_address,
            second_client_address,
        }
        assert send_calls == [TVM_TESTNET]

        recipient_balance_after = _wait_for_jetton_balance_at_least(
            self.provider,
            self.facilitator_jetton_wallet,
            recipient_balance_before + (2 * int(TEST_PAYMENT_AMOUNT)),
        )
        assert recipient_balance_after >= recipient_balance_before + (2 * int(TEST_PAYMENT_AMOUNT))

    def test_client_creates_valid_tvm_payment_payload(self) -> None:
        """Test that client creates properly structured TVM payload."""
        self._require_live_balances()

        accepts = [
            build_tvm_payment_requirements(
                self.facilitator_address,
                "5000000",
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)

        payload = self.client.create_payment_payload(payment_required)

        assert payload.x402_version == 2
        assert payload.accepted.scheme == SCHEME_EXACT
        assert payload.accepted.amount == "5000000"
        assert payload.accepted.network == TVM_TESTNET

        tvm_payload = ExactTvmPayload.from_dict(payload.payload)
        settlement = parse_exact_tvm_payload(tvm_payload.settlement_boc)

        assert tvm_payload.asset == USDT_TESTNET_MINTER
        assert settlement.payer == self.client_address
        assert settlement.state_init is None
        assert settlement.transfer.destination == self.facilitator_address
        assert settlement.transfer.response_destination is None
        assert settlement.transfer.jetton_amount == 5_000_000
        assert settlement.transfer.forward_ton_amount == 0
        assert settlement.transfer.source_wallet == self.client_jetton_wallet

    def test_invalid_recipient_fails_verification(self) -> None:
        """Test that mismatched recipient fails verification."""
        self._require_live_balances()

        accepts = [
            build_tvm_payment_requirements(
                self.facilitator_address,
                TEST_PAYMENT_AMOUNT,
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)

        different_accepts = [
            build_tvm_payment_requirements(
                self.client_address,
                TEST_PAYMENT_AMOUNT,
            )
        ]

        verify_response = self.server.verify_payment(payload, different_accepts[0])
        assert verify_response.is_valid is False
        assert verify_response.invalid_reason == ERR_EXACT_TVM_INVALID_RECIPIENT

    def test_insufficient_amount_fails_verification(self) -> None:
        """Test that insufficient amount fails verification."""
        self._require_live_balances()

        accepts = [
            build_tvm_payment_requirements(
                self.facilitator_address,
                TEST_PAYMENT_AMOUNT,
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)

        higher_accepts = [
            build_tvm_payment_requirements(
                self.facilitator_address,
                "2000",
            )
        ]

        verify_response = self.server.verify_payment(payload, higher_accepts[0])
        assert verify_response.is_valid is False
        assert verify_response.invalid_reason == ERR_EXACT_TVM_INVALID_AMOUNT

    def test_duplicate_settlement_fails_on_second_attempt(self) -> None:
        """Test that settling the same payload twice is rejected as duplicate."""
        self._require_live_balances()

        accepts = [
            build_tvm_payment_requirements(
                self.facilitator_address,
                TEST_PAYMENT_AMOUNT,
            )
        ]
        payment_required = self.server.create_payment_required_response(accepts)
        payload = self.client.create_payment_payload(payment_required)
        accepted = self.server.find_matching_requirements(accepts, payload)
        assert accepted is not None

        first_settle = self.server.settle_payment(payload, accepted)
        assert first_settle.success is True

        second_settle = self.server.settle_payment(payload, accepted)
        assert second_settle.success is False
        assert second_settle.error_reason in {
            ERR_DUPLICATE_SETTLEMENT,
            ERR_INVALID_SEQNO,
        }

    def test_facilitator_get_supported(self) -> None:
        """Test that facilitator returns supported kinds."""
        supported = self.facilitator.get_supported()

        tvm_support = None
        for kind in supported.kinds:
            if kind.network == TVM_TESTNET and kind.scheme == SCHEME_EXACT:
                tvm_support = kind
                break

        assert tvm_support is not None
        assert tvm_support.x402_version == 2
        assert tvm_support.extra is not None
        assert tvm_support.extra.get("areFeesSponsored") is True


class TestTvmPriceParsing:
    """Tests for TVM server price parsing via resource-server integration."""

    def setup_method(self) -> None:
        facilitator_config = HighloadV3Config.from_private_key(TVM_FACILITATOR_PRIVATE_KEY)
        _configure_facilitator_provider(facilitator_config)
        self.facilitator_signer = FacilitatorHighloadV3Signer({TVM_TESTNET: facilitator_config})
        self.facilitator_address = self.facilitator_signer.get_addresses()[0]

        self.facilitator = x402FacilitatorSync().register(
            [TVM_TESTNET],
            ExactTvmFacilitatorScheme(self.facilitator_signer),
        )

        facilitator_client = TvmFacilitatorClientSync(self.facilitator)
        self.server = x402ResourceServerSync(facilitator_client)
        self.tvm_server = ExactTvmServerScheme()
        self.server.register(TVM_TESTNET, self.tvm_server)
        self.server.initialize()

    def teardown_method(self) -> None:
        self.facilitator_signer.close()

    def test_parse_money_formats(self) -> None:
        test_cases = [
            ("$1.00", "1000000"),
            ("1.50", "1500000"),
            (2.5, "2500000"),
            ("$0.001", "1000"),
        ]

        for input_price, expected_amount in test_cases:
            config = ResourceConfig(
                scheme=SCHEME_EXACT,
                pay_to=self.facilitator_address,
                price=input_price,
                network=TVM_TESTNET,
            )
            requirements = self.server.build_payment_requirements(config)

            assert len(requirements) == 1
            assert requirements[0].amount == expected_amount
            assert requirements[0].asset == USDT_TESTNET_MINTER
            assert requirements[0].extra.get("areFeesSponsored") is True

    def test_asset_amount_passthrough(self) -> None:
        from x402.schemas import AssetAmount

        custom_asset = AssetAmount(
            amount="5000000",
            asset="0:" + "a" * 64,
            extra={"foo": "bar"},
        )

        config = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to=self.facilitator_address,
            price=custom_asset,
            network=TVM_TESTNET,
        )
        requirements = self.server.build_payment_requirements(config)

        assert len(requirements) == 1
        assert requirements[0].amount == "5000000"
        assert requirements[0].asset == "0:" + "a" * 64
        assert requirements[0].extra == {
            "foo": "bar",
            "areFeesSponsored": True,
        }

    def test_custom_money_parser(self) -> None:
        from x402.schemas import AssetAmount

        def large_amount_parser(amount: float, network: str):
            if amount > 100:
                return AssetAmount(
                    amount=str(int(amount * 1_000_000_000)),
                    asset="0:" + "b" * 64,
                    extra={"token": "LARGE", "tier": "large"},
                )
            return None

        self.tvm_server.register_money_parser(large_amount_parser)

        large_config = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to=self.facilitator_address,
            price=150,
            network=TVM_TESTNET,
        )
        large_req = self.server.build_payment_requirements(large_config)

        assert large_req[0].asset == "0:" + "b" * 64
        assert large_req[0].extra.get("token") == "LARGE"
        assert large_req[0].extra.get("tier") == "large"

        small_config = ResourceConfig(
            scheme=SCHEME_EXACT,
            pay_to=self.facilitator_address,
            price=50,
            network=TVM_TESTNET,
        )
        small_req = self.server.build_payment_requirements(small_config)

        assert small_req[0].asset == USDT_TESTNET_MINTER
