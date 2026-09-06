"""Unit tests for ERC-6492 counterfactual deposit support (ERC-3009 deposit path).

Mirrors go/mechanisms/evm/batch-settlement/facilitator/deposit_erc6492_test.go.
"""

from __future__ import annotations

import pytest

try:
    from eth_abi import encode

    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_FACTORY_NOT_ALLOWED,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.deposit import (
        _deploy_erc3009_counterfactual_if_needed,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.deposit_eip3009 import (
        verify_eip3009_deposit_authorization,
    )
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        DepositAuthorization,
        DepositFields,
        DepositPayload,
        Erc3009Authorization,
        VoucherFields,
    )
    from x402.mechanisms.evm.constants import ERC6492_MAGIC_VALUE, TX_STATUS_SUCCESS
    from x402.mechanisms.evm.types import TransactionReceipt
    from x402.schemas import PaymentRequirements
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


CHANNEL_ID = "0x" + "ab" * 32
TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PAYER = "0x1111111111111111111111111111111111111111"
FACTORY = "0xca11bde05977b3631167028862be2a173976ca11"


def _wrap_erc6492(factory: str, factory_calldata: bytes, inner: bytes) -> str:
    packed = encode(
        ["address", "bytes", "bytes"],
        [factory, factory_calldata, inner],
    )
    return "0x" + (packed + ERC6492_MAGIC_VALUE).hex()


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer=PAYER,
        payer_authorizer=PAYER,
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token=TOKEN,
        withdraw_delay=900,
        salt="0x" + "00" * 32,
    )


def _counterfactual_payload() -> DepositPayload:
    p = DepositPayload()
    p.channel_config = _channel_config()
    p.voucher = VoucherFields(
        channel_id=CHANNEL_ID, max_claimable_amount="1000", signature="0x" + "22" * 65
    )
    wrapped = _wrap_erc6492(FACTORY, bytes.fromhex("deadbeef"), bytes([0x33] * 65))
    p.deposit = DepositFields(
        amount="1000",
        authorization=DepositAuthorization(
            erc3009_authorization=Erc3009Authorization(
                valid_after="100",
                valid_before="9999999999",
                salt="0x" + "22" * 32,
                signature=wrapped,
            )
        ),
    )
    return p


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="batch-settlement",
        network="eip155:8453",
        asset=TOKEN,
        amount="1000",
        pay_to="0x3333333333333333333333333333333333333333",
        max_timeout_seconds=60,
        extra={"name": "USD Coin", "version": "2"},
    )


class _MockSigner:
    """Minimal FacilitatorEvmSigner for counterfactual deposit tests."""

    def __init__(self, *, code=b"", deposit_reverts=False, deploy_ok=True):
        self._code = code
        self._deposit_reverts = deposit_reverts
        self._deploy_ok = deploy_ok
        self.send_calls = 0
        self.write_calls = 0

    def get_code(self, address: str) -> bytes:
        return self._code

    def get_chain_id(self) -> int:
        return 8453

    def send_transaction(self, to: str, data: bytes) -> str:
        self.send_calls += 1
        return "0x" + "ab" * 32

    def wait_for_transaction_receipt(self, tx_hash: str) -> TransactionReceipt:
        status = TX_STATUS_SUCCESS if self._deploy_ok else 0
        return TransactionReceipt(status=status, block_number=1, tx_hash=tx_hash)

    def read_contract(self, address, abi, function_name, *args):
        if function_name == "deposit" and self._deposit_reverts:
            raise RuntimeError("execution reverted: invalid signature")
        return None

    def write_contract(self, *args, **kwargs):
        self.write_calls += 1
        return "0x" + "cd" * 32


class TestVerifyCounterfactual:
    def test_factory_not_allowed(self):
        signer = _MockSigner(code=b"")  # undeployed
        sig_data, resp = verify_eip3009_deposit_authorization(
            signer, _counterfactual_payload(), _requirements(), 8453, allowed_factories=[]
        )
        assert sig_data is None
        assert resp is not None and resp.invalid_reason == ERR_FACTORY_NOT_ALLOWED

    def test_allowed_defers_to_simulation(self):
        signer = _MockSigner(code=b"")  # undeployed
        sig_data, resp = verify_eip3009_deposit_authorization(
            signer, _counterfactual_payload(), _requirements(), 8453, allowed_factories=[FACTORY]
        )
        assert resp is None
        assert sig_data is not None
        assert sig_data.factory_calldata == bytes.fromhex("deadbeef")


class TestSettleCounterfactualDeploy:
    def test_factory_not_allowed_no_deploy(self):
        signer = _MockSigner(code=b"")
        resp = _deploy_erc3009_counterfactual_if_needed(
            signer, _counterfactual_payload(), _requirements(), []
        )
        assert resp is not None
        assert resp.error_reason == ERR_FACTORY_NOT_ALLOWED
        assert signer.send_calls == 0

    def test_deployed_proceeds_without_resimulation(self):
        # Post-6492-deploy: the helper deploys the wallet then proceeds to the real deposit and
        # performs no post-deploy deposit() simulation. The inner signature is validated by the
        # verify-side deploy+deposit Multicall3 simulation and, definitively, by the on-chain
        # deposit(). deposit_reverts=True would raise if a deposit() simulation were attempted,
        # guarding against regressing to the old re-simulation behavior.
        signer = _MockSigner(code=b"", deposit_reverts=True)
        resp = _deploy_erc3009_counterfactual_if_needed(
            signer, _counterfactual_payload(), _requirements(), [FACTORY]
        )
        assert resp is None  # deployed, proceed to deposit
        assert signer.send_calls == 1  # wallet was deployed
        assert signer.write_calls == 0  # no deposit submitted by the helper

    def test_happy_path_proceeds(self):
        signer = _MockSigner(code=b"", deposit_reverts=False)
        resp = _deploy_erc3009_counterfactual_if_needed(
            signer, _counterfactual_payload(), _requirements(), [FACTORY]
        )
        assert resp is None  # proceed to deposit
        assert signer.send_calls == 1

    def test_plain_sig_no_deploy(self):
        payload = _counterfactual_payload()
        payload.deposit.authorization.erc3009_authorization.signature = "0x" + "11" * 65
        signer = _MockSigner(code=b"")
        resp = _deploy_erc3009_counterfactual_if_needed(signer, payload, _requirements(), [FACTORY])
        assert resp is None
        assert signer.send_calls == 0
