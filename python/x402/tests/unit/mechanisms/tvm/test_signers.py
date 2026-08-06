"""Tests for TVM signer implementations."""

from __future__ import annotations

import base64
import threading

import pytest

pytest.importorskip("pytoniq_core")

from x402.mechanisms.tvm import (
    TVM_MAINNET,
    TVM_PROVIDER_TONAPI,
    TVM_TESTNET,
    TonapiRestClient,
)
from x402.mechanisms.tvm.constants import (
    DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS,
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
)
from x402.mechanisms.tvm.signers import (
    FacilitatorHighloadV3Signer,
    HighloadV3Config,
    WalletV5R1Config,
    WalletV5R1MnemonicSigner,
)
from x402.mechanisms.tvm.types import TvmAccountState

from .builders import TEST_MNEMONIC, derive_test_secret_key
from .helpers import start_captured_thread


class TestWalletV5R1Config:
    @pytest.mark.parametrize(
        ("private_key", "factory"),
        [
            pytest.param(
                lambda secret_key, seed: secret_key.hex(),
                lambda private_key: WalletV5R1Config.from_private_key(TVM_TESTNET, private_key),
                id="hex-64",
            ),
            pytest.param(
                lambda secret_key, seed: seed.hex(),
                lambda private_key: WalletV5R1Config.from_private_key(TVM_TESTNET, private_key),
                id="hex-32",
            ),
            pytest.param(
                lambda secret_key, seed: base64.b64encode(secret_key).decode(),
                lambda private_key: WalletV5R1Config.from_private_key(TVM_TESTNET, private_key),
                id="base64-64",
            ),
            pytest.param(
                lambda secret_key, seed: base64.b64encode(seed).decode(),
                lambda private_key: WalletV5R1Config.from_private_key(TVM_TESTNET, private_key),
                id="base64-32",
            ),
        ],
    )
    def test_from_private_key_should_accept_hex_and_base64_seed_or_secret_key(
        self, private_key, factory
    ):
        secret_key = derive_test_secret_key()
        seed = secret_key[:32]

        config = factory(private_key(secret_key, seed))

        assert config.secret_key == secret_key
        assert config.network == TVM_TESTNET

    def test_from_private_key_should_reject_invalid_input(self):
        with pytest.raises(ValueError, match="valid hex or base64"):
            WalletV5R1Config.from_private_key(TVM_TESTNET, "not-a-key")


class TestWalletV5R1MnemonicSigner:
    def test_should_expose_network_wallet_id_state_init_and_address(self):
        config = WalletV5R1Config.from_mnemonic(TVM_TESTNET, TEST_MNEMONIC)
        config.provider = TVM_PROVIDER_TONAPI
        config.provider_base_url = "https://tonapi.local"

        signer = WalletV5R1MnemonicSigner(config)

        assert signer.network == TVM_TESTNET
        assert signer.provider == TVM_PROVIDER_TONAPI
        assert signer.provider_base_url == "https://tonapi.local"
        assert signer.wallet_id > 0
        assert signer.state_init is not None
        assert signer.address.startswith("0:")
        assert len(signer.address) == 66

    def test_sign_message_should_return_ed25519_signature(self):
        config = WalletV5R1Config.from_mnemonic(TVM_TESTNET, TEST_MNEMONIC)
        signer = WalletV5R1MnemonicSigner(config)

        signature = signer.sign_message(b"message-hash")

        assert isinstance(signature, bytes)
        assert len(signature) == 64


class TestHighloadV3Config:
    @pytest.mark.parametrize(
        ("private_key", "factory"),
        [
            pytest.param(
                lambda secret_key, seed: secret_key.hex(),
                lambda private_key: HighloadV3Config.from_private_key(private_key),
                id="hex-64",
            ),
            pytest.param(
                lambda secret_key, seed: seed.hex(),
                lambda private_key: HighloadV3Config.from_private_key(private_key),
                id="hex-32",
            ),
        ],
    )
    def test_from_private_key_should_accept_hex_seed_or_secret_key(self, private_key, factory):
        secret_key = derive_test_secret_key()
        seed = secret_key[:32]

        config = factory(private_key(secret_key, seed))

        assert config.secret_key == secret_key


