"""Verify and settle real signed Cardano transactions with controlled chain state."""

import base64
from concurrent.futures import ThreadPoolExecutor
from hashlib import blake2b
from threading import Event
from types import SimpleNamespace

import cbor2
import pytest
from nacl.signing import SigningKey
from pycardano import Address

from x402.mechanisms.cardano import constants as c
from x402.mechanisms.cardano.exact.facilitator import ExactCardanoScheme
from x402.mechanisms.cardano.types import (
    CardanoProtocolParameters,
    CardanoSettlementEvidence,
    CardanoSubmissionResult,
    CardanoUtxoSnapshot,
)
from x402.schemas import PaymentPayload, PaymentRequirements


class Chain:
    def __init__(self, payer):
        self.payer = payer
        self.exists = True
        self.evidence = CardanoSettlementEvidence("unknown", -2)
        self.submissions = 0
        self.error = None
        self.slot = 1000

    def get_addresses(self):
        return []

    def get_current_slot(self, network):
        return self.slot

    def get_protocol_parameters(self, network):
        return CardanoProtocolParameters(4310, 44, 155381)

    def get_transaction_evidence(self, tx_hash, network):
        return self.evidence

    def get_utxo(self, ref, network):
        return CardanoUtxoSnapshot(
            self.exists,
            self.payer,
            5_200_000 if self.exists else None,
            {},
            bytes(Address.from_primitive(self.payer))[1:].hex(),
        )

    def submit_transaction(self, transaction, network):
        self.submissions += 1
        self.exists = False
        if self.error:
            raise self.error
        from x402.mechanisms.cardano.utils import decode_cardano_transaction

        return CardanoSubmissionResult(decode_cardano_transaction(transaction).tx_hash, "mempool")


@pytest.fixture
def payment():
    key = SigningKey(bytes(range(32)))
    payer_bytes = bytes([0x60]) + blake2b(bytes(key.verify_key), digest_size=28).digest()
    recipient_bytes = bytes([0x60]) + bytes.fromhex("22" * 28)
    payer = str(Address.from_primitive(payer_bytes))
    body = {0: [[bytes(32), 0]], 1: [{0: recipient_bytes, 1: 5_000_000}], 2: 200_000, 3: 1060}
    digest = blake2b(cbor2.dumps(body), digest_size=32).digest()
    raw = cbor2.dumps(
        [body, {0: [[bytes(key.verify_key), key.sign(digest).signature]]}, True, None]
    )
    requirements = PaymentRequirements(
        scheme="exact",
        network="cardano:preprod",
        asset="lovelace",
        amount="5000000",
        pay_to=str(Address.from_primitive(recipient_bytes)),
        max_timeout_seconds=120,
    )
    payload = PaymentPayload(
        accepted=requirements,
        payload={"transaction": base64.b64encode(raw).decode(), "nonce": "00" * 32 + "#0"},
    )
    return payload, requirements, Chain(payer)


def scheme(chain, **kwargs):
    return ExactCardanoScheme(chain, confirmation_timeout_ms=0, **kwargs)


def test_verify_and_pending_retry_does_not_resubmit(payment):
    payload, requirements, chain = payment
    facilitator = scheme(chain)
    assert facilitator.verify(payload, requirements).is_valid
    first = facilitator.settle(payload, requirements)
    assert not first.success and first.error_reason == c.ERR_SETTLEMENT_PENDING
    assert first.extra["transactionId"] == first.transaction
    chain.evidence = CardanoSettlementEvidence("confirmed", 1)
    assert facilitator.verify(payload, requirements).is_valid
    second = facilitator.settle(payload, requirements)
    assert second.success and second.transaction == first.transaction
    assert chain.submissions == 1


