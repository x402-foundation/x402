"""Batch-settlement charge baseline after the server loses its local channel record.

When the server has no local record for a channel (for example after a full cooperative refund),
it must take the charged baseline from the facilitator-verified on-chain `totalClaimed`, so every
paid request advances the signed cumulative amount by at least the route price.

Drives the real Python server scheme, facilitator and on-chain contract.

Run against a local anvil fork (do not point at live Base Sepolia; it spends real USDC):

    anvil --fork-url https://sepolia.base.org --port 8546 --silent &
    EVM_RPC_URL=http://127.0.0.1:8546 uv run --extra evm pytest \
        tests/integrations/test_evm_batch_settlement_charge_baseline.py -s

Required env: EVM_CLIENT_PRIVATE_KEY, EVM_FACILITATOR_PRIVATE_KEY, EVM_RPC_URL.
"""

from __future__ import annotations

import os
import secrets

import pytest
from eth_account import Account
from web3 import Web3

from x402 import x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.evm.batch_settlement import (
    BATCH_SETTLEMENT_ADDRESS,
    SCHEME_BATCH_SETTLEMENT,
)
from x402.mechanisms.evm.batch_settlement.abi import BATCH_SETTLEMENT_ABI
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementClientContext,
    BatchSettlementEvmSchemeOptions,
    InMemoryClientChannelStorage,
)
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme as BatchSettlementClientScheme,
)
from x402.mechanisms.evm.batch_settlement.client.eip3009 import (
    create_batch_settlement_eip3009_deposit_payload,
)
from x402.mechanisms.evm.batch_settlement.client.voucher import sign_voucher
from x402.mechanisms.evm.batch_settlement.facilitator import BatchSettlementEvmFacilitator
from x402.mechanisms.evm.batch_settlement.server import (
    BatchSettlementEvmScheme as BatchSettlementServerScheme,
)
from x402.mechanisms.evm.batch_settlement.server import BatchSettlementEvmSchemeServerConfig
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)
from x402.schemas.errors import PaymentAbortedError

CLIENT_PRIVATE_KEY = os.environ.get("EVM_CLIENT_PRIVATE_KEY")
FACILITATOR_PRIVATE_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")
RPC_URL = os.environ.get("EVM_RPC_URL", "")
NETWORK = "eip155:84532"
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

PRICE = 50_000  # route price P in USDC atoms ($0.05)
INITIAL_DEPOSIT = 3 * PRICE

pytestmark = pytest.mark.skipif(
    not (CLIENT_PRIVATE_KEY and FACILITATOR_PRIVATE_KEY and RPC_URL.startswith("http://127.")),
    reason="needs EVM keys and EVM_RPC_URL pointing at a local anvil fork",
)


class _FacilitatorClient:
    scheme = SCHEME_BATCH_SETTLEMENT
    network = NETWORK
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync):
        self._f = facilitator

    def verify(self, payload: PaymentPayload, req: PaymentRequirements) -> VerifyResponse:
        return self._f.verify(payload, req)

    def settle(self, payload: PaymentPayload, req: PaymentRequirements) -> SettleResponse:
        return self._f.settle(payload, req)

    def get_supported(self) -> SupportedResponse:
        return self._f.get_supported()


class _Env:
    """Fresh channel (random salt) wired to the real facilitator and contract."""

    def __init__(self) -> None:
        self.client_signer = EthAccountSigner(Account.from_key(CLIENT_PRIVATE_KEY))
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY, rpc_url=RPC_URL
        )
        self.authorizer = LocalAuthorizerSigner(FACILITATOR_PRIVATE_KEY)
        self.payee = self.facilitator_signer.address
        self.salt = "0x" + secrets.token_bytes(32).hex()

        self.client_scheme = BatchSettlementClientScheme(
            self.client_signer,
            BatchSettlementEvmSchemeOptions(storage=InMemoryClientChannelStorage(), salt=self.salt),
        )
        facilitator = x402FacilitatorSync().register(
            [NETWORK],
            BatchSettlementEvmFacilitator(self.facilitator_signer, self.authorizer),
        )
        self.facilitator_client = _FacilitatorClient(facilitator)
        self.server = x402ResourceServerSync(self.facilitator_client)
        self.server_scheme = BatchSettlementServerScheme(
            self.payee,
            BatchSettlementEvmSchemeServerConfig(receiver_authorizer_signer=self.authorizer),
        )
        self.server.register(NETWORK, self.server_scheme)
        self.server.initialize()

        self.w3 = Web3(Web3.HTTPProvider(RPC_URL))
        self.contract = self.w3.eth.contract(
            address=Web3.to_checksum_address(BATCH_SETTLEMENT_ADDRESS), abi=BATCH_SETTLEMENT_ABI
        )
        self.requirements = PaymentRequirements(
            scheme=SCHEME_BATCH_SETTLEMENT,
            network=NETWORK,
            asset=USDC_ADDRESS,
            amount=str(PRICE),
            pay_to=self.payee,
            max_timeout_seconds=3600,
            extra={
                "name": "USDC",
                "version": "2",
                "assetTransferMethod": "eip3009",
                "receiverAuthorizer": self.authorizer.address,
            },
        )
        self.config = self.client_scheme.build_channel_config(self.requirements)
        self.channel_id = compute_channel_id(self.config, NETWORK)

    def onchain(self) -> tuple[int, int]:
        balance, total_claimed = self.contract.functions.channels(
            bytes.fromhex(self.channel_id.removeprefix("0x"))
        ).call()
        return int(balance), int(total_claimed)

    def local_charged(self) -> str | None:
        ch = self.server_scheme.get_storage().get(self.channel_id)
        return None if ch is None else ch.charged_cumulative_amount

    def _wrap(self, inner: dict) -> PaymentPayload:
        return PaymentPayload(x402_version=2, payload=inner, accepted=self.requirements)

    def deposit_payload(self, deposit: int, max_claimable: int) -> PaymentPayload:
        p = create_batch_settlement_eip3009_deposit_payload(
            self.client_signer, self.requirements, self.config, deposit, max_claimable, None
        )
        return self._wrap(p.to_dict())

    def voucher_payload(self, max_claimable: int) -> PaymentPayload:
        voucher = sign_voucher(self.client_signer, self.channel_id, str(max_claimable), NETWORK)
        return self._wrap(
            {
                "type": "voucher",
                "channelConfig": self.config.to_dict(),
                "voucher": {
                    "channelId": self.channel_id,
                    "maxClaimableAmount": str(max_claimable),
                    "signature": voucher.signature
                    if hasattr(voucher, "signature")
                    else voucher["signature"],
                },
            }
        )

    def pay(self, payload: PaymentPayload) -> tuple[VerifyResponse, SettleResponse | None]:
        """verify (gate before the protected handler) then settle, like the HTTP middleware."""
        try:
            v = self.server.verify_payment(payload, self.requirements)
        except PaymentAbortedError as e:  # server hook abort == payload rejected before handler
            return VerifyResponse(is_valid=False, invalid_reason=str(e)), None
        if not v.is_valid:
            return v, None
        return v, self.server.settle_payment(payload, self.requirements)

    def full_refund(self) -> None:
        manager = self.server_scheme.create_channel_manager_sync(self.facilitator_client, NETWORK)
        results = manager.refund([self.channel_id])
        assert len(results) == 1 and results[0].transaction, f"refund failed: {results}"
        assert self.local_charged() is None, "full refund must delete the local channel record"

    def establish_claimed_state(self) -> int:
        """Paid usage, then full refund: leaves onchain totalClaimed=T>0 and no local record."""
        v, s = self.pay(self.deposit_payload(INITIAL_DEPOSIT, PRICE))
        assert v.is_valid and s and s.success, (
            f"first payment failed: reason={getattr(v, 'invalid_reason', None)} "
            f"msg={getattr(v, 'invalid_message', None)} settle={s}"
        )
        self.full_refund()
        balance, total_claimed = self.onchain()
        assert total_claimed == PRICE and balance == PRICE, (balance, total_claimed)
        return total_claimed