class TestFacilitatorHighloadV3Signer:
    def test_get_addresses_for_network_should_return_only_requested_wallet(self):
        secret_key = derive_test_secret_key()
        signer = FacilitatorHighloadV3Signer(
            {
                TVM_TESTNET: HighloadV3Config(secret_key=secret_key, subwallet_id=1),
                TVM_MAINNET: HighloadV3Config(secret_key=secret_key, subwallet_id=2),
            }
        )

        testnet_addresses = signer.get_addresses_for_network(TVM_TESTNET)
        mainnet_addresses = signer.get_addresses_for_network(TVM_MAINNET)

        assert len(testnet_addresses) == 1
        assert len(mainnet_addresses) == 1
        assert testnet_addresses != mainnet_addresses
        assert signer.get_addresses() == testnet_addresses + mainnet_addresses

    def test_wait_for_trace_confirmation_fetches_full_trace_after_stream_signal(self, monkeypatch):
        secret_key = derive_test_secret_key()
        signer = FacilitatorHighloadV3Signer(
            {
                TVM_TESTNET: HighloadV3Config(
                    secret_key=secret_key,
                )
            }
        )
        stream_calls: list[tuple[str, float]] = []
        trace_calls: list[str] = []
        expected_trace = {
            "trace_id": "trace-id-1",
            "transactions": {
                "tx-1": {
                    "account": "0:" + "1" * 64,
                }
            },
        }

        class _FakeStreamingClient:
            def wait_for_trace_confirmation(
                self, *, trace_external_hash_norm: str, timeout_seconds: float
            ):
                stream_calls.append((trace_external_hash_norm, timeout_seconds))
                return {
                    "type": "transactions",
                    "finality": "finalized",
                    "trace_external_hash_norm": trace_external_hash_norm,
                }

        class _FakeProviderClient:
            def get_trace_by_message_hash(self, trace_external_hash_norm: str):
                trace_calls.append(trace_external_hash_norm)
                return expected_trace

        monkeypatch.setattr(signer, "_ensure_streaming_watcher", lambda network: True)
        monkeypatch.setattr(signer, "_streaming_client", lambda network: _FakeStreamingClient())
        monkeypatch.setattr(signer, "_client", lambda network: _FakeProviderClient())

        result = signer.wait_for_trace_confirmation(
            TVM_TESTNET,
            "trace-hash-1",
            timeout_seconds=12.5,
        )

        assert len(stream_calls) == 1
        assert stream_calls[0][0] == "trace-hash-1"
        assert stream_calls[0][1] == pytest.approx(
            DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS, abs=0.1
        )
        assert trace_calls == ["trace-hash-1"]
        assert result == expected_trace

    def test_wait_for_trace_confirmation_uses_remaining_budget_for_rest_after_stream_timeout(
        self, monkeypatch
    ):
        secret_key = derive_test_secret_key()
        signer = FacilitatorHighloadV3Signer(
            {
                TVM_TESTNET: HighloadV3Config(
                    secret_key=secret_key,
                )
            }
        )
        stream_calls: list[tuple[str, float]] = []
        trace_calls: list[str] = []
        fake_now = 100.0
        expected_trace = {
            "trace_id": "trace-id-1",
            "transactions": {
                "tx-1": {
                    "account": "0:" + "1" * 64,
                }
            },
        }

        class _FakeStreamingClient:
            def wait_for_trace_confirmation(
                self, *, trace_external_hash_norm: str, timeout_seconds: float
            ):
                nonlocal fake_now
                stream_calls.append((trace_external_hash_norm, timeout_seconds))
                fake_now += timeout_seconds
                raise RuntimeError("stream timeout")

        class _FakeProviderClient:
            def get_trace_by_message_hash(self, trace_external_hash_norm: str):
                trace_calls.append(trace_external_hash_norm)
                return expected_trace

        monkeypatch.setattr(signer, "_ensure_streaming_watcher", lambda network: True)
        monkeypatch.setattr(signer, "_streaming_client", lambda network: _FakeStreamingClient())
        monkeypatch.setattr(signer, "_client", lambda network: _FakeProviderClient())
        monkeypatch.setattr("x402.mechanisms.tvm.signers.time.monotonic", lambda: fake_now)
        monkeypatch.setattr("x402.mechanisms.tvm.signers.time.sleep", lambda seconds: None)

        result = signer.wait_for_trace_confirmation(
            TVM_TESTNET,
            "trace-hash-1",
            timeout_seconds=12.5,
        )

        assert len(stream_calls) == 1
        assert stream_calls[0][0] == "trace-hash-1"
        assert stream_calls[0][1] == pytest.approx(
            DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS, abs=0.1
        )
        assert fake_now == pytest.approx(
            100.0 + DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS, abs=0.1
        )
        assert trace_calls == ["trace-hash-1"]
        assert result == expected_trace

    def test_emulate_external_message_uses_emulation_timeout(self, monkeypatch):
        secret_key = derive_test_secret_key()
        signer = FacilitatorHighloadV3Signer(
            {
                TVM_TESTNET: HighloadV3Config(
                    secret_key=secret_key,
                    provider_emulation_timeout_seconds=17.5,
                )
            }
        )
        emulate_calls: list[tuple[bytes, float]] = []

        class _FakeProviderClient:
            def emulate_trace(self, boc: bytes, *, ignore_chksig: bool = False, timeout: float):
                assert ignore_chksig is False
                emulate_calls.append((boc, timeout))
                return {"transactions": {}}

        monkeypatch.setattr(signer, "_client", lambda network: _FakeProviderClient())

        result = signer.emulate_external_message(TVM_TESTNET, b"external-boc")

        assert result == {"transactions": {}}
        assert emulate_calls == [(b"external-boc", 17.5)]

    def test_wallet_config_defaults_emulation_timeout(self):
        config = WalletV5R1Config.from_mnemonic(TVM_TESTNET, TEST_MNEMONIC)

        assert config.provider_emulation_timeout_seconds == (
            DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS
        )

    def test_client_and_streaming_client_should_use_tonapi_provider(self):
        secret_key = derive_test_secret_key()
        signer = FacilitatorHighloadV3Signer(
            {
                TVM_TESTNET: HighloadV3Config(
                    secret_key=secret_key,
                    provider=" TonAPI ",
                    provider_base_url="https://tonapi.local",
                )
            }
        )

        try:
            provider_client = signer._client(TVM_TESTNET)
            streaming_client = signer._streaming_client(TVM_TESTNET)

            assert isinstance(provider_client, TonapiRestClient)
            assert str(provider_client._client.base_url).rstrip("/") == "https://tonapi.local"
            assert streaming_client._base_url == "https://tonapi.local"
            assert streaming_client._sse_path == "/streaming/v2/sse"
        finally:
            signer.close()

    def test_select_query_id_fetches_account_state_outside_lock(self, monkeypatch):
        secret_key = derive_test_secret_key()
        signer = FacilitatorHighloadV3Signer(
            {
                TVM_TESTNET: HighloadV3Config(
                    secret_key=secret_key,
                )
            }
        )

        class _TrackingLock:
            def __init__(self) -> None:
                self._lock = threading.RLock()
                self.depth = 0

            def __enter__(self):
                self._lock.acquire()
                self.depth += 1
                return self

            def __exit__(self, exc_type, exc, tb):
                self.depth -= 1
                self._lock.release()

        tracking_lock = _TrackingLock()
        signer._lock = tracking_lock
        account_state_lock_depths: list[int] = []

        def _get_account_state(address: str, network: str) -> TvmAccountState:
            account_state_lock_depths.append(tracking_lock.depth)
            return TvmAccountState(
                address=address,
                balance=0,
                is_active=False,
                is_uninitialized=True,
                is_frozen=False,
                state_init=None,
            )

        monkeypatch.setattr(signer, "get_account_state", _get_account_state)

        query_id = signer._select_query_id(TVM_TESTNET, for_emulation=False)

        assert account_state_lock_depths == [0]
        assert query_id >= 0

    def test_ensure_streaming_watcher_starts_only_one_sse_connection(self, monkeypatch):
        secret_key = derive_test_secret_key()
        signer = FacilitatorHighloadV3Signer(
            {
                TVM_TESTNET: HighloadV3Config(
                    secret_key=secret_key,
                )
            }
        )
        start_entered = threading.Event()
        allow_finish = threading.Event()
        start_calls = 0
        results: list[bool] = []

        class _FakeWatcher:
            def is_alive(self) -> bool:
                return True

        class _FakeStreamingClient:
            def start_account_state_watcher(self, *, address: str, on_invalidate):
                nonlocal start_calls
                _ = on_invalidate
                assert address == signer.get_addresses_for_network(TVM_TESTNET)[0]
                start_calls += 1
                start_entered.set()
                assert allow_finish.wait(timeout=1.0)
                return _FakeWatcher()

        monkeypatch.setattr(signer, "_streaming_client", lambda network: _FakeStreamingClient())

        first = start_captured_thread(
            lambda: results.append(signer._ensure_streaming_watcher(TVM_TESTNET))
        )
        assert start_entered.wait(timeout=1.0)
        second = start_captured_thread(
            lambda: results.append(signer._ensure_streaming_watcher(TVM_TESTNET))
        )
        allow_finish.set()

        first.join()
        second.join()

        assert start_calls == 1
        assert results == [True, True]