@pytest.mark.parametrize(
    "change,reason",
    [
        ({"amount": "5000001"}, c.ERR_AMOUNT_INSUFFICIENT),
        ({"amount": "0"}, c.ERR_REQUIREMENTS_INVALID),
        ({"network": "cardano:mainnet"}, c.ERR_NETWORK_MISMATCH),
        ({"asset": "11" * 28 + "."}, c.ERR_ASSET_MISMATCH),
        ({"extra": {"confirmationPolicy": None}}, c.ERR_POLICY_INVALID),
        (
            {"extra": {"assetTransferMethod": "script", "scriptHash": "11" * 28}},
            c.ERR_SCRIPT_ADDRESS_MISMATCH,
        ),
    ],
)
def test_canonical_requirements_control_verification(payment, change, reason):
    payload, requirements, chain = payment
    result = scheme(chain).verify(payload, requirements.model_copy(update=change))
    assert not result.is_valid and result.invalid_reason == reason


def test_spent_input_and_expired_ttl_rejected_before_broadcast(payment):
    payload, requirements, chain = payment
    chain.exists = False
    assert scheme(chain).verify(payload, requirements).invalid_reason == c.ERR_NONCE_NOT_ON_CHAIN
    chain.exists = True
    chain.slot = 1060
    assert scheme(chain).verify(payload, requirements).invalid_reason == c.ERR_TTL_EXPIRED


@pytest.mark.parametrize("validity_start", [None, 900])
@pytest.mark.parametrize("confirmed", [False, True])
def test_missing_ttl_requires_authenticated_acceptance(payment, validity_start, confirmed):
    payload, requirements, chain = payment
    raw = cbor2.loads(base64.b64decode(payload.payload["transaction"]))
    del raw[0][3]
    if validity_start is not None:
        raw[0][8] = validity_start
    key = SigningKey(bytes(range(32)))
    digest = blake2b(cbor2.dumps(raw[0]), digest_size=32).digest()
    raw[1][0][0][1] = key.sign(digest).signature
    payload.payload["transaction"] = base64.b64encode(cbor2.dumps(raw)).decode()
    if confirmed:
        chain.evidence = CardanoSettlementEvidence("confirmed", 1)
        chain.exists = False
    facilitator = scheme(chain)
    result = facilitator.verify(payload, requirements)
    assert result.is_valid is confirmed
    if not confirmed:
        assert result.invalid_reason == c.ERR_TTL_TOO_FAR
        assert not facilitator.settle(payload, requirements).success
        assert chain.submissions == 0


def test_unknown_submission_error_retains_claim(payment):
    payload, requirements, chain = payment
    chain.error = TimeoutError("node response lost")
    facilitator = scheme(chain)
    assert facilitator.settle(payload, requirements).error_reason == c.ERR_SETTLEMENT_FAILED
    chain.error = None
    chain.evidence = CardanoSettlementEvidence("confirmed", 1)
    assert facilitator.settle(payload, requirements).success
    assert chain.submissions == 1


def test_valid_signature_from_unrelated_key_does_not_authorize_funding_input(payment):
    payload, requirements, chain = payment
    chain.payer = str(Address.from_primitive(bytes([0x60]) + bytes.fromhex("44" * 28)))
    facilitator = scheme(chain)
    result = facilitator.verify(payload, requirements)
    assert not result.is_valid
    assert result.invalid_reason == c.ERR_TRANSACTION_PHASE1_INVALID
    assert not facilitator.settle(payload, requirements).success
    assert chain.submissions == 0


def test_transaction_required_signers_must_have_witnesses(payment):
    payload, requirements, chain = payment
    raw = cbor2.loads(base64.b64decode(payload.payload["transaction"]))
    raw[0][14] = [bytes.fromhex("44" * 28)]
    signer = SigningKey(bytes(range(32)))
    digest = blake2b(cbor2.dumps(raw[0]), digest_size=32).digest()
    raw[1][0][0][1] = signer.sign(digest).signature
    payload.payload["transaction"] = base64.b64encode(cbor2.dumps(raw)).decode()
    result = scheme(chain).verify(payload, requirements)
    assert not result.is_valid and result.invalid_reason == c.ERR_TRANSACTION_PHASE1_INVALID


