"""Build complete payments through a real PyCardano builder and offline provider."""

import httpx
import pytest
from pycardano import Address, Network, ScriptHash, VerificationKeyHash

from x402.mechanisms.cardano.exact.client import ExactCardanoScheme
from x402.mechanisms.cardano.exact.masumi.blueprint import masumi_escrow_address
from x402.mechanisms.cardano.exact.masumi.datum import parse_masumi_lock_datum
from x402.mechanisms.cardano.exact.masumi.issue import to_masumi_seller_signer
from x402.mechanisms.cardano.exact.masumi_issuer import MasumiIssuerConfig, MasumiQuoteIssuer
from x402.mechanisms.cardano.exact.script_address import derive_script_hash_hex
from x402.mechanisms.cardano.provider import (
    BlockfrostConfig,
    CardanoProvider,
    CardanoProviderConfig,
)
from x402.mechanisms.cardano.signers import ClientCardanoSignerConfig, PyCardanoClientSigner
from x402.mechanisms.cardano.utils import decode_cardano_transaction
from x402.mechanisms.cardano.wallet import derive_wallet
from x402.schemas import PaymentRequired, PaymentRequirements, ResourceInfo

MNEMONIC = "abandon " * 11 + "about"
NETWORK = "cardano:preprod"
ASSET = "11" * 28 + ".abcd"
PARAMETERS = {
    "min_fee_a": 44,
    "min_fee_b": 155381,
    "max_block_size": 90112,
    "max_tx_size": 16384,
    "max_block_header_size": 1100,
    "key_deposit": "2000000",
    "pool_deposit": "500000000",
    "a0": 0.3,
    "rho": 0.003,
    "tau": 0.2,
    "protocol_major_ver": 10,
    "protocol_minor_ver": 0,
    "min_pool_cost": "170000000",
    "price_mem": 0.0577,
    "price_step": 0.0000721,
    "max_tx_ex_mem": "14000000",
    "max_tx_ex_steps": "10000000000",
    "max_block_ex_mem": "62000000",
    "max_block_ex_steps": "20000000000",
    "max_val_size": "5000",
    "collateral_percent": 150,
    "max_collateral_inputs": 3,
    "coins_per_utxo_size": "4310",
    "cost_models": {},
}


