"""Concrete TVM signer implementations."""

from __future__ import annotations

import base64
import binascii
import threading
import time
from dataclasses import dataclass
from secrets import randbelow

from .codecs.common import normalize_address
from .codecs.highload_v3 import (
    MAX_USABLE_QUERY_SEQNO,
    load_highload_query_state,
    query_id_is_processed,
    seqno_to_query_id,
    serialize_internal_transfer,
)
from .codecs.w5 import (
    address_from_state_init,
    build_w5r1_state_init,
    make_w5r1_wallet_id,
    serialize_out_list,
    serialize_send_msg_action,
)
from .constants import (
    DEFAULT_HIGHLOAD_SUBWALLET_ID,
    DEFAULT_HIGHLOAD_TIMEOUT,
    DEFAULT_RELAY_AMOUNT,
    DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS,
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    DEFAULT_TONCENTER_TIMEOUT_SECONDS,
    DEFAULT_W5R1_SUBWALLET_NUMBER,
    HIGHLOAD_V3_CODE_HASH,
    HIGHLOAD_V3_CODE_HEX,
    TVM_PROVIDER_TONCENTER,
)
from .provider import (
    TvmProviderClient,
    _default_base_url,
    create_tvm_provider_client,
)
from .streaming import TvmStreamingSseClient, TvmStreamingWatcher
from .types import TvmAccountState, TvmJettonWalletData, TvmRelayRequest

try:
    from nacl.signing import SigningKey
    from pytoniq.contract.contract import Contract
    from pytoniq_core import Address, Cell, begin_cell
    from pytoniq_core.crypto.keys import mnemonic_to_wallet_key, private_key_to_public_key
    from pytoniq_core.crypto.signature import sign_message
    from pytoniq_core.tlb.account import StateInit
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


DEFAULT_TRACE_FETCH_BACKOFF_SECONDS = 0.5


def _normalize_private_key_bytes(private_key: bytes) -> bytes:
    """Normalize a TVM private key to the 64-byte secret key format used by pytoniq."""
    if len(private_key) == 64:
        return private_key
    if len(private_key) == 32:
        return private_key + SigningKey(private_key).verify_key.encode()
    raise ValueError("TVM private key must be 32 bytes (seed) or 64 bytes (secret key)")


def _parse_private_key(private_key: str | bytes) -> bytes:
    """Parse a TVM private key from raw bytes, hex, or base64 text."""
    if isinstance(private_key, bytes):
        return _normalize_private_key_bytes(private_key)

    value = private_key.strip()
    if value.startswith("0x"):
        value = value[2:]

    try:
        return _normalize_private_key_bytes(bytes.fromhex(value))
    except ValueError:
        pass

    try:
        return _normalize_private_key_bytes(base64.b64decode(value, validate=True))
    except (ValueError, binascii.Error) as exc:
        raise ValueError("TVM private key must be valid hex or base64") from exc


@dataclass
class HighloadV3Config:
    """Configuration for one facilitator wallet on a TVM network."""

    secret_key: bytes
    api_key: str | None = None
    subwallet_id: int = DEFAULT_HIGHLOAD_SUBWALLET_ID
    timeout: int = DEFAULT_HIGHLOAD_TIMEOUT
    relay_amount: int = DEFAULT_RELAY_AMOUNT
    provider_base_url: str | None = None
    provider_timeout_seconds: float = DEFAULT_TONCENTER_TIMEOUT_SECONDS
    provider_emulation_timeout_seconds: float = DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS
    workchain: int = 0
    provider: str = TVM_PROVIDER_TONCENTER

    @classmethod
    def from_mnemonic(
        cls,
        mnemonic: str | list[str],
        *,
        subwallet_id: int = DEFAULT_HIGHLOAD_SUBWALLET_ID,
        timeout: int = DEFAULT_HIGHLOAD_TIMEOUT,
        relay_amount: int = DEFAULT_RELAY_AMOUNT,
        workchain: int = 0,
    ) -> HighloadV3Config:
        """Create config from a TON mnemonic."""
        if isinstance(mnemonic, str):
            mnemonic = mnemonic.split()
        _, secret_key = mnemonic_to_wallet_key(mnemonic)
        return cls(
            secret_key=secret_key,
            subwallet_id=subwallet_id,
            timeout=timeout,
            relay_amount=relay_amount,
            workchain=workchain,
        )

    @classmethod
    def from_private_key(
        cls,
        private_key: str | bytes,
        *,
        subwallet_id: int = DEFAULT_HIGHLOAD_SUBWALLET_ID,
        timeout: int = DEFAULT_HIGHLOAD_TIMEOUT,
        relay_amount: int = DEFAULT_RELAY_AMOUNT,
        workchain: int = 0,
    ) -> HighloadV3Config:
        """Create config from a TVM private key."""
        return cls(
            secret_key=_parse_private_key(private_key),
            subwallet_id=subwallet_id,
            timeout=timeout,
            relay_amount=relay_amount,
            workchain=workchain,
        )


