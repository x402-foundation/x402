"""Test doubles for TVM mechanism unit tests."""

from __future__ import annotations

from typing import Any

from x402.mechanisms.tvm import (
    TVM_TESTNET,
    TvmAccountState,
    TvmJettonWalletData,
    TvmRelayRequest,
    address_from_state_init,
    build_w5r1_state_init,
)
from x402.mechanisms.tvm.constants import (
    DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    DEFAULT_TVM_EMULATION_ADDRESS,
)

from .builders import ASSET, FACILITATOR, PAYER, RECEIVER_WALLET, SOURCE_WALLET


class ClientSignerStub:
    def __init__(self) -> None:
        self._wallet_id = 7
        self._state_init = build_w5r1_state_init(b"\x11" * 32, self._wallet_id)
        self._address = address_from_state_init(self._state_init, 0)

    @property
    def address(self) -> str:
        return self._address

    @property
    def network(self) -> str:
        return TVM_TESTNET

    @property
    def wallet_id(self) -> int:
        return self._wallet_id

    @property
    def state_init(self):
        return self._state_init

    @property
    def provider_emulation_timeout_seconds(self) -> float:
        return DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS

    def sign_message(self, message: bytes) -> bytes:
        assert message
        return b"\x00" * 64


class ToncenterClientStub:
    def __init__(
        self,
        *,
        is_active: bool = False,
        source_wallet_balance: int = 0,
        source_wallet_fwd_fees: list[int] | None = None,
        source_wallet_compute_fee: int = 0,
        receiver_wallet_compute_fee: int = 0,
        source_wallet_storage_fee: int = 0,
        omit_receiver_tx: bool = False,
        source_action_total_fwd_fees: int | None = None,
        signer: ClientSignerStub | None = None,
    ) -> None:
        self._is_active = is_active
        self._source_wallet_balance = source_wallet_balance
        self._source_wallet_fwd_fees = source_wallet_fwd_fees or [0]
        self._source_wallet_compute_fee = source_wallet_compute_fee
        self._receiver_wallet_compute_fee = receiver_wallet_compute_fee
        self._source_wallet_storage_fee = source_wallet_storage_fee
        self._omit_receiver_tx = omit_receiver_tx
        self._source_action_total_fwd_fees = source_action_total_fwd_fees
        self._signer = signer or ClientSignerStub()
        self.get_account_state_calls = 0
        self.get_jetton_wallet_calls: list[tuple[str, str]] = []
        self.emulate_trace_calls: list[dict[str, object]] = []
        self.close_calls = 0

    def get_account_state(self, address: str) -> TvmAccountState:
        self.get_account_state_calls += 1
        return TvmAccountState(
            address=address,
            balance=0,
            is_active=self._is_active,
            is_uninitialized=not self._is_active,
            is_frozen=False,
            state_init=self._signer.state_init if self._is_active else None,
        )

    def get_jetton_wallet(self, asset: str, owner: str) -> str:
        self.get_jetton_wallet_calls.append((asset, owner))
        if owner == self._signer.address:
            return SOURCE_WALLET
        return RECEIVER_WALLET

    def emulate_trace(
        self,
        boc: bytes,
        *,
        ignore_chksig: bool = False,
        timeout: float = DEFAULT_TONCENTER_EMULATION_TIMEOUT_SECONDS,
    ) -> dict[str, object]:
        _ = boc
        self.emulate_trace_calls.append({"ignore_chksig": ignore_chksig, "timeout": timeout})
        payer = self._signer.address
        emulation_address = DEFAULT_TVM_EMULATION_ADDRESS
        relay_out_hash = "relay-out-hash"
        payer_out_hash = "payer-out-hash"
        source_out_hash = "source-out-hash"
        transactions: dict[str, Any] = {
            "payer": {
                "account": payer,
                "description": {
                    "aborted": False,
                    "action": {"success": True},
                    "compute_ph": {"success": True, "skipped": False},
                },
                "in_msg": (
                    {
                        "hash": relay_out_hash,
                        "hash_norm": relay_out_hash,
                        "source": emulation_address,
                        "destination": payer,
                        "decoded_opcode": "w5_internal_signed_request",
                    }
                    if ignore_chksig
                    else {"decoded_opcode": "w5_external_signed_request"}
                ),
                "out_msgs": [{"hash": payer_out_hash, "hash_norm": payer_out_hash}],
            },
            "source": {
                "account": SOURCE_WALLET,
                "account_state_before": {"balance": str(self._source_wallet_balance)},
                "description": {
                    "aborted": False,
                    "action": {
                        "success": True,
                        **(
                            {"total_fwd_fees": str(self._source_action_total_fwd_fees)}
                            if self._source_action_total_fwd_fees is not None
                            else {}
                        ),
                    },
                    "compute_ph": {
                        "success": True,
                        "skipped": False,
                        "gas_fees": str(self._source_wallet_compute_fee),
                    },
                    "storage_ph": {"storage_fees_collected": str(self._source_wallet_storage_fee)},
                },
                "in_msg": {
                    "hash": payer_out_hash,
                    "hash_norm": payer_out_hash,
                    "source": payer,
                    "destination": SOURCE_WALLET,
                    "decoded_opcode": "jetton_transfer",
                },
                "out_msgs": [
                    {
                        "hash": source_out_hash,
                        "hash_norm": source_out_hash,
                        "source": SOURCE_WALLET,
                        "destination": RECEIVER_WALLET,
                        "decoded_opcode": "jetton_internal_transfer",
                        "message_content": {
                            "decoded": {
                                "@type": "jetton_internal_transfer",
                            }
                        },
                        **({"fwd_fee": str(fee)} if fee is not None else {}),
                    }
                    for fee in self._source_wallet_fwd_fees
                ],
            },
        }
        if not self._omit_receiver_tx:
            transactions["receiver"] = {
                "account": RECEIVER_WALLET,
                "description": {
                    "aborted": False,
                    "action": {"success": True},
                    "compute_ph": {
                        "success": True,
                        "skipped": False,
                        "gas_fees": str(self._receiver_wallet_compute_fee),
                    },
                },
                "in_msg": {
                    "hash": source_out_hash,
                    "hash_norm": source_out_hash,
                    "source": SOURCE_WALLET,
                    "destination": RECEIVER_WALLET,
                    "decoded_opcode": "jetton_internal_transfer",
                },
            }
        if ignore_chksig:
            transactions["emulation"] = {
                "account": emulation_address,
                "description": {
                    "aborted": False,
                    "action": {"success": True},
                    "compute_ph": {"success": True, "skipped": False},
                },
                "in_msg": {"decoded_opcode": "w5_external_signed_request"},
                "out_msgs": [
                    {
                        "hash": relay_out_hash,
                        "hash_norm": relay_out_hash,
                        "source": emulation_address,
                        "destination": payer,
                    }
                ],
            }
        return {"transactions": transactions}

    def close(self) -> None:
        self.close_calls += 1


