"""Masumi issuance and lock verification use real signatures and inline data."""

import copy
import json
import time
from dataclasses import replace

import pytest
from pycardano import Address, Network, VerificationKeyHash

from x402.mechanisms.cardano import constants as c
from x402.mechanisms.cardano.exact.masumi.datum import parse_masumi_lock_datum
from x402.mechanisms.cardano.exact.masumi.issue import (
    issue_masumi_requirements,
    to_masumi_seller_signer,
)
from x402.mechanisms.cardano.exact.masumi.jcs import jcs
from x402.mechanisms.cardano.exact.masumi.lock import build_masumi_lock
from x402.mechanisms.cardano.exact.masumi.verify import (
    MasumiAuthorizationOptions,
    verify_masumi_authorization,
    verify_masumi_datum_invariants,
    verify_masumi_lock,
)
from x402.mechanisms.cardano.types import CardanoUtxoOutput, DecodedCardanoTransaction
from x402.mechanisms.cardano.utils import slot_to_posix_ms
from x402.schemas import PaymentRequirements

MNEMONIC = "abandon " * 11 + "about"
BUYER = str(Address(VerificationKeyHash(bytes.fromhex("11" * 28)), network=Network.TESTNET))


@pytest.fixture
def quote():
    seller = to_masumi_seller_signer(MNEMONIC, "cardano:preprod")
    now = int(time.time() * 1000)
    return issue_masumi_requirements(
        network="cardano:preprod",
        asset="lovelace",
        amount="5000000",
        max_timeout_seconds=120,
        seller_address=seller.seller_address,
        sign_terms=seller.sign_terms,
        commitment=[{"name": "request", "canonicalization": "jcs", "content": {"prompt": "hello"}}],
        pay_by_time=str(now + 90_000),
        submit_result_time=str(now + 1_200_000),
        unlock_time=str(now + 2_100_000),
        external_dispute_unlock_time=str(now + 3_000_000),
    )


def test_issued_quote_authorizes_and_binds_every_signed_term(quote):
    assert verify_masumi_authorization(quote.extra, quote).ok
    changed = quote.model_copy(deep=True, update={"amount": "5000001"})
    assert (
        verify_masumi_authorization(changed.extra, changed).reason == c.ERR_MASUMI_SELLER_SIGNATURE
    )
    changed = quote.model_copy(deep=True)
    changed.extra["inputCommitment"]["parts"][0]["content"] = {"prompt": "other"}
    assert verify_masumi_authorization(changed.extra, changed).reason == c.ERR_MASUMI_COMMITMENT


def test_client_requires_omitted_commitment_content(quote):
    extra = copy.deepcopy(quote.extra)
    del extra["inputCommitment"]["parts"][0]["content"]
    assert verify_masumi_authorization(extra, quote).ok
    options = MasumiAuthorizationOptions(require_all_part_content=True)
    assert verify_masumi_authorization(extra, quote, options).reason == c.ERR_MASUMI_COMMITMENT
    options.local_commitment_content = {"request": {"prompt": "hello"}}
    assert verify_masumi_authorization(extra, quote, options).ok


def test_lock_datum_and_verification(quote):
    lock = build_masumi_lock(quote.extra, BUYER, quote.asset, int(quote.amount), 4310)
    view = parse_masumi_lock_datum(lock.datum)
    assert view and view.buyer.payment.hash == "11" * 28
    assert verify_masumi_datum_invariants(view, quote.pay_to).ok
    assert lock.locked_lovelace == int(quote.amount) + lock.collateral_lovelace
    ttl = (int(quote.extra["terms"]["payByTime"]) - slot_to_posix_ms(quote.network, 0)) // 1000
    decoded = DecodedCardanoTransaction(
        "aa" * 32,
        [],
        [CardanoUtxoOutput(quote.pay_to, lock.locked_lovelace, datum=lock.datum.to_cbor_hex())],
        200_000,
        1000,
        ttl_slot=ttl,
        vkey_hashes=["11" * 28],
    )
    assert verify_masumi_lock(quote.extra, quote, decoded, BUYER, 4310).ok
    decoded.outputs[0].coin += 1
    assert (
        verify_masumi_lock(quote.extra, quote, decoded, BUYER, 4310).reason
        == c.ERR_MASUMI_COLLATERAL
    )
    assert not verify_masumi_datum_invariants(replace(view, buyer=view.seller), quote.pay_to).ok
    assert not verify_masumi_datum_invariants(replace(view, state=1), quote.pay_to).ok


def test_native_token_collateral_covers_future_result(quote):
    from x402.mechanisms.cardano.exact.masumi.constants import masumi_min_utxo_lovelace

    lock = build_masumi_lock(quote.extra, BUYER, "11" * 28 + ".", 1, 4310)
    assert lock.collateral_lovelace >= masumi_min_utxo_lovelace(len(lock.datum.to_cbor()), 1, 4310)
    assert lock.locked_lovelace == lock.collateral_lovelace


@pytest.mark.parametrize(
    "path,value",
    [
        (("terms", "sellerReturnAddress"), None),
        (("terms", "buyerNonce"), "00"),
        (("terms", "sellerNonce"), "AA" * 32),
        (("terms", "unknown"), True),
        (("confirmationPolicy",), None),
        (("areFeesSponsored",), True),
        (("unknown",), 1),
    ],
)
def test_closed_schema_rejects_invalid_wire_values(quote, path, value):
    from x402.mechanisms.cardano.exact.masumi.schema import validate_masumi_extra

    extra = copy.deepcopy(quote.extra)
    target = extra
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    assert not validate_masumi_extra(extra, quote.network).ok


def test_signed_numeric_commitment_survives_json_wire_roundtrip(quote):
    seller = to_masumi_seller_signer(MNEMONIC, quote.network)
    terms = quote.extra["terms"]
    numeric_quote = issue_masumi_requirements(
        network=quote.network,
        asset=quote.asset,
        amount=quote.amount,
        max_timeout_seconds=quote.max_timeout_seconds,
        seller_address=seller.seller_address,
        sign_terms=seller.sign_terms,
        commitment=[{"name": "request", "canonicalization": "jcs", "content": {"n": float(2**53)}}],
        pay_by_time=terms["payByTime"],
        submit_result_time=terms["submitResultTime"],
        unlock_time=terms["unlockTime"],
        external_dispute_unlock_time=terms["externalDisputeUnlockTime"],
    )
    assert verify_masumi_authorization(numeric_quote.extra, numeric_quote).ok
    # ECMAScript JSON.stringify emits this integral float without a decimal point.
    wire = jcs(numeric_quote.model_dump(by_alias=True))
    restored = PaymentRequirements.model_validate(json.loads(wire))
    assert type(restored.extra["inputCommitment"]["parts"][0]["content"]["n"]) is int
    assert restored.amount == quote.amount
    assert verify_masumi_authorization(restored.extra, restored).ok
