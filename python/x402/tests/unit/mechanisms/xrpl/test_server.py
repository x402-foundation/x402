"""Resource-server tests for the XRPL exact scheme."""

from __future__ import annotations

import pytest

from x402.mechanisms.xrpl.exact import ExactXrplServerScheme
from x402.schemas import AssetAmount, SupportedKind

from .builders import INVOICE_ID, ISSUER, make_requirements


def _enhance(requirements):
    """Run the server's requirement enrichment with a bare supported kind."""
    kind = SupportedKind(x402_version=2, scheme="exact", network="xrpl:1", extra=None)
    return ExactXrplServerScheme().enhance_payment_requirements(requirements, kind, [])


class TestServer:
    def test_passes_through_an_explicit_xrp_amount(self):
        parsed = ExactXrplServerScheme().parse_price(
            AssetAmount(amount="1000", asset="XRP"), "xrpl:1"
        )
        assert parsed.amount == "1000"
        assert parsed.asset == "XRP"

    def test_rejects_a_fiat_price_with_an_actionable_message(self):
        # XRPL has no on-ledger rate, so "$0.01" cannot be converted here.
        with pytest.raises(ValueError, match="no "):
            ExactXrplServerScheme().parse_price("$0.01", "xrpl:1")

    def test_rejects_xrp_amounts_that_are_not_drops(self):
        with pytest.raises(ValueError, match="drops"):
            ExactXrplServerScheme().parse_price(AssetAmount(amount="1.5", asset="XRP"), "xrpl:1")

    def test_requires_an_asset(self):
        with pytest.raises(ValueError, match="Asset"):
            ExactXrplServerScheme().parse_price(AssetAmount(amount="1000", asset=""), "xrpl:1")

    def test_advertises_the_fields_a_payer_needs(self):
        requirements = make_requirements(extra={})
        kind = SupportedKind(x402_version=2, scheme="exact", network="xrpl:1", extra=None)
        enhanced = ExactXrplServerScheme().enhance_payment_requirements(requirements, kind, [])
        assert enhanced.extra["areFeesSponsored"] is False

    def test_leaves_the_transfer_method_open_when_nothing_pinned_one(self):
        # Once the requirements name a method the client must use it, so
        # defaulting one here would forbid clients from electing ticketSequence
        # for concurrency. The TypeScript server leaves it open too.
        requirements = make_requirements(extra={})
        kind = SupportedKind(x402_version=2, scheme="exact", network="xrpl:1", extra=None)
        enhanced = ExactXrplServerScheme().enhance_payment_requirements(requirements, kind, [])
        assert "assetTransferMethod" not in enhanced.extra

    def test_propagates_a_method_the_facilitator_pinned(self):
        requirements = make_requirements(extra={})
        kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network="xrpl:1",
            extra={"assetTransferMethod": "ticketSequence"},
        )
        enhanced = ExactXrplServerScheme().enhance_payment_requirements(requirements, kind, [])
        assert enhanced.extra["assetTransferMethod"] == "ticketSequence"

    def test_rejects_a_method_the_facilitator_pinned_that_does_not_exist(self):
        requirements = make_requirements(extra={})
        kind = SupportedKind(
            x402_version=2,
            scheme="exact",
            network="xrpl:1",
            extra={"assetTransferMethod": "pigeon"},
        )
        with pytest.raises(ValueError, match="assetTransferMethod"):
            ExactXrplServerScheme().enhance_payment_requirements(requirements, kind, [])

    def test_does_not_override_an_explicit_transfer_method(self):
        requirements = make_requirements(extra={"assetTransferMethod": "ticketSequence"})
        kind = SupportedKind(x402_version=2, scheme="exact", network="xrpl:1", extra=None)
        enhanced = ExactXrplServerScheme().enhance_payment_requirements(requirements, kind, [])
        assert enhanced.extra["assetTransferMethod"] == "ticketSequence"


class TestServerOverwritesFeeSponsorship:
    def test_a_configured_true_is_corrected_not_propagated(self):
        # Propagating a configured True would have every payment fail while
        # blaming the payer; the TypeScript server overwrites it the same way.
        requirements = make_requirements(fees_sponsored=True)
        enhanced = _enhance(requirements)
        assert enhanced.extra["areFeesSponsored"] is False


