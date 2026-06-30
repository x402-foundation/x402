"""EVM integration tests for batch-settlement scheme (sync flows).

Performs REAL Base Sepolia transactions equivalent to the TypeScript
`typescript/packages/mechanisms/evm/test/integrations/batch-settlement-evm.test.ts`
and exercises the Python facilitator/server/client wired through the same
SchemeNetworkFacilitator + SchemeNetworkServer registrations the runtime uses.

Required environment variables:
- EVM_CLIENT_PRIVATE_KEY: Private key for the client (payer).
- EVM_FACILITATOR_PRIVATE_KEY: Private key for the facilitator submitting txs.
Optional:
- EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: Receiver-authorizer key (defaults to
  EVM_FACILITATOR_PRIVATE_KEY when unset, matching the TS test default).
- EVM_RPC_URL: RPC URL (defaults to https://sepolia.base.org).
"""

from __future__ import annotations

import os
import secrets
import time

import pytest
from eth_account import Account
from web3 import Web3

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.evm.batch_settlement import (
    BATCH_SETTLEMENT_ADDRESS,
    SCHEME_BATCH_SETTLEMENT,
)
from x402.mechanisms.evm.batch_settlement.abi import BATCH_SETTLEMENT_ABI
from x402.mechanisms.evm.batch_settlement.authorizer_signer import LocalAuthorizerSigner
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementDepositPolicy,
    BatchSettlementEvmSchemeOptions,
    InMemoryClientChannelStorage,
    process_settle_response,
)
from x402.mechanisms.evm.batch_settlement.client import (
    BatchSettlementEvmScheme as BatchSettlementClientScheme,
)
from x402.mechanisms.evm.batch_settlement.facilitator import (
    BatchSettlementEvmFacilitator,
)
from x402.mechanisms.evm.batch_settlement.server import (
    BatchSettlementEvmScheme as BatchSettlementServerScheme,
)
from x402.mechanisms.evm.batch_settlement.server import (
    BatchSettlementEvmSchemeServerConfig,
)
from x402.mechanisms.evm.signers import EthAccountSigner, FacilitatorWeb3Signer
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
    SupportedResponse,
    VerifyResponse,
)

# Prefer EVM_CLIENT_EOA_PRIVATE_KEY (a plain EOA, not ERC-7702 delegated) so that
# strict verify_typed_data_strict routing (code-length-based) does not cause the
# facilitator to try EIP-1271 on an address that has been delegated for 7702 tests.
CLIENT_PRIVATE_KEY = os.environ.get("EVM_CLIENT_EOA_PRIVATE_KEY") or os.environ.get(
    "EVM_CLIENT_PRIVATE_KEY"
)
FACILITATOR_PRIVATE_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")
RECEIVER_AUTHORIZER_PRIVATE_KEY = os.environ.get(
    "EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", FACILITATOR_PRIVATE_KEY
)

RPC_URL = os.environ.get("EVM_RPC_URL", "https://sepolia.base.org")
NETWORK = "eip155:84532"
USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

pytestmark = pytest.mark.skipif(
    not CLIENT_PRIVATE_KEY or not FACILITATOR_PRIVATE_KEY,
    reason=(
        "EVM_CLIENT_EOA_PRIVATE_KEY (or EVM_CLIENT_PRIVATE_KEY) and EVM_FACILITATOR_PRIVATE_KEY "
        "environment variables required for batch-settlement integration tests"
    ),
)


class _BatchFacilitatorClientSync:
    """Adapts x402FacilitatorSync to the FacilitatorClient surface used by the server."""

    scheme = SCHEME_BATCH_SETTLEMENT
    network = NETWORK
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


def _build_requirements(
    pay_to: str,
    amount: str,
    receiver_authorizer: str,
) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=USDC_ADDRESS,
        amount=amount,
        pay_to=pay_to,
        max_timeout_seconds=3600,
        extra={
            "name": "USDC",
            "version": "2",
            "assetTransferMethod": "eip3009",
            "receiverAuthorizer": receiver_authorizer,
        },
    )


def _wait_for_channel_balance(w3: Web3, channel_id: str, timeout_s: float = 20.0) -> None:
    """Poll `channels(channelId)` until balance > 0 or timeout (matches TS helper)."""
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(BATCH_SETTLEMENT_ADDRESS),
        abi=BATCH_SETTLEMENT_ABI,
    )
    cid_bytes = bytes.fromhex(channel_id.removeprefix("0x"))
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        balance, _ = contract.functions.channels(cid_bytes).call()
        if balance > 0:
            return
        time.sleep(0.25)
    raise AssertionError(f"Timed out waiting for channel {channel_id} balance > 0")


