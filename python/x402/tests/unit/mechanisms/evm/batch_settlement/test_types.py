"""Unit tests for batch-settlement wire-format types.

Round-trips every dataclass through `to_dict` / `from_dict` so the camelCase
↔ snake_case mapping stays in sync with the TS / Go SDKs, and exercises the
`is_*_payload` discriminators used by the facilitator and resource server.
"""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        ChannelStateExtra,
        ClaimPayload,
        DepositAuthorization,
        DepositFields,
        DepositPayload,
        EnrichedRefundPayload,
        Erc3009Authorization,
        PaymentRequirementsExtra,
        PaymentResponseExtra,
        Permit2Authorization,
        Permit2DepositWitness,
        Permit2TokenPermissions,
        RefundPayload,
        SettlePayload,
        VoucherClaim,
        VoucherFields,
        VoucherPayload,
        VoucherStateExtra,
        is_claim_payload,
        is_deposit_payload,
        is_enriched_refund_payload,
        is_refund_payload,
        is_settle_payload,
        is_voucher_payload,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer="0x2222222222222222222222222222222222222222",
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token="0x5555555555555555555555555555555555555555",
        withdraw_delay=900,
        salt="0x" + "00" * 31 + "01",
    )


def _voucher_fields(amount: str = "1000") -> VoucherFields:
    return VoucherFields(
        channel_id="0x" + "ab" * 32,
        max_claimable_amount=amount,
        signature="0xdeadbeef",
    )


class TestChannelConfigRoundTrip:
    def test_to_dict_uses_camel_case(self):
        d = _channel_config().to_dict()
        assert set(d.keys()) == {
            "payer",
            "payerAuthorizer",
            "receiver",
            "receiverAuthorizer",
            "token",
            "withdrawDelay",
            "salt",
        }

    def test_round_trip(self):
        cfg = _channel_config()
        assert ChannelConfig.from_dict(cfg.to_dict()) == cfg


class TestVoucherFieldsRoundTrip:
    def test_round_trip(self):
        v = _voucher_fields()
        assert VoucherFields.from_dict(v.to_dict()) == v

    def test_coerces_int_max_claimable(self):
        d = {
            "channelId": "0xab",
            "maxClaimableAmount": 1000,  # integer, not string
            "signature": "0x",
        }
        v = VoucherFields.from_dict(d)
        assert v.max_claimable_amount == "1000"


class TestErc3009AuthorizationRoundTrip:
    def test_round_trip(self):
        a = Erc3009Authorization(
            valid_after="0",
            valid_before="9999",
            salt="0x01",
            signature="0xdead",
        )
        assert Erc3009Authorization.from_dict(a.to_dict()) == a


class TestPermit2AuthorizationRoundTrip:
    def test_round_trip(self):
        a = Permit2Authorization(
            from_address="0x" + "11" * 20,
            permitted=Permit2TokenPermissions(token="0x" + "55" * 20, amount="100"),
            spender="0x" + "22" * 20,
            nonce="42",
            deadline="9999",
            witness=Permit2DepositWitness(channel_id="0x" + "ab" * 32),
            signature="0xdead",
        )
        # Permit2 stores `from` on the wire; verify the key naming.
        d = a.to_dict()
        assert d["from"] == a.from_address
        assert d["witness"]["channelId"] == "0x" + "ab" * 32
        assert Permit2Authorization.from_dict(d) == a


class TestDepositPayloadRoundTrip:
    def test_round_trip(self):
        deposit = DepositFields(
            amount="1000",
            authorization=DepositAuthorization(
                erc3009_authorization=Erc3009Authorization(
                    valid_after="0",
                    valid_before="9999",
                    salt="0x01",
                    signature="0xdead",
                )
            ),
        )
        p = DepositPayload()
        p.channel_config = _channel_config()
        p.voucher = _voucher_fields()
        p.deposit = deposit

        d = p.to_dict()
        assert d["type"] == "deposit"
        assert is_deposit_payload(d)

        p2 = DepositPayload.from_dict(d)
        assert p2.to_dict() == d


class TestVoucherPayloadRoundTrip:
    def test_round_trip(self):
        p = VoucherPayload()
        p.channel_config = _channel_config()
        p.voucher = _voucher_fields()

        d = p.to_dict()
        assert d["type"] == "voucher"
        assert is_voucher_payload(d)

        assert VoucherPayload.from_dict(d).to_dict() == d


class TestRefundPayloadRoundTrip:
    def test_round_trip_no_amount(self):
        p = RefundPayload()
        p.channel_config = _channel_config()
        p.voucher = _voucher_fields()

        d = p.to_dict()
        assert d["type"] == "refund"
        assert "amount" not in d
        assert is_refund_payload(d)

        assert RefundPayload.from_dict(d).to_dict() == d

    def test_round_trip_with_amount(self):
        p = RefundPayload()
        p.channel_config = _channel_config()
        p.voucher = _voucher_fields()
        p.amount = "500"

        d = p.to_dict()
        assert d["amount"] == "500"
        assert RefundPayload.from_dict(d).amount == "500"


