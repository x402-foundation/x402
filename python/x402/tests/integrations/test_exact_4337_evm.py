"""Exact/EIP-3009 integration test with a deployed Coinbase Smart Wallet (ERC-4337)."""

from __future__ import annotations

import os

import pytest
from eth_account import Account

from x402.tests.integrations._smart_accounts import CoinbaseSmartWalletSigner
from x402.tests.integrations.test_evm_wallet_matrix import (
    FACILITATOR_KEY,
    RESOURCE_SERVER,
    _build_server,
    _run_flow,
)

ADDR_4337 = os.environ.get("EVM_CLIENT_4337_ADDRESS")
KEY_4337_OWNER = os.environ.get("EVM_CLIENT_4337_OWNER_PRIVATE_KEY")

pytestmark = pytest.mark.skipif(
    not FACILITATOR_KEY or not RESOURCE_SERVER,
    reason="EVM_FACILITATOR_PRIVATE_KEY and EVM_RESOURCE_SERVER_ADDRESS required",
)


class TestExact4337EvmIntegration:
    def test_coinbase_smart_wallet_exact_eip3009(self) -> None:
        if not KEY_4337_OWNER or not ADDR_4337:
            pytest.skip("EVM_CLIENT_4337_OWNER_PRIVATE_KEY / EVM_CLIENT_4337_ADDRESS required")

        server, _ = _build_server(FACILITATOR_KEY)
        owner = Account.from_key(KEY_4337_OWNER)
        signer = CoinbaseSmartWalletSigner(owner, ADDR_4337)
        settle = _run_flow(signer, server, RESOURCE_SERVER, "exact-4337-coinbase-smart-wallet")
        assert settle.payer.lower() == ADDR_4337.lower()
        print(f"\nexact/4337 ✅ tx={settle.transaction} payer={settle.payer}")