class FacilitatorSignerStub:
    def __init__(self) -> None:
        self.account_state = TvmAccountState(
            address=PAYER,
            balance=0,
            is_active=True,
            is_frozen=False,
            is_uninitialized=False,
            state_init=None,
        )
        self.facilitator_account_state = TvmAccountState(
            address=FACILITATOR,
            balance=10_000_000_000,
            is_active=True,
            is_frozen=False,
            is_uninitialized=False,
            state_init=None,
        )
        self.jetton_wallet_data = TvmJettonWalletData(
            address=SOURCE_WALLET,
            balance=1_000_000,
            owner=PAYER,
            jetton_minter=ASSET,
        )
        self.last_relay_request: TvmRelayRequest | None = None

    def get_addresses(self) -> list[str]:
        return [FACILITATOR]

    def get_addresses_for_network(self, network: str) -> list[str]:
        assert network == TVM_TESTNET
        return [FACILITATOR]

    def get_account_state(self, address: str, network: str) -> TvmAccountState:
        assert network == TVM_TESTNET
        if address == FACILITATOR:
            return self.facilitator_account_state
        assert address == PAYER
        return self.account_state

    def get_jetton_wallet(self, asset: str, owner: str, network: str) -> str:
        assert asset == ASSET
        assert owner == PAYER
        assert network == TVM_TESTNET
        return SOURCE_WALLET

    def get_jetton_wallet_data(self, address: str, network: str) -> TvmJettonWalletData:
        assert address == SOURCE_WALLET
        assert network == TVM_TESTNET
        return self.jetton_wallet_data

    def build_relay_external_boc(
        self, network: str, relay_request: TvmRelayRequest, *, for_emulation: bool = False
    ) -> bytes:
        assert network == TVM_TESTNET
        assert for_emulation is True
        self.last_relay_request = relay_request
        return b"external-boc"

    def emulate_external_message(self, network: str, external_boc: bytes) -> dict[str, object]:
        assert network == TVM_TESTNET
        assert external_boc == b"external-boc"
        return {"transactions": {}}
