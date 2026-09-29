"""TVM signer protocol definitions."""

from __future__ import annotations

from typing import Protocol

from .types import TvmAccountState, TvmJettonWalletData, TvmRelayRequest

try:
    from pytoniq_core.tlb.account import StateInit
except ImportError as e:
    raise ImportError(
        "TVM mechanism requires pytoniq packages. Install with: pip install x402[tvm]"
    ) from e


class FacilitatorTvmSigner(Protocol):
    """Facilitator-side TVM signer for verification and settlement."""

    def get_addresses(self) -> list[str]:
        """Get all facilitator wallet addresses."""
        ...

    def get_addresses_for_network(self, network: str) -> list[str]:
        """Get facilitator wallet addresses available for one TVM network."""
        ...

    def get_account_state(self, address: str, network: str) -> TvmAccountState:
        """Get account state for a wallet or jetton wallet."""
        ...

    def get_jetton_wallet(self, asset: str, owner: str, network: str) -> str:
        """Resolve the canonical TEP-74 jetton wallet for an owner."""
        ...

    def build_relay_external_boc(
        self,
        network: str,
        relay_request: TvmRelayRequest,
        *,
        for_emulation: bool = False,
    ) -> bytes:
        """Build a Highload V3 external message for relaying the pre-signed W5 message."""
        ...

    def build_relay_external_boc_batch(
        self,
        network: str,
        relay_requests: list[TvmRelayRequest],
    ) -> bytes:
        """Build one Highload V3 external message that relays multiple requests."""
        ...

    def emulate_external_message(self, network: str, external_boc: bytes) -> dict[str, object]:
        """Emulate a prepared external message through the configured TVM provider."""
        ...

    def send_external_message(self, network: str, external_boc: bytes) -> str:
        """Broadcast a prepared external message through the configured TVM provider."""
        ...

    def wait_for_trace_confirmation(
        self,
        network: str,
        trace_external_hash_norm: str,
        *,
        timeout_seconds: float,
    ) -> dict[str, object]:
        """Wait until a submitted trace reaches finalized and return its payload."""
        ...

    def get_jetton_wallet_data(self, address: str, network: str) -> TvmJettonWalletData:
        """Read TEP-74 jetton wallet data for a wallet address."""
        ...


class ClientTvmSigner(Protocol):
    """Client-side TVM signer for W5 exact payments."""

    @property
    def address(self) -> str:
        """The signer's W5 wallet address in raw format."""
        ...

    @property
    def network(self) -> str:
        """The CAIP-2 TVM network this signer is configured for."""
        ...

    @property
    def wallet_id(self) -> int:
        """The W5 wallet_id used in signed requests."""
        ...

    @property
    def state_init(self) -> StateInit:
        """The wallet StateInit used for first deployment."""
        ...

    def sign_message(self, message: bytes) -> bytes:
        """Sign a W5 request body hash."""
        ...