class TestBatchSettlementEvmIntegration:
    """End-to-end on-chain batch-settlement flow on Base Sepolia."""

    def setup_method(self) -> None:
        client_account = Account.from_key(CLIENT_PRIVATE_KEY)
        self.client_signer = EthAccountSigner(client_account)
        self.facilitator_signer = FacilitatorWeb3Signer(
            private_key=FACILITATOR_PRIVATE_KEY,
            rpc_url=RPC_URL,
        )
        self.authorizer_signer = LocalAuthorizerSigner(RECEIVER_AUTHORIZER_PRIVATE_KEY)

        self.client_address = self.client_signer.address
        self.facilitator_address = self.facilitator_signer.address
        self.receiver_authorizer = self.authorizer_signer.address

        # Per-test channel salt — keeps each run on a fresh channel.
        self.channel_salt = "0x" + secrets.token_bytes(32).hex()

        # Client scheme: register with multiplier + isolated in-memory storage.
        self.client_storage = InMemoryClientChannelStorage()
        self.client = x402ClientSync().register(
            NETWORK,
            BatchSettlementClientScheme(
                self.client_signer,
                BatchSettlementEvmSchemeOptions(
                    storage=self.client_storage,
                    salt=self.channel_salt,
                    deposit_policy=BatchSettlementDepositPolicy(deposit_multiplier=3),
                ),
            ),
        )

        # Facilitator: register the BatchSettlementEvmFacilitator implementation.
        self.facilitator = x402FacilitatorSync().register(
            [NETWORK],
            BatchSettlementEvmFacilitator(
                self.facilitator_signer,
                self.authorizer_signer,
            ),
        )

        # Resource server uses the wrapped facilitator client.
        facilitator_client = _BatchFacilitatorClientSync(self.facilitator)
        self.server = x402ResourceServerSync(facilitator_client)
        self.server.register(
            NETWORK,
            BatchSettlementServerScheme(
                self.facilitator_address,
                BatchSettlementEvmSchemeServerConfig(
                    receiver_authorizer_signer=self.authorizer_signer,
                ),
            ),
        )
        self.server.initialize()

        # Web3 client for on-chain polling.
        self.w3 = Web3(Web3.HTTPProvider(RPC_URL))

    def test_deposit_then_followup_voucher_payment(self) -> None:
        """Mirror of TS "verifies and settles a deposit-with-voucher payment,
        then a follow-up voucher payment".

        WARNING: This spends real Base Sepolia USDC.
        """
        accepts = [_build_requirements(self.facilitator_address, "1000", self.receiver_authorizer)]
        resource = ResourceInfo(
            url="https://example.com/api",
            description="Batched test resource",
            mime_type="application/json",
        )

        payment_required = self.server.create_payment_required_response(accepts, resource)
        assert payment_required.x402_version == 2

        first_payload = self.client.create_payment_payload(payment_required)
        assert first_payload.accepted.scheme == SCHEME_BATCH_SETTLEMENT
        assert first_payload.accepted.network == NETWORK
        assert first_payload.payload.get("type") == "deposit"

        accepted = self.server.find_matching_requirements(accepts, first_payload)
        assert accepted is not None

        verify_response = self.server.verify_payment(first_payload, accepted)
        if not verify_response.is_valid:
            pytest.fail(
                f"first verify failed: {verify_response.invalid_reason} "
                f"msg={getattr(verify_response, 'invalid_message', None)} "
                f"(payer={verify_response.payer})"
            )
        assert verify_response.payer.lower() == self.client_address.lower()

        settle_response = self.server.settle_payment(first_payload, accepted)
        if not settle_response.success:
            pytest.fail(f"first settle failed: {settle_response.error_reason}")
        assert settle_response.network == NETWORK
        assert settle_response.transaction != ""
        assert settle_response.payer.lower() == self.client_address.lower()

        deposit_channel_id = first_payload.payload["voucher"]["channelId"]
        _wait_for_channel_balance(self.w3, deposit_channel_id)

        process_settle_response(self.client_storage, settle_response)

        followup_required = self.server.create_payment_required_response(accepts, resource)
        second_payload = self.client.create_payment_payload(followup_required)
        assert second_payload.payload.get("type") == "voucher"

        accepted2 = self.server.find_matching_requirements(accepts, second_payload)
        assert accepted2 is not None

        verify2 = self.server.verify_payment(second_payload, accepted2)
        if not verify2.is_valid:
            pytest.fail(f"second verify failed: {verify2.invalid_reason}")

        settle2 = self.server.settle_payment(second_payload, accepted2)
        if not settle2.success:
            pytest.fail(f"second settle failed: {settle2.error_reason}")
        assert settle2.payer.lower() == self.client_address.lower()

    def test_facilitator_get_supported_includes_batch_settlement(self) -> None:
        supported = self.facilitator.get_supported()
        match = None
        for kind in supported.kinds:
            if kind.network == NETWORK and kind.scheme == SCHEME_BATCH_SETTLEMENT:
                match = kind
                break
        assert match is not None
        assert match.x402_version == 2
        assert match.extra is not None
        assert match.extra.get("receiverAuthorizer", "").lower() == self.receiver_authorizer.lower()
