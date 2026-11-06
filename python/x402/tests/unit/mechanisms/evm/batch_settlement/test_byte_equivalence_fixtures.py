"""Check existing Python signing paths against static viem EIP-712 digests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest

try:
    from eth_account.messages import encode_typed_data
    from eth_utils import keccak
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)

from x402.mechanisms.evm.batch_settlement.authorizer_signer import (
    sign_claim_batch,
    sign_refund,
)
from x402.mechanisms.evm.batch_settlement.client.voucher import sign_voucher
from x402.mechanisms.evm.batch_settlement.types import ChannelConfig, VoucherClaim
from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id

FIXTURE_DIR = Path(__file__).parents[4] / "fixtures" / "batch-settlement-byte-equivalence" / "v0"


def _fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURE_DIR / f"{name}.json").read_text())


def _digest(domain, types, primary_type, message) -> str:
    signable = encode_typed_data(
        full_message={
            "domain": domain,
            "types": types,
            "primaryType": primary_type,
            "message": message,
        }
    )
    return "0x" + keccak(b"\x19" + signable.version + signable.header + signable.body).hex()


def _assert_signed_digest(signer: Mock, fixture: dict[str, Any]) -> None:
    signer.sign_typed_data.assert_called_once()
    args, kwargs = signer.sign_typed_data.call_args
    assert _digest(*args, **kwargs) == fixture["expected_digest"]


def test_channel_config_fixture() -> None:
    fixture = _fixture("L2.1-channel-config")
    config = ChannelConfig.from_dict(fixture["input"])
    assert compute_channel_id(config, fixture["domain"]["chainId"]) == fixture["expected_digest"]


def test_voucher_fixture() -> None:
    fixture = _fixture("L2.2-voucher")
    inp = fixture["input"]
    signer = Mock(spec_set=["sign_typed_data"])
    signer.sign_typed_data.return_value = bytes(65)
    sign_voucher(
        signer,
        inp["channelId"],
        inp["maxClaimableAmount"],
        f"eip155:{fixture['domain']['chainId']}",
    )
    _assert_signed_digest(signer, fixture)


def test_refund_fixture() -> None:
    fixture = _fixture("L2.4-refund")
    inp = fixture["input"]
    signer = Mock(spec_set=["sign_typed_data"])
    signer.sign_typed_data.return_value = "0x" + "00" * 65
    sign_refund(
        signer,
        inp["channelId"],
        inp["amount"],
        inp["nonce"],
        f"eip155:{fixture['domain']['chainId']}",
    )
    _assert_signed_digest(signer, fixture)


def test_claim_batch_fixture() -> None:
    fixture = _fixture("L2.3-claim-batch")
    channel_fixture = _fixture("L2.1-channel-config")
    config = ChannelConfig.from_dict(channel_fixture["input"])
    claims = []
    for claim in fixture["input"]["claims"]:
        assert claim["channelId"] == channel_fixture["expected_digest"]
        claims.append(
            VoucherClaim(
                channel=config,
                max_claimable_amount=claim["maxClaimableAmount"],
                total_claimed=claim["totalClaimed"],
                signature="0x" + "00" * 65,
            )
        )
    signer = Mock(spec_set=["sign_typed_data"])
    signer.sign_typed_data.return_value = "0x" + "00" * 65
    sign_claim_batch(signer, claims, f"eip155:{fixture['domain']['chainId']}")
    _assert_signed_digest(signer, fixture)