class TestClaimPayloadRoundTrip:
    def test_round_trip(self):
        p = ClaimPayload(
            claims=[
                VoucherClaim(
                    channel=_channel_config(),
                    max_claimable_amount="1000",
                    signature="0xdead",
                    total_claimed="0",
                )
            ],
            claim_authorizer_signature="0xfeed",
        )

        d = p.to_dict()
        assert d["type"] == "claim"
        assert is_claim_payload(d)
        assert d["claimAuthorizerSignature"] == "0xfeed"

        p2 = ClaimPayload.from_dict(d)
        assert p2.to_dict() == d


class TestSettlePayloadRoundTrip:
    def test_round_trip(self):
        p = SettlePayload(receiver="0x" + "33" * 20, token="0x" + "55" * 20)
        d = p.to_dict()
        assert d == {"type": "settle", "receiver": p.receiver, "token": p.token}
        assert is_settle_payload(d)
        assert SettlePayload.from_dict(d) == p


class TestEnrichedRefundPayload:
    def test_round_trip(self):
        p = EnrichedRefundPayload()
        p.channel_config = _channel_config()
        p.voucher = _voucher_fields()
        p.amount = "500"
        p.refund_nonce = "7"
        p.claims = [
            VoucherClaim(
                channel=_channel_config(),
                max_claimable_amount="100",
                signature="0xdead",
                total_claimed="0",
            )
        ]
        p.refund_authorizer_signature = "0xrefund"
        p.claim_authorizer_signature = "0xclaim"

        d = p.to_dict()
        assert is_enriched_refund_payload(d)
        assert d["refundNonce"] == "7"

        assert EnrichedRefundPayload.from_dict(d).to_dict() == d

    def test_is_enriched_distinguishes_from_plain_refund(self):
        plain = RefundPayload()
        plain.channel_config = _channel_config()
        plain.voucher = _voucher_fields()
        d = plain.to_dict()
        assert is_refund_payload(d)
        assert not is_enriched_refund_payload(d)


class TestPayloadDiscriminators:
    @pytest.mark.parametrize(
        "discriminator,payload",
        [
            (is_deposit_payload, {"type": "voucher"}),
            (is_voucher_payload, {"type": "deposit"}),
            (is_claim_payload, {"type": "settle"}),
            (is_settle_payload, {"type": "claim"}),
        ],
    )
    def test_wrong_type_returns_false(self, discriminator, payload):
        assert discriminator(payload) is False

    def test_non_dict_returns_false(self):
        assert is_deposit_payload("not-a-dict") is False  # type: ignore[arg-type]
        assert is_voucher_payload(None) is False  # type: ignore[arg-type]


class TestChannelStateExtra:
    def test_round_trip_minimal(self):
        e = ChannelStateExtra(channel_id="0xabc", balance="1000", total_claimed="0")
        d = e.to_dict()
        assert d == {
            "channelId": "0xabc",
            "balance": "1000",
            "totalClaimed": "0",
            "withdrawRequestedAt": 0,
            "refundNonce": "0",
        }
        assert ChannelStateExtra.from_dict(d) == e

    def test_round_trip_with_optional_fields(self):
        e = ChannelStateExtra(
            channel_id="0xabc",
            balance="1000",
            total_claimed="500",
            withdraw_requested_at=12345,
            refund_nonce="3",
            charged_cumulative_amount="200",
        )
        assert ChannelStateExtra.from_dict(e.to_dict()) == e


class TestPaymentRequirementsExtra:
    def test_round_trip_minimal(self):
        r = PaymentRequirementsExtra(
            receiver_authorizer="0x" + "44" * 20,
            withdraw_delay=900,
            name="USDC",
            version="2",
        )
        assert PaymentRequirementsExtra.from_dict(r.to_dict()) == r

    def test_round_trip_with_state_snapshots(self):
        r = PaymentRequirementsExtra(
            receiver_authorizer="0x" + "44" * 20,
            withdraw_delay=900,
            name="USDC",
            version="2",
            asset_transfer_method="permit2",
            channel_state=ChannelStateExtra(channel_id="0xabc", balance="1000", total_claimed="0"),
            voucher_state=VoucherStateExtra(signed_max_claimable="500", signature="0xdead"),
        )
        d = r.to_dict()
        assert d["assetTransferMethod"] == "permit2"
        assert d["channelState"]["balance"] == "1000"
        assert d["voucherState"]["signedMaxClaimable"] == "500"
        assert PaymentRequirementsExtra.from_dict(d) == r


class TestPaymentResponseExtra:
    def test_round_trip(self):
        r = PaymentResponseExtra(
            charged_amount="100",
            channel_state=ChannelStateExtra(
                channel_id="0xabc", balance="1000", total_claimed="100"
            ),
            voucher_state=VoucherStateExtra(signed_max_claimable="100", signature="0xdead"),
        )
        d = r.to_dict()
        assert d["chargedAmount"] == "100"
        assert PaymentResponseExtra.from_dict(d) == r

    def test_empty_dict_round_trip(self):
        r = PaymentResponseExtra()
        assert r.to_dict() == {}
        assert PaymentResponseExtra.from_dict({}) == r
