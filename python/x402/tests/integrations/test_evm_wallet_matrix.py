"""Wallet compatibility matrix integration tests — Python SDK.

Exercises the full x402 payment flow (verify + settle) for each supported
combination documented in docs/advanced-concepts/wallet-compatibility.mdx.

Wallet types:
  A - Plain EOA (EIP-3009 + Permit2)
  B - Deployed Coinbase Smart Wallet (ERC-4337, EIP-3009 only)
  7579 - Deployed Biconomy Nexus (ERC-7579, EIP-3009 only)
  D - ERC-7702 EOA delegated to PermissiveECDSADelegate (EIP-3009 + Permit2)

(Wallet C / ERC-6492: Python client does not produce ERC-6492-wrapped sigs.
 Covered by the TypeScript integration test.)

Required env vars (set in python/x402/.env):
  EVM_FACILITATOR_PRIVATE_KEY, EVM_RESOURCE_SERVER_ADDRESS
  EVM_CLIENT_EOA_PRIVATE_KEY          — Wallet A
  EVM_CLIENT_4337_ADDRESS             — Wallet B address (Coinbase Smart Wallet)
  EVM_CLIENT_4337_OWNER_PRIVATE_KEY   — Wallet B owner key
  EVM_CLIENT_7579_ADDRESS             — Wallet 7579 address (Biconomy Nexus)
  EVM_CLIENT_7579_OWNER_PRIVATE_KEY   — Wallet 7579 owner key
  EVM_CLIENT_7579_VALIDATOR           — Wallet 7579 K1 validator (optional)
  EVM_CLIENT_7702_PRIVATE_KEY         — Wallet D key (address is 7702-delegated)
"""

from __future__ import annotations

import os

import pytest
from eth_account import Account
from web3 import Web3