def test_koios_reference_signer_reconciles_a_confirmed_retry(payment):
    from x402.mechanisms.cardano.provider import CardanoProviderConfig, KoiosConfig
    from x402.mechanisms.cardano.signers import (
        FacilitatorCardanoSignerConfig,
        ProviderCardanoFacilitatorSigner,
    )

    payload, requirements, chain = payment
    requirements.extra = {"confirmationPolicy": {"l1Confirmations": 0}}
    provider = SimpleNamespace(
        last_block_slot=1000,
        protocol_param=SimpleNamespace(
            coins_per_utxo_byte=4310, min_fee_coefficient=44, min_fee_constant=155381
        ),
        get_utxo=lambda ref: chain.get_utxo(ref, requirements.network),
        get_transaction_evidence=lambda tx: chain.evidence,
        submit_tx_cbor=lambda raw: (
            chain.submit_transaction(base64.b64encode(raw).decode(), requirements.network).tx_hash
        ),
        wait_for_confirmation=lambda tx: setattr(
            chain, "evidence", CardanoSettlementEvidence("confirmed", 0)
        ),
    )
    signer = ProviderCardanoFacilitatorSigner(
        FacilitatorCardanoSignerConfig(
            requirements.network,
            CardanoProviderConfig(koios=KoiosConfig("https://example.invalid")),
        ),
        provider=provider,
    )
    facilitator = scheme(signer)
    assert facilitator.get_extra(requirements.network)["l1Confirmations"]["maximum"] == 0
    assert facilitator.settle(payload, requirements).success
    assert facilitator.settle(payload, requirements).success
    assert chain.submissions == 1


def test_koios_evidence_checks_the_onchain_validity_flag(payment):
    import httpx

    from x402.mechanisms.cardano.provider import CardanoProvider, CardanoProviderConfig, KoiosConfig
    from x402.mechanisms.cardano.utils import decode_cardano_transaction

    payload, requirements, _ = payment
    raw = base64.b64decode(payload.payload["transaction"])
    tx_hash = decode_cardano_transaction(payload.payload["transaction"]).tx_hash
    rows = []

    def handler(request):
        assert request.url.path == "/tx_cbor"
        return httpx.Response(200, json=rows)

    provider = CardanoProvider(
        CardanoProviderConfig(koios=KoiosConfig("https://example.invalid")),
        requirements.network,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert provider.get_transaction_evidence(tx_hash).status == "unknown"
    rows.append({"tx_hash": tx_hash, "block_hash": "cd" * 32, "cbor": raw.hex()})
    assert provider.get_transaction_evidence(tx_hash) == CardanoSettlementEvidence("confirmed", 0)
    invalid = cbor2.loads(raw)
    invalid[2] = False
    rows[0]["cbor"] = cbor2.dumps(invalid).hex()
    assert provider.get_transaction_evidence(tx_hash).status == "unknown"


def test_mempool_requires_operator_opt_in(payment):
    payload, requirements, chain = payment
    requirements.extra = {"confirmationPolicy": {"l1Confirmations": -1}}
    assert scheme(chain, accept_mempool=True).settle(payload, requirements).success
    assert chain.submissions == 1


def test_resumed_payment_still_checks_recipient(payment):
    payload, requirements, chain = payment
    facilitator = scheme(chain)
    facilitator.settle(payload, requirements)
    changed = requirements.model_copy(update={"pay_to": chain.payer})
    assert facilitator.settle(payload, changed).error_reason == c.ERR_RECIPIENT_MISMATCH
    assert chain.submissions == 1


def test_concurrent_settlements_only_submit_once(payment):
    payload, requirements, chain = payment
    entered, release = Event(), Event()
    submit = chain.submit_transaction

    def delayed(*args):
        entered.set()
        assert release.wait(5)
        return submit(*args)

    chain.submit_transaction = delayed
    facilitator = scheme(chain)
    with ThreadPoolExecutor(2) as executor:
        first = executor.submit(facilitator.settle, payload, requirements)
        assert entered.wait(5)
        second = facilitator.settle(payload, requirements)
        release.set()
        first.result()
    assert second.error_reason == c.ERR_DUPLICATE_SETTLEMENT
    assert chain.submissions == 1