class TestMoneyParserChain:
    """XRPL has no on-ledger rate, so a money price is only usable through a
    registered parser, the same chain every sibling mechanism exposes."""

    @staticmethod
    def _usd_iou(amount: float, _network: str) -> AssetAmount:
        return AssetAmount(amount=f"{amount:.2f}", asset="USD", extra={"issuer": ISSUER})

    def test_a_registered_parser_converts_a_money_price(self):
        server = ExactXrplServerScheme().register_money_parser(self._usd_iou)
        parsed = server.parse_price("$0.50", "xrpl:1")
        assert parsed.asset == "USD"
        assert parsed.amount == "0.50"

    def test_parsers_are_tried_in_order_until_one_answers(self):
        server = (
            ExactXrplServerScheme()
            .register_money_parser(lambda _amount, _network: None)
            .register_money_parser(self._usd_iou)
        )
        assert server.parse_price(0.5, "xrpl:1").asset == "USD"

    def test_a_parser_result_is_validated_like_explicit_configuration(self):
        # A parser returning an unusable amount is the same misconfiguration
        # as writing it by hand, and must fail at the same place.
        server = ExactXrplServerScheme().register_money_parser(
            lambda _amount, _network: AssetAmount(
                amount="1e5", asset="USD", extra={"issuer": ISSUER}
            )
        )
        with pytest.raises(ValueError, match="decimal string"):
            server.parse_price("$1.00", "xrpl:1")

    def test_malformed_money_is_rejected_before_parser_dispatch(self):
        server = ExactXrplServerScheme().register_money_parser(self._usd_iou)
        with pytest.raises(ValueError, match="money format"):
            server.parse_price("not-money", "xrpl:1")
        with pytest.raises(ValueError, match="money format"):
            server.parse_price(-1, "xrpl:1")

    @pytest.mark.parametrize("money", ["1_000", "$1_0.5", "inf", "nan", "1e5"])
    def test_a_separator_or_special_value_does_not_pass_as_a_price(self, money):
        # float() accepts all of these; "1_000" would silently charge a
        # thousand times the configured price.
        server = ExactXrplServerScheme().register_money_parser(self._usd_iou)
        with pytest.raises(ValueError, match="money format"):
            server.parse_price(money, "xrpl:1")

    @pytest.mark.parametrize("price", [None, [], object()])
    def test_a_price_that_is_neither_an_amount_nor_money_is_rejected(self, price):
        with pytest.raises(ValueError, match="Unsupported price format"):
            ExactXrplServerScheme().parse_price(price, "xrpl:1")

    def test_a_currency_code_the_ledger_cannot_express_is_rejected_at_pricing(self):
        # Caught where the configuration is, rather than as every payment
        # failing verification with the reason pointing at the payer.
        with pytest.raises(ValueError, match="3-character code"):
            ExactXrplServerScheme().parse_price(
                AssetAmount(
                    amount="1.5",
                    asset="0000000000000000000000005553440000000001",
                    extra={"issuer": ISSUER},
                ),
                "xrpl:1",
            )

    @pytest.mark.parametrize("returned", ["1.5", 0, {"amount": "1.5"}])
    def test_a_parser_returning_the_wrong_type_raises_a_value_error(self, returned):
        # parse_price documents ValueError; without the check the caller gets
        # an AttributeError from inside validation.
        server = ExactXrplServerScheme().register_money_parser(lambda _amount, _network: returned)
        with pytest.raises(ValueError, match="AssetAmount"):
            server.parse_price("$1.00", "xrpl:1")


class TestPriceGivenAsAMapping:
    """A price may arrive already deserialised, as a plain mapping."""

    def test_accepts_a_mapping_with_the_same_fields(self):
        parsed = ExactXrplServerScheme().parse_price({"amount": "1000", "asset": "XRP"}, "xrpl:1")
        assert parsed.amount == "1000"
        assert parsed.asset == "XRP"

    def test_a_mapping_is_validated_like_an_asset_amount(self):
        with pytest.raises(ValueError, match="drops"):
            ExactXrplServerScheme().parse_price({"amount": "1.5", "asset": "XRP"}, "xrpl:1")


class TestServerRejectsItsOwnMisconfiguration:
    """These would otherwise surface as every payment failing verification,
    pointing at the payer rather than at the resource server's config."""

    def test_an_issued_currency_price_requires_an_issuer(self):
        with pytest.raises(ValueError, match="extra.issuer"):
            ExactXrplServerScheme().parse_price(
                AssetAmount(amount="1.5", asset="USD", extra={}), "xrpl:1"
            )

    def test_an_issuer_that_is_not_an_address_is_rejected(self):
        with pytest.raises(ValueError, match="extra.issuer"):
            ExactXrplServerScheme().parse_price(
                AssetAmount(amount="1.5", asset="USD", extra={"issuer": "nope"}), "xrpl:1"
            )

    @pytest.mark.parametrize("amount", ["1e5", "NaN", "-1", "1.", "abc"])
    def test_an_issued_currency_amount_must_be_a_plain_decimal(self, amount):
        with pytest.raises(ValueError, match="decimal string"):
            ExactXrplServerScheme().parse_price(
                AssetAmount(amount=amount, asset="USD", extra={"issuer": ISSUER}), "xrpl:1"
            )

    def test_an_unsupported_transfer_method_is_rejected_when_pricing(self):
        with pytest.raises(ValueError, match="assetTransferMethod"):
            ExactXrplServerScheme().parse_price(
                AssetAmount(amount="1000", asset="XRP", extra={"assetTransferMethod": "pigeon"}),
                "xrpl:1",
            )

    def test_an_unsupported_transfer_method_is_rejected_when_enhancing(self):
        with pytest.raises(ValueError, match="assetTransferMethod"):
            _enhance(make_requirements(extra={"assetTransferMethod": "pigeon"}))

    @pytest.mark.parametrize("invoice_id", ["", 7, {}])
    def test_an_unusable_invoice_id_is_rejected(self, invoice_id):
        with pytest.raises(ValueError, match="invoiceId"):
            _enhance(make_requirements(extra={"invoiceId": invoice_id}))

    @pytest.mark.parametrize("tag", [-1, 2**32, 1.5, True, "7"])
    def test_a_destination_tag_the_ledger_cannot_hold_is_rejected(self, tag):
        with pytest.raises(ValueError, match="destinationTag"):
            _enhance(make_requirements(extra={"destinationTag": tag}))

    def test_a_well_formed_configuration_is_accepted(self):
        enhanced = _enhance(
            make_requirements(
                extra={
                    "assetTransferMethod": "ticketSequence",
                    "invoiceId": INVOICE_ID,
                    "destinationTag": 42,
                }
            )
        )
        assert enhanced.extra["areFeesSponsored"] is False
        assert enhanced.extra["assetTransferMethod"] == "ticketSequence"