@dataclass
class WalletV5R1Config:
    """Configuration for one client-side W5R1 wallet."""

    network: str
    secret_key: bytes
    api_key: str | None = None
    provider_base_url: str | None = None
    subwallet_number: int = DEFAULT_W5R1_SUBWALLET_NUMBER
    provider_timeout_seconds: float = DEFAULT_TONCENTER_TIMEOUT_SECONDS
    provider_emulation_timeout_seconds: float = DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS
    workchain: int = 0
    provider: str = TVM_PROVIDER_TONCENTER

    @classmethod
    def from_mnemonic(
        cls,
        network: str,
        mnemonic: str | list[str],
        *,
        subwallet_number: int = DEFAULT_W5R1_SUBWALLET_NUMBER,
        workchain: int = 0,
    ) -> WalletV5R1Config:
        """Create config from a TON mnemonic."""
        if isinstance(mnemonic, str):
            mnemonic = mnemonic.split()
        _, secret_key = mnemonic_to_wallet_key(mnemonic)
        return cls(
            network=network,
            secret_key=secret_key,
            subwallet_number=subwallet_number,
            workchain=workchain,
        )

    @classmethod
    def from_private_key(
        cls,
        network: str,
        private_key: str | bytes,
        *,
        subwallet_number: int = DEFAULT_W5R1_SUBWALLET_NUMBER,
        workchain: int = 0,
    ) -> WalletV5R1Config:
        """Create config from a TVM private key."""
        return cls(
            network=network,
            secret_key=_parse_private_key(private_key),
            subwallet_number=subwallet_number,
            workchain=workchain,
        )


class WalletV5R1MnemonicSigner:
    """Client signer backed by a mnemonic-derived W5R1 wallet."""

    def __init__(self, config: WalletV5R1Config) -> None:
        self._config = config
        self._public_key = private_key_to_public_key(config.secret_key)
        self._wallet_id = make_w5r1_wallet_id(
            config.network,
            workchain=config.workchain,
            subwallet_number=config.subwallet_number,
        )
        self._state_init = build_w5r1_state_init(self._public_key, self._wallet_id)
        self._address = address_from_state_init(self._state_init, config.workchain)

    @property
    def address(self) -> str:
        return self._address

    @property
    def network(self) -> str:
        return self._config.network

    @property
    def api_key(self) -> str | None:
        return self._config.api_key

    @property
    def provider(self) -> str:
        return self._config.provider

    @property
    def provider_base_url(self) -> str | None:
        return self._config.provider_base_url

    @property
    def provider_timeout_seconds(self) -> float:
        return self._config.provider_timeout_seconds

    @property
    def provider_emulation_timeout_seconds(self) -> float:
        return self._config.provider_emulation_timeout_seconds

    @property
    def wallet_id(self) -> int:
        return self._wallet_id

    @property
    def state_init(self) -> StateInit:
        return self._state_init

    def sign_message(self, message: bytes) -> bytes:
        return sign_message(message, self._config.secret_key)


