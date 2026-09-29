"""Exact/EIP-3009 integration test with a deployed Biconomy Nexus (ERC-7579)."""

from __future__ import annotations

import os

import pytest
from eth_account import Account
from web3 import Web3

from x402.tests.integrations._smart_accounts import NEXUS_K1_VALIDATOR, NexusSmartAccountSigner
from x402.tests.integrations.test_evm_wallet_matrix import (
    FACILITATOR_KEY,
    RESOURCE_SERVER,
    RPC_URL,
    _build_server,
    _run_flow,
)

ADDR_7579 = os.environ.get("EVM_CLIENT_7579_ADDRESS")
KEY_7579_OWNER = os.environ.get("EVM_CLIENT_7579_OWNER_PRIVATE_KEY")
VALIDATOR_7579 = os.environ.get("EVM_CLIENT_7579_VALIDATOR", NEXUS_K1_VALIDATOR)

pytestmark = pytest.mark.skipif(
    not FACILITATOR_KEY or not RESOURCE_SERVER,
    reason="EVM_FACILITATOR_PRIVATE_KEY and EVM_RESOURCE_SERVER_ADDRESS required",
)


class TestExact7579EvmIntegration:
    def test_biconomy_nexus_exact_eip3009(self) -> None:
        if not KEY_7579_OWNER or not ADDR_7579:
            pytest.skip("EVM_CLIENT_7579_OWNER_PRIVATE_KEY / EVM_CLIENT_7579_ADDRESS required")

        server, _ = _build_server(FACILITATOR_KEY)
        owner = Account.from_key(KEY_7579_OWNER)
        w3 = Web3(Web3.HTTPProvider(RPC_URL))
        signer = NexusSmartAccountSigner(owner, ADDR_7579, w3, VALIDATOR_7579)
        settle = _run_flow(signer, server, RESOURCE_SERVER, "exact-7579-biconomy-nexus")
        assert settle.payer.lower() == ADDR_7579.lower()
        print(f"\nexact/7579 ✅ tx={settle.transaction} payer={settle.payer}")