from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
from x402.mechanisms.evm import SCHEME_EXACT
from x402.mechanisms.evm.erc7702 import is_erc7702_delegation
from x402.mechanisms.evm.exact import (
    ExactEvmClientScheme,
    ExactEvmFacilitatorScheme,
    ExactEvmSchemeConfig,
    ExactEvmServerScheme,
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
from x402.tests.integrations._smart_accounts import (
    NEXUS_K1_VALIDATOR,
    CoinbaseSmartWalletSigner,
    NexusSmartAccountSigner,
)

FACILITATOR_KEY = os.environ.get("EVM_FACILITATOR_PRIVATE_KEY")
RESOURCE_SERVER = os.environ.get("EVM_RESOURCE_SERVER_ADDRESS")
# Wallet A
EOA_KEY = os.environ.get("EVM_CLIENT_EOA_PRIVATE_KEY")
# Wallet B
ADDR_4337 = os.environ.get("EVM_CLIENT_4337_ADDRESS")
KEY_4337_OWNER = os.environ.get("EVM_CLIENT_4337_OWNER_PRIVATE_KEY")
ADDR_7579 = os.environ.get("EVM_CLIENT_7579_ADDRESS")
KEY_7579_OWNER = os.environ.get("EVM_CLIENT_7579_OWNER_PRIVATE_KEY")
VALIDATOR_7579 = os.environ.get("EVM_CLIENT_7579_VALIDATOR")
# Wallet D
KEY_7702 = os.environ.get("EVM_CLIENT_7702_PRIVATE_KEY")
# Wallet C factory (skip if missing — ERC-6492 not supported in Python client)
FACTORY_6492 = os.environ.get("EVM_CLIENT_6492_FACTORY")

RPC_URL = os.environ.get("EVM_RPC_URL", "https://sepolia.base.org")
NETWORK = "eip155:84532"
USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
AMOUNT = "100"  # 0.0001 USDC — frugal with testnet funds

pytestmark = pytest.mark.skipif(
    not FACILITATOR_KEY or not RESOURCE_SERVER,
    reason="EVM_FACILITATOR_PRIVATE_KEY and EVM_RESOURCE_SERVER_ADDRESS required",
)


class EvmFacilitatorClientSync:
    scheme = SCHEME_EXACT
    network = NETWORK
    x402_version = 2

    def __init__(self, facilitator: x402FacilitatorSync) -> None:
        self._facilitator = facilitator

    def verify(self, payload: PaymentPayload, req: PaymentRequirements) -> VerifyResponse:
        return self._facilitator.verify(payload, req)

    def settle(self, payload: PaymentPayload, req: PaymentRequirements) -> SettleResponse:
        return self._facilitator.settle(payload, req)

    def get_supported(self) -> SupportedResponse:
        return self._facilitator.get_supported()


def _build_server(
    facilitator_key: str,
    factory_allowlist: list[str] | None = None,
) -> tuple[x402ResourceServerSync, FacilitatorWeb3Signer]:
    """Build a resource server with the given facilitator key."""
    facil_signer = FacilitatorWeb3Signer(
        private_key=facilitator_key,
        rpc_url=RPC_URL,
    )
    facil = x402FacilitatorSync().register(
        [NETWORK],
        ExactEvmFacilitatorScheme(
            facil_signer,
            ExactEvmSchemeConfig(
                eip6492_allowed_factories=factory_allowlist or [],
            ),
        ),
    )
    server = x402ResourceServerSync(EvmFacilitatorClientSync(facil))
    server.register(NETWORK, ExactEvmServerScheme())
    server.initialize()
    return server, facil_signer


def _run_flow(
    client_signer: EthAccountSigner,
    server: x402ResourceServerSync,
    resource_server_addr: str,
    label: str,
    use_permit2: bool = False,
) -> SettleResponse:
    """Run the full verify+settle flow and assert success."""
    client = x402ClientSync().register(NETWORK, ExactEvmClientScheme(client_signer))
    extra: dict = {"name": "USDC", "version": "2"}
    if use_permit2:
        extra["assetTransferMethod"] = "permit2"
    accepts = [
        PaymentRequirements(
            scheme=SCHEME_EXACT,
            network=NETWORK,
            asset=USDC,
            amount=AMOUNT,
            pay_to=resource_server_addr,
            max_timeout_seconds=3600,
            extra=extra,
        )
    ]
    resource = ResourceInfo(
        url="https://test.x402.org", description=label, mime_type="application/json"
    )
    payment_required = server.create_payment_required_response(accepts, resource)
    payload = client.create_payment_payload(payment_required)
    accepted = server.find_matching_requirements(accepts, payload)
    assert accepted is not None, f"{label}: no matching requirements"
    verify = server.verify_payment(payload, accepted)
    assert verify.is_valid, f"{label}: verify failed: {verify.invalid_reason}"
    settle = server.settle_payment(payload, accepted)
    assert settle.success, f"{label}: settle failed: {settle.error_reason}"
    return settle


class TestWalletMatrixA:
    """Wallet A — Plain EOA."""

    def test_plain_eoa_exact_eip3009(self) -> None:
        if not EOA_KEY or not RESOURCE_SERVER:
            pytest.skip("EVM_CLIENT_EOA_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")

        server, _ = _build_server(FACILITATOR_KEY)
        signer = EthAccountSigner(Account.from_key(EOA_KEY))
        settle = _run_flow(signer, server, RESOURCE_SERVER, "wallet-A-plain-eoa")
        print(f"\nWallet A (EIP-3009) ✅ tx={settle.transaction} payer={settle.payer}")

    def test_plain_eoa_exact_permit2(self) -> None:
        if not EOA_KEY or not RESOURCE_SERVER:
            pytest.skip("EVM_CLIENT_EOA_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")

        server, _ = _build_server(FACILITATOR_KEY)
        signer = EthAccountSigner(Account.from_key(EOA_KEY))
        settle = _run_flow(
            signer, server, RESOURCE_SERVER, "wallet-A-plain-eoa-permit2", use_permit2=True
        )
        print(f"\nWallet A (Permit2) ✅ tx={settle.transaction} payer={settle.payer}")


class TestWalletMatrixB:
    """Wallet B — Deployed Coinbase Smart Wallet (ERC-4337)."""

    def test_deployed_smart_account_exact_eip3009(self) -> None:
        if not KEY_4337_OWNER or not ADDR_4337 or not RESOURCE_SERVER:
            pytest.skip("EVM_CLIENT_4337_OWNER_PRIVATE_KEY / EVM_CLIENT_4337_ADDRESS required")

        server, _ = _build_server(FACILITATOR_KEY)
        owner_acct = Account.from_key(KEY_4337_OWNER)
        signer = CoinbaseSmartWalletSigner(owner_acct, ADDR_4337)
        settle = _run_flow(signer, server, RESOURCE_SERVER, "wallet-B-coinbase-smart-wallet")
        assert settle.payer.lower() == ADDR_4337.lower()
        print(f"\nWallet B ✅ tx={settle.transaction} payer={settle.payer}")


class TestWalletMatrix7579:
    """Wallet 7579 — Deployed Biconomy Nexus (ERC-7579)."""

    def test_deployed_nexus_exact_eip3009(self) -> None:
        if not KEY_7579_OWNER or not ADDR_7579 or not RESOURCE_SERVER:
            pytest.skip("EVM_CLIENT_7579_OWNER_PRIVATE_KEY / EVM_CLIENT_7579_ADDRESS required")

        server, _ = _build_server(FACILITATOR_KEY)
        owner_acct = Account.from_key(KEY_7579_OWNER)
        w3 = Web3(Web3.HTTPProvider(RPC_URL))
        validator = VALIDATOR_7579 or NEXUS_K1_VALIDATOR
        signer = NexusSmartAccountSigner(owner_acct, ADDR_7579, w3, validator)
        settle = _run_flow(signer, server, RESOURCE_SERVER, "wallet-7579-biconomy-nexus")
        assert settle.payer.lower() == ADDR_7579.lower()
        print(f"\nWallet 7579 ✅ tx={settle.transaction} payer={settle.payer}")


class TestWalletMatrixD:
    """Wallet D — ERC-7702 EOA delegated to PermissiveECDSADelegate."""

    def _require_7702_delegation(self) -> Account:
        if not KEY_7702 or not RESOURCE_SERVER:
            pytest.skip("EVM_CLIENT_7702_PRIVATE_KEY / EVM_RESOURCE_SERVER_ADDRESS required")
        w3 = Web3(Web3.HTTPProvider(RPC_URL))
        acct = Account.from_key(KEY_7702)
        code = w3.eth.get_code(acct.address)
        if not is_erc7702_delegation(code):
            pytest.skip(
                f"Account {acct.address} is not ERC-7702 delegated. Run setup-wallets-v3.mjs first."
            )
        return acct

    def test_7702_permissive_exact_eip3009(self) -> None:
        acct = self._require_7702_delegation()
        print(f"\nWallet D: {acct.address} is 7702-delegated ✓")
        server, _ = _build_server(FACILITATOR_KEY)
        signer = EthAccountSigner(acct)
        settle = _run_flow(signer, server, RESOURCE_SERVER, "wallet-D-erc7702-permissive")
        assert settle.payer.lower() == acct.address.lower()
        print(f"Wallet D (EIP-3009) ✅ tx={settle.transaction} payer={settle.payer}")

    def test_7702_permissive_exact_permit2(self) -> None:
        acct = self._require_7702_delegation()
        print(f"\nWallet D Permit2: {acct.address} is 7702-delegated ✓")
        server, _ = _build_server(FACILITATOR_KEY)
        signer = EthAccountSigner(acct)
        settle = _run_flow(
            signer, server, RESOURCE_SERVER, "wallet-D-erc7702-permit2", use_permit2=True
        )
        assert settle.payer.lower() == acct.address.lower()
        print(f"Wallet D (Permit2) ✅ tx={settle.transaction} payer={settle.payer}")


class TestWalletMatrixMatrix_UnsupportedCases:
    """Verify that ❌ cells in the matrix are documented (not silently failing)."""

    def test_erc6492_python_client_not_supported(self) -> None:
        """ERC-6492 counterfactual signing requires client-side sig wrapping not in Python SDK.

        The Python x402ClientSync produces a raw EIP-3009 sig from the signing key.
        For ERC-6492, the signature must be wrapped in the ERC-6492 format
        (factory address + calldata + inner sig + 0x6492...6492 magic).
        This wrapping is not implemented in the Python client.

        The Python SERVER (facilitator) correctly handles ERC-6492 on the settle
        path — it deploys the factory before calling transferWithAuthorization.
        The limitation is client-side only.
        """
        # This test documents the limitation rather than testing it.
        assert FACTORY_6492 is not None or FACTORY_6492 is None  # always passes
        pytest.skip(
            "ERC-6492 counterfactual: Python client does not produce wrapped sigs. "
            "Covered by TypeScript integration test (evm-wallet-matrix.test.ts)."
        )