@pytest.fixture
def wallet():
    funding = derive_wallet(MNEMONIC, NETWORK)
    config = CardanoProviderConfig(blockfrost=BlockfrostConfig("https://example.invalid"))
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/epochs/latest/parameters":
            return httpx.Response(200, json=PARAMETERS)
        assert request.url.path == f"/addresses/{funding.address}/utxos"
        return httpx.Response(
            200,
            json=[
                {
                    "tx_hash": "ab" * 32,
                    "output_index": 0,
                    "address": funding.address,
                    "amount": [
                        {"unit": "lovelace", "quantity": "20000000"},
                        {"unit": ASSET.replace(".", ""), "quantity": "100"},
                    ],
                }
            ],
        )

    provider = CardanoProvider(
        config, NETWORK, client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    signer = PyCardanoClientSigner(
        ClientCardanoSignerConfig(MNEMONIC, NETWORK, config), provider=provider
    )
    return signer, calls


@pytest.mark.parametrize(
    "method,asset",
    [
        ("default", "lovelace"),
        ("default", ASSET),
        ("script", "lovelace"),
        ("masumi", "lovelace"),
        ("masumi", ASSET),
    ],
)
def test_real_transaction_builder_all_transfer_methods(wallet, method, asset):
    signer, calls = wallet
    recipient = str(Address(VerificationKeyHash(bytes.fromhex("22" * 28)), network=Network.TESTNET))
    extra = {"assetTransferMethod": method}
    if method == "script":
        extra.update(
            script={"type": "plutusV3", "code": "4d01000033222220051200120011"}, datum="d87980"
        )
        recipient = str(
            Address(
                ScriptHash(bytes.fromhex(derive_script_hash_hex(extra))), network=Network.TESTNET
            )
        )
    if method == "masumi":
        recipient = masumi_escrow_address(NETWORK)
    requirement = PaymentRequirements(
        scheme="exact",
        network=NETWORK,
        asset=asset,
        amount="5000000" if asset == "lovelace" else "10",
        pay_to=recipient,
        max_timeout_seconds=120,
        extra=extra,
    )
    if method == "masumi":
        seller = to_masumi_seller_signer(MNEMONIC, NETWORK, account_index=1)
        requirement = MasumiQuoteIssuer(MasumiIssuerConfig(seller)).issue(
            requirement, ResourceInfo(url="https://example.test/service"), None
        )
    payload = ExactCardanoScheme(signer).create_payment_payload(requirement)
    decoded = decode_cardano_transaction(payload["transaction"])
    assert decoded.signatures_valid and decoded.is_valid
    assert payload["nonce"] in decoded.inputs
    payment = next(output for output in decoded.outputs if output.address == recipient)
    assert payment.coin >= (5_000_000 if asset == "lovelace" else 1)
    if asset != "lovelace":
        assert payment.assets[asset] == 10
    if method == "script":
        assert payment.datum == "d87980"
    if method == "masumi":
        datum = parse_masumi_lock_datum(payment.datum)
        assert datum and datum.seller != datum.buyer
        assert (
            payment.coin
            == (5_000_000 if asset == "lovelace" else 0) + datum.collateral_return_lovelace
        )
    assert set(calls) == {f"/addresses/{signer.get_address()}/utxos", "/epochs/latest/parameters"}


def test_malformed_masumi_rejected_before_provider_access(wallet):
    signer, calls = wallet
    requirement = PaymentRequirements(
        scheme="exact",
        network=NETWORK,
        asset="lovelace",
        amount="5000000",
        pay_to=masumi_escrow_address(NETWORK),
        max_timeout_seconds=120,
        extra={"assetTransferMethod": "masumi"},
    )
    with pytest.raises(ValueError, match="authorization"):
        ExactCardanoScheme(signer).create_payment_payload(requirement)
    assert not calls


def test_plain_ada_below_minimum_utxo_is_rejected(wallet):
    buyer, _ = wallet
    requirement = PaymentRequirements(
        scheme="exact",
        network=NETWORK,
        asset="lovelace",
        amount="1",
        pay_to=buyer.get_address(),
        max_timeout_seconds=120,
    )
    with pytest.raises(ValueError, match="minimum UTxO"):
        ExactCardanoScheme(buyer).create_payment_payload(requirement)


@pytest.mark.parametrize("registered", [False, True])
def test_core_client_carries_resource_for_registry_and_accepts_json_null(wallet, registered):
    from x402 import x402ClientSync
    from x402.mechanisms.cardano.exact.masumi.constants import MASUMI_REGISTRY_POLICY_ID

    signer, _ = wallet
    resource = ResourceInfo(url="https://example.test/registered-agent")
    claims = []
    signer.config.validate_masumi_registry_claim = lambda claim: claims.append(claim) or True
    seller = to_masumi_seller_signer(MNEMONIC, NETWORK, account_index=1)
    config = MasumiIssuerConfig(
        seller,
        commitment=lambda context: [{"name": "body", "canonicalization": "jcs", "content": None}],
    )
    if registered:
        config.agent_identifier = MASUMI_REGISTRY_POLICY_ID + "00"
    template = PaymentRequirements(
        scheme="exact",
        network=NETWORK,
        asset="lovelace",
        amount="5000000",
        pay_to=masumi_escrow_address(NETWORK),
        max_timeout_seconds=120,
        extra={"assetTransferMethod": "masumi"},
    )
    quote = MasumiQuoteIssuer(config).issue(template, resource, None)
    client = x402ClientSync().register("cardano:*", ExactCardanoScheme(signer))
    client.set_spend_controls(False)
    payload = client.create_payment_payload(PaymentRequired(resource=resource, accepts=[quote]))
    assert decode_cardano_transaction(payload.payload["transaction"]).signatures_valid
    assert len(claims) == int(registered)
    if registered:
        assert claims[0]["resource"] == resource


@pytest.mark.parametrize("method", ["default", "script", "masumi"])
@pytest.mark.parametrize("asset", ["lovelace", ASSET])
def test_full_core_flow_verifies_and_reconciles_each_transfer_method(wallet, method, asset):
    from x402 import x402ClientSync, x402FacilitatorSync, x402ResourceServerSync
    from x402.mechanisms.cardano.exact import (
        ExactCardanoFacilitatorScheme,
        ExactCardanoServerScheme,
    )
    from x402.mechanisms.cardano.types import CardanoSettlementEvidence, CardanoUtxoSnapshot

    from .test_facilitator import Chain

    buyer, _ = wallet
    chain = Chain(buyer.get_address())
    chain.slot = buyer._provider.last_block_slot
    chain.get_utxo = lambda ref, network: CardanoUtxoSnapshot(
        chain.exists, buyer.get_address(), 20_000_000, {ASSET: 100}
    )
    relay = ExactCardanoFacilitatorScheme(chain, confirmation_timeout_ms=0)
    facilitator = x402FacilitatorSync().register([NETWORK], relay)
    seller = to_masumi_seller_signer(MNEMONIC, NETWORK, account_index=1)
    server = x402ResourceServerSync(facilitator).register(
        "cardano:*", ExactCardanoServerScheme(masumi=MasumiIssuerConfig(seller))
    )
    server.initialize()
    client = x402ClientSync().register("cardano:*", ExactCardanoScheme(buyer))
    client.set_spend_controls(False)
    extra = {"assetTransferMethod": method}
    recipient = str(Address(VerificationKeyHash(bytes.fromhex("22" * 28)), network=Network.TESTNET))
    if method == "masumi":
        recipient = masumi_escrow_address(NETWORK)
    elif method == "script":
        extra.update(
            script={"type": "plutusV3", "code": "4d01000033222220051200120011"}, datum="d87980"
        )
        recipient = str(
            Address(
                ScriptHash(bytes.fromhex(derive_script_hash_hex(extra))), network=Network.TESTNET
            )
        )
    template = PaymentRequirements(
        scheme="exact",
        network=NETWORK,
        asset=asset,
        amount="5000000" if asset == "lovelace" else "10",
        pay_to=recipient,
        max_timeout_seconds=120,
        extra=extra,
    )
    required = server.create_payment_required_response(
        [template], ResourceInfo(url="https://example.test/flow")
    )
    quote = required.accepts[0]
    payload = client.create_payment_payload(required)
    result = server.verify_payment(payload, quote)
    assert result.is_valid, result
    pending = server.settle_payment(payload, quote)
    assert pending.error_reason == "settlement_pending"
    chain.evidence = CardanoSettlementEvidence("confirmed", 1)
    settled = server.settle_payment(payload, quote)
    assert settled.success and settled.transaction == pending.transaction
    assert chain.submissions == 1