class FacilitatorHighloadV3Signer:
    """Facilitator signer backed by a highload-wallet-contract-v3 wallet."""

    def __init__(self, configs: dict[str, HighloadV3Config]) -> None:
        self._configs = dict(configs)
        self._clients: dict[str, TvmProviderClient] = {}
        self._streaming_clients: dict[str, TvmStreamingSseClient] = {}
        self._streaming_watchers: dict[str, TvmStreamingWatcher] = {}
        self._streaming_watcher_startups: dict[str, threading.Event] = {}
        self._cached_facilitator_states: dict[str, TvmAccountState] = {}
        self._facilitator_state_dirty: dict[str, bool] = {}
        self._wallets: dict[str, _WalletContext] = {}
        self._query_ids: dict[str, int] = {}
        self._lock = threading.RLock()

        for network, config in self._configs.items():
            context = _WalletContext.from_config(config)
            self._wallets[network] = context
            self._query_ids[network] = randbelow(MAX_USABLE_QUERY_SEQNO + 1)
            self._facilitator_state_dirty[network] = True

    def get_addresses(self) -> list[str]:
        """Get all facilitator wallet addresses."""
        return [wallet.address for wallet in self._wallets.values()]

    def get_addresses_for_network(self, network: str) -> list[str]:
        """Get facilitator wallet addresses for one TVM network."""
        wallet = self._wallets.get(network)
        if wallet is None:
            raise ValueError(f"Unsupported network: {network}")
        return [wallet.address]

    def close(self) -> None:
        """Close all provider clients and streaming watchers owned by this signer."""
        with self._lock:
            streaming_clients = list(self._streaming_clients.values())
            provider_clients = list(self._clients.values())
            self._streaming_watchers = {}
            self._streaming_clients = {}
            self._clients = {}

        for streaming_client in streaming_clients:
            try:
                streaming_client.close()
            except Exception:
                pass

        for provider_client in provider_clients:
            try:
                provider_client.close()
            except Exception:
                pass

    def get_account_state(self, address: str, network: str) -> TvmAccountState:
        """Get current account state."""
        normalized_address = normalize_address(address)
        if normalized_address == self._wallets[network].address:
            return self._get_facilitator_account_state(network)
        return self._client(network).get_account_state(address)

    def get_jetton_wallet(self, asset: str, owner: str, network: str) -> str:
        """Resolve the canonical TEP-74 jetton wallet for an owner."""
        return self._client(network).get_jetton_wallet(asset, owner)

    def build_relay_external_boc(
        self,
        network: str,
        relay_request: TvmRelayRequest,
        *,
        for_emulation: bool = False,
    ) -> bytes:
        """Build a Highload V3 external message for relaying the pre-signed W5 request."""
        return self.build_relay_external_boc_batch(
            network, [relay_request], for_emulation=for_emulation
        )

    def build_relay_external_boc_batch(
        self,
        network: str,
        relay_requests: list[TvmRelayRequest],
        *,
        for_emulation: bool = False,
    ) -> bytes:
        """Build one Highload V3 external message for relaying multiple W5 requests."""
        if not relay_requests:
            raise ValueError("relay_requests must not be empty")

        wallet_context = self._wallets[network]
        query_id = self._select_query_id(network, for_emulation)
        created_at = (
            int(time.time()) - 5
        )  # workaround because lite servers often lag behind the blockchain
        external_state_init = None
        forward_actions: list[Cell] = []

        for relay_request in relay_requests:
            forward_value = (
                relay_request.relay_amount
                if relay_request.relay_amount is not None
                else wallet_context.config.relay_amount + relay_request.forward_ton_amount
            )
            forward_message = Contract.create_internal_msg(
                src=None,
                dest=Address(relay_request.destination),
                bounce=True,
                value=forward_value,
                state_init=relay_request.state_init,
                body=relay_request.body,
            )
            forward_actions.append(serialize_send_msg_action(forward_message.serialize(), mode=3))

        message_to_send = self._pack_actions_message(wallet_context, forward_actions, query_id)

        message_inner = (
            begin_cell()
            .store_uint(wallet_context.config.subwallet_id, 32)
            .store_ref(message_to_send)
            .store_uint(1, 8)
            .store_uint(query_id, 23)
            .store_uint(created_at, 64)
            .store_uint(wallet_context.config.timeout, 22)
            .end_cell()
        )

        external_body = (
            begin_cell()
            .store_bytes(sign_message(message_inner.hash, wallet_context.config.secret_key))
            .store_ref(message_inner)
            .end_cell()
        )

        if wallet_context.deployed is not True:
            facilitator_account = self.get_account_state(wallet_context.address, network)
            wallet_context.deployed = facilitator_account.is_active
            if facilitator_account.is_uninitialized:
                external_state_init = wallet_context.state_init

        external_message = Contract.create_external_msg(
            dest=Address(wallet_context.address),
            state_init=external_state_init,
            body=external_body,
        )
        return external_message.serialize().to_boc()

    def emulate_external_message(self, network: str, external_boc: bytes) -> dict[str, object]:
        """Emulate a prepared external message via the configured TVM provider."""
        return self._client(network).emulate_trace(
            external_boc,
            timeout=self._configs[network].provider_emulation_timeout_seconds,
        )

    def send_external_message(self, network: str, external_boc: bytes) -> str:
        """Broadcast a prepared external message via the configured TVM provider."""
        self._ensure_streaming_watcher(network)
        return self._client(network).send_message(external_boc)

    def wait_for_trace_confirmation(
        self,
        network: str,
        trace_external_hash_norm: str,
        *,
        timeout_seconds: float,
    ) -> dict[str, object]:
        """Wait until the submitted trace reaches finalized."""
        deadline = time.monotonic() + timeout_seconds

        if self._ensure_streaming_watcher(network):
            try:
                remaining = min(
                    DEFAULT_STREAMING_CONFIRMATION_GRACE_SECONDS,
                    max(0.0, deadline - time.monotonic()),
                )
                self._streaming_client(network).wait_for_trace_confirmation(
                    trace_external_hash_norm=trace_external_hash_norm,
                    timeout_seconds=remaining,
                )
            except Exception:
                pass

        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                trace = self._client(network).get_trace_by_message_hash(trace_external_hash_norm)
                if not trace.get("is_incomplete", False):
                    return trace
            except Exception as exc:
                last_error = exc
            time.sleep(DEFAULT_TRACE_FETCH_BACKOFF_SECONDS)

        if last_error is not None:
            raise last_error
        raise RuntimeError(f"Timed out waiting for complete trace {trace_external_hash_norm}")

    def get_jetton_wallet_data(self, address: str, network: str) -> TvmJettonWalletData:
        """Read TEP-74 jetton wallet data."""
        return self._client(network).get_jetton_wallet_data(address)

    def _client(self, network: str) -> TvmProviderClient:
        client = self._clients.get(network)
        if client is not None:
            return client

        with self._lock:
            client = self._clients.get(network)
            if client is None:
                config = self._configs[network]
                client = create_tvm_provider_client(
                    network,
                    provider=config.provider,
                    api_key=config.api_key,
                    base_url=config.provider_base_url,
                    timeout=config.provider_timeout_seconds,
                )
                self._clients[network] = client
            return client

    def _streaming_client(self, network: str) -> TvmStreamingSseClient:
        client = self._streaming_clients.get(network)
        if client is not None:
            return client

        with self._lock:
            client = self._streaming_clients.get(network)
            if client is None:
                config = self._configs[network]
                client = TvmStreamingSseClient(
                    base_url=(
                        config.provider_base_url or _default_base_url(network, config.provider)
                    ),
                    api_key=config.api_key,
                    provider=config.provider,
                )
                self._streaming_clients[network] = client
            return client

    def _get_facilitator_account_state(self, network: str) -> TvmAccountState:
        """We cache the account state of the facilitator. The cache is invalidated when an event arrives from the StreamingAPI."""
        facilitator_address = self._wallets[network].address

        self._ensure_streaming_watcher(network)
        with self._lock:
            cached_state = self._cached_facilitator_states.get(network)
            is_dirty = self._facilitator_state_dirty.get(network, True)
        if cached_state is not None and not is_dirty:
            return cached_state

        refreshed_state = self._client(network).get_account_state(facilitator_address)
        with self._lock:
            self._cached_facilitator_states[network] = refreshed_state
            self._facilitator_state_dirty[network] = False
        return refreshed_state

    def _ensure_streaming_watcher(self, network: str) -> bool:
        startup_event: threading.Event | None = None
        should_start = False
        with self._lock:
            existing_watcher = self._streaming_watchers.get(network)
            if existing_watcher is not None and existing_watcher.is_alive():
                return True
            if existing_watcher is not None:
                self._streaming_watchers.pop(network, None)
            startup_event = self._streaming_watcher_startups.get(network)
            if startup_event is None:
                startup_event = threading.Event()
                self._streaming_watcher_startups[network] = startup_event
                should_start = True

        if not should_start:
            assert startup_event is not None
            startup_event.wait()
            with self._lock:
                existing_watcher = self._streaming_watchers.get(network)
                return existing_watcher is not None and existing_watcher.is_alive()

        watcher: TvmStreamingWatcher | None = None
        try:
            watcher = self._streaming_client(network).start_account_state_watcher(
                address=self._wallets[network].address,
                on_invalidate=lambda: self._mark_facilitator_state_dirty(network),
            )
        except Exception:
            watcher = None
        finally:
            assert startup_event is not None
            with self._lock:
                if watcher is not None:
                    self._streaming_watchers[network] = watcher
                self._streaming_watcher_startups.pop(network, None)
                startup_event.set()

        return watcher is not None

    def _mark_facilitator_state_dirty(self, network: str) -> None:
        with self._lock:
            self._facilitator_state_dirty[network] = True

    def _pack_actions_message(
        self,
        wallet_context: _WalletContext,
        actions: list[Cell],
        query_id: int,
    ) -> Cell:
        batch_actions = list(actions)
        if len(batch_actions) > 254:
            nested_message = self._pack_actions_message(
                wallet_context, batch_actions[253:], query_id
            )
            batch_actions = batch_actions[:253] + [
                serialize_send_msg_action(nested_message, mode=3)
            ]

        return Contract.create_internal_msg(
            src=None,
            dest=Address(wallet_context.address),
            bounce=True,
            value=10**9,
            body=serialize_internal_transfer(serialize_out_list(batch_actions), query_id),
        ).serialize()

    def _select_query_id(self, network: str, for_emulation: bool) -> int:
        """Pick a free HighloadV3 QueryID from the local monotonic seqno cursor."""
        wallet_context = self._wallets[network]
        query_state = load_highload_query_state(
            self.get_account_state(wallet_context.address, network),
            expected_code_hash=HIGHLOAD_V3_CODE_HASH,
        )
        with self._lock:
            wallet_context = self._wallets[network]
            wallet_context.deployed = query_state is not None
            attempts = MAX_USABLE_QUERY_SEQNO + 1
            next_seqno = self._query_ids[network]
            for _ in range(attempts):
                seqno = next_seqno
                next_seqno = (next_seqno + 1) % (MAX_USABLE_QUERY_SEQNO + 1)
                query_id = seqno_to_query_id(seqno)
                if query_state is None or not query_id_is_processed(query_state, query_id):
                    if not for_emulation:
                        self._query_ids[network] = next_seqno
                    return query_id
        raise RuntimeError("No free Highload V3 query_id available")


@dataclass
class _WalletContext:
    config: HighloadV3Config
    public_key: bytes
    address: str
    state_init: StateInit
    deployed: bool | None = None

    @classmethod
    def from_config(cls, config: HighloadV3Config) -> _WalletContext:
        # TON-specific: highload v3 wallet address is derived from its fixed code and data layout.
        public_key = private_key_to_public_key(config.secret_key)
        code = Cell.one_from_boc(bytes.fromhex(HIGHLOAD_V3_CODE_HEX))
        if code.hash.hex() != HIGHLOAD_V3_CODE_HASH:
            raise ValueError("Unexpected highload-wallet-contract-v3 code hash")

        data = (
            begin_cell()
            .store_bytes(public_key)
            .store_uint(config.subwallet_id, 32)
            .store_uint(0, 66)
            .store_uint(config.timeout, 22)
            .end_cell()
        )
        state_init = StateInit(code=code, data=data)
        address = normalize_address(Address((config.workchain, state_init.serialize().hash)))
        return cls(
            config=config,
            public_key=public_key,
            address=address,
            state_init=state_init,
            deployed=None,
        )
