"""Confirmation policy validation."""

import pytest


def test_policy_defaults_and_evidence_order():
    from x402.mechanisms.cardano.policy import confirmations_satisfy, resolve_cardano_policies

    assert resolve_cardano_policies({}).confirmation_policy.l1_confirmations == 1
    assert confirmations_satisfy(0, -1)
    assert confirmations_satisfy(2, 1)
    assert not confirmations_satisfy(0, 1)


@pytest.mark.parametrize("depth", [-1, 0, 1, 20])
def test_valid_confirmation_policy(depth):
    from x402.mechanisms.cardano.policy import normalize_confirmation_policy

    assert normalize_confirmation_policy({"l1Confirmations": depth}).l1_confirmations == depth


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        [],
        True,
        {"l1Confirmations": True},
        {"l1Confirmations": "1"},
        {"l1Confirmations": -2},
        {"l1Confirmations": 21},
        {"l1Confirmations": 1.5},
        {"l1Confirmations": 1, "extra": 0},
    ],
)
def test_invalid_confirmation_policy(value):
    from x402.mechanisms.cardano.policy import (
        normalize_confirmation_policy,
        resolve_cardano_policies,
    )

    assert normalize_confirmation_policy(value) is None
    assert resolve_cardano_policies({"confirmationPolicy": value}) is None