def test_voucher_advancing_by_price_after_record_loss_is_accepted() -> None:
    """Control: M = T + P (advance by exactly the price) is accepted after record loss."""
    env = _Env()
    t = env.establish_claimed_state()
    v, s = env.pay(env.deposit_payload(2 * PRICE, t + PRICE))
    assert v.is_valid and s and s.success, f"M=T+P rejected: {v}"
    assert env.local_charged() == str(t + PRICE)


def test_client_scheme_state_after_record_loss_is_accepted() -> None:
    """A client whose state mirrors on-chain T pays P again after the server lost its record."""
    env = _Env()
    t = env.establish_claimed_state()
    env.client_scheme._storage.set(
        env.channel_id,
        BatchSettlementClientContext(
            charged_cumulative_amount=str(t), balance=str(PRICE), total_claimed=str(t)
        ),
    )
    inner = env.client_scheme.create_payment_payload(env.requirements)
    assert inner["voucher"]["maxClaimableAmount"] == str(t + PRICE)
    v, s = env.pay(env._wrap(inner))
    assert v.is_valid and s and s.success, f"client-built payload rejected: {v}"


def test_voucher_advancing_by_less_than_price_after_record_loss_is_rejected() -> None:
    """M = T + 1 (< T + P) with the local record gone must not reach the protected handler."""
    env = _Env()
    t = env.establish_claimed_state()
    v, s = env.pay(env.deposit_payload(2, t + 1))
    assert not v.is_valid, (
        f"voucher advancing by 1 < price {PRICE} was accepted; "
        f"server charged={env.local_charged()} (onchain totalClaimed={t})"
    )


def test_each_record_loss_cycle_advances_entitlement_by_full_price() -> None:
    """Across deposit/pay/refund cycles, every delivered call must advance totalClaimed by P.

    Each cycle first offers a voucher advancing by 1; if rejected, it pays an honest increment.
    """
    env = _Env()
    t = env.establish_claimed_state()
    gains: list[int] = []
    for _ in range(3):
        v, s = env.pay(env.deposit_payload(2 * PRICE, t + 1))
        if not v.is_valid:
            v, s = env.pay(env.deposit_payload(2 * PRICE, t + PRICE))
        assert v.is_valid and s and s.success
        env.full_refund()
        _, new_t = env.onchain()
        gains.append(new_t - t)
        t = new_t
    assert gains == [PRICE] * 3, f"per-call advance was {gains} atoms vs price {PRICE}"


def test_shortfall_voucher_without_record_loss_is_rejected() -> None:
    """With a live local record, a voucher that advances by less than P is rejected."""
    env = _Env()
    v, s = env.pay(env.deposit_payload(INITIAL_DEPOSIT, PRICE))
    assert v.is_valid and s and s.success
    charged = int(env.local_charged())
    v2, _ = env.pay(env.voucher_payload(charged + 1))
    assert not v2.is_valid, "a voucher advancing by less than the price was accepted"


def test_shortfall_voucher_after_record_loss_is_rejected_once_record_recreated() -> None:
    """After a legitimate post-loss payment recreates the record, shortfalls stay rejected."""
    env = _Env()
    t = env.establish_claimed_state()
    v, s = env.pay(env.deposit_payload(2 * PRICE, t + PRICE))
    assert v.is_valid and s and s.success
    v2, _ = env.pay(env.voucher_payload(int(env.local_charged()) + 1))
    assert not v2.is_valid
