"""Unit tests for the client-side corrective-402 recovery flow."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

pytest.importorskip("eth_account")
pytest.importorskip("eth_utils")
pytest.importorskip("eth_abi")
pytest.importorskip("eth_keys")

from eth_account import Account
from eth_account.messages import encode_typed_data

from x402.mechanisms.evm.batch_settlement.abi import BATCH_SETTLEMENT_ABI
from x402.mechanisms.evm.batch_settlement.client.channel import (
    BatchSettlementClientDeps,
    build_channel_config,
)
from x402.mechanisms.evm.batch_settlement.client.recovery import (
    process_corrective_payment_required,
)
from x402.mechanisms.evm.batch_settlement.client.storage import (
    BatchSettlementClientContext,
    InMemoryClientChannelStorage,
)
from x402.mechanisms.evm.batch_settlement.constants import (
    BATCH_SETTLEMENT_ADDRESS,
    SCHEME_BATCH_SETTLEMENT,
    VOUCHER_TYPES,
)
from x402.mechanisms.evm.batch_settlement.errors import (
    ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
    ERR_CUMULATIVE_AMOUNT_MISMATCH,
)
from x402.mechanisms.evm.batch_settlement.utils import (
    coerce_bytes32,
    compute_channel_id,
    get_batch_settlement_eip712_domain,
)
from x402.mechanisms.evm.signers import EthAccountSigner
from x402.mechanisms.evm.utils import get_evm_chain_id
from x402.schemas import PaymentRequired, PaymentRequirements

TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"
OTHER_PRIVATE_KEY = "0x" + "22" * 32


def _deps() -> BatchSettlementClientDeps:
    return BatchSettlementClientDeps(
        signer=EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY)),
        storage=InMemoryClientChannelStorage(),
        salt="0x" + "00" * 32,
    )


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network="eip155:84532",
        asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount="0",
        pay_to="0x3333333333333333333333333333333333333333",
        max_timeout_seconds=60,
        extra={"receiverAuthorizer": "0x4444444444444444444444444444444444444444"},
    )


@pytest.fixture
def recovery(monkeypatch):
    deps = _deps()
    requirements = _requirements()
    channel_id = compute_channel_id(
        build_channel_config(deps, requirements), str(requirements.network)
    )
    previous = BatchSettlementClientContext(
        charged_cumulative_amount="750",
        balance="9000",
        total_claimed="400",
        signed_max_claimable="950",
        signature="0xold",
        extra={"preserve": "on failure"},
    )
    deps.storage.set(channel_id.lower(), previous)
    write = Mock(wraps=deps.storage.set)
    read = Mock(return_value=(10000, 500))
    sign = Mock(side_effect=AssertionError("recovery must not sign a replacement voucher"))
    monkeypatch.setattr(deps.storage, "set", write)
    monkeypatch.setattr(deps.signer, "read_contract", read, raising=False)
    monkeypatch.setattr(deps.signer, "sign_typed_data", sign)
    return SimpleNamespace(
        deps=deps,
        requirements=requirements,
        channel_id=channel_id,
        previous=previous,
        write=write,
        read=read,
        sign=sign,
    )


def _corrective(
    recovery,
    charged: int = 1000,
    signed: int = 1500,
    private_key: str = TEST_PRIVATE_KEY,
    proof_channel_id: str | None = None,
) -> PaymentRequired:
    # Sign a real Voucher so rejection tests exercise signature recovery.
    signable = encode_typed_data(
        domain_data=get_batch_settlement_eip712_domain(
            get_evm_chain_id(str(recovery.requirements.network))
        ),
        message_types=VOUCHER_TYPES,
        message_data={
            "channelId": coerce_bytes32(proof_channel_id or recovery.channel_id),
            "maxClaimableAmount": signed,
        },
    )
    signature = "0x" + bytes(Account.sign_message(signable, private_key).signature).hex()
    requirements = recovery.requirements.model_copy(deep=True)
    requirements.extra.update(
        {
            "channelState": {
                "channelId": "0x" + "ab" * 32,
                "chargedCumulativeAmount": str(charged),
                "balance": "999999",
                "totalClaimed": "1",
            },
            "voucherState": {"signedMaxClaimable": str(signed), "signature": signature},
        }
    )
    return PaymentRequired(
        x402_version=2,
        error=ERR_CUMULATIVE_AMOUNT_MISMATCH,
        accepts=[requirements],
    )


class TestProcessCorrectivePaymentRequired:
    def test_unknown_error_returns_false(self):
        deps = _deps()
        pr = PaymentRequired(
            x402_version=2,
            error="something_else",
            accepts=[_requirements()],
        )
        assert process_corrective_payment_required(deps, pr) is False

    def test_no_batch_settlement_accept_returns_false(self):
        deps = _deps()
        other = PaymentRequirements(
            scheme="exact",
            network="eip155:84532",
            asset="0x1",
            amount="0",
            pay_to="0x2",
            max_timeout_seconds=60,
            extra={},
        )
        pr = PaymentRequired(
            x402_version=2,
            error=ERR_CUMULATIVE_AMOUNT_MISMATCH,
            accepts=[other],
        )
        assert process_corrective_payment_required(deps, pr) is False

    def test_without_signer_read_contract_returns_false(self):
        """No on-chain reader → cannot validate or recover."""
        deps = _deps()
        # accept includes a channelState extra but no voucherState → falls back to onchain.
        req = _requirements()
        req.extra = {
            **req.extra,
            "channelState": {
                "channelId": "0x" + "ab" * 32,
                "balance": "0",
                "totalClaimed": "0",
                "chargedCumulativeAmount": "0",
            },
        }
        pr = PaymentRequired(
            x402_version=2,
            error=ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
            accepts=[req],
        )
        # EthAccountSigner has no read_contract → recovery cannot complete.
        assert process_corrective_payment_required(deps, pr) is False

    @pytest.mark.parametrize("charged", [500, 1000, 1500])
    def test_verified_voucher_recovers_within_inclusive_bounds(self, recovery, charged):
        pr = _corrective(recovery, charged=charged)
        signature = pr.accepts[0].extra["voucherState"]["signature"]
        expected = BatchSettlementClientContext(
            charged_cumulative_amount=str(charged),
            signed_max_claimable="1500",
            signature=signature,
            balance="10000",
            total_claimed="500",
        )

        assert process_corrective_payment_required(recovery.deps, pr) is True

        recovery.read.assert_called_once_with(
            BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_ABI, "channels", recovery.channel_id
        )
        recovery.write.assert_called_once_with(recovery.channel_id.lower(), expected)
        assert recovery.deps.storage.get(recovery.channel_id) == expected
        recovery.sign.assert_not_called()

    @pytest.mark.parametrize("charged", [499, 1501])
    def test_rejects_cumulative_outside_claimed_and_signed_bounds(self, recovery, charged):
        pr = _corrective(recovery, charged=charged)

        assert process_corrective_payment_required(recovery.deps, pr) is False

        recovery.write.assert_not_called()
        assert recovery.deps.storage.get(recovery.channel_id) == recovery.previous
        recovery.sign.assert_not_called()

    def test_rejects_another_signers_voucher_without_overwriting_state(self, recovery):
        pr = _corrective(recovery, private_key=OTHER_PRIVATE_KEY)

        assert process_corrective_payment_required(recovery.deps, pr) is False

        recovery.write.assert_not_called()
        assert recovery.deps.storage.get(recovery.channel_id) == recovery.previous
        recovery.sign.assert_not_called()

    def test_rejects_own_signature_for_another_channel(self, recovery):
        pr = _corrective(recovery, proof_channel_id="0x" + "cd" * 32)

        assert process_corrective_payment_required(recovery.deps, pr) is False

        recovery.write.assert_not_called()
        assert recovery.deps.storage.get(recovery.channel_id) == recovery.previous
        recovery.sign.assert_not_called()

    @pytest.mark.parametrize("proof", ["absent", "missing_signature"])
    @pytest.mark.parametrize("charged", [1, 999999])
    def test_unsigned_server_state_uses_only_the_onchain_baseline(self, recovery, proof, charged):
        pr = _corrective(recovery, charged=charged)
        if proof == "absent":
            pr.accepts[0].extra.pop("voucherState")
        else:
            pr.accepts[0].extra["voucherState"].pop("signature")
        expected = BatchSettlementClientContext(
            charged_cumulative_amount="500", balance="10000", total_claimed="500"
        )

        assert process_corrective_payment_required(recovery.deps, pr) is True

        recovery.read.assert_called_once_with(
            BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_ABI, "channels", recovery.channel_id
        )
        recovery.write.assert_called_once_with(recovery.channel_id.lower(), expected)
        assert recovery.deps.storage.get(recovery.channel_id) == expected
        recovery.sign.assert_not_called()

    @pytest.mark.parametrize("signed_proof", [True, False])
    def test_rpc_failure_preserves_state_and_original_error(self, recovery, signed_proof):
        pr = _corrective(recovery)
        if not signed_proof:
            pr.accepts[0].extra.pop("voucherState")
        failure = RuntimeError("channels RPC unavailable")
        recovery.read.side_effect = failure

        with pytest.raises(RuntimeError) as exc:
            process_corrective_payment_required(recovery.deps, pr)

        assert exc.value is failure
        recovery.write.assert_not_called()
        assert recovery.deps.storage.get(recovery.channel_id) == recovery.previous
        recovery.sign.assert_not_called()
