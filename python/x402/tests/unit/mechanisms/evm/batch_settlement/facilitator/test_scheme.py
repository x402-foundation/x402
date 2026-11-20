"""Unit tests for `BatchSettlementEvmFacilitator` dispatch."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.constants import SCHEME_BATCH_SETTLEMENT
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_AUTHORIZER_NOT_CONFIGURED,
        ERR_CLAIM_PAYLOAD,
        ERR_CLAIM_TRANSACTION_FAILED,
        ERR_DEPOSIT_PAYLOAD,
        ERR_DEPOSIT_TRANSACTION_FAILED,
        ERR_INVALID_PAYLOAD_TYPE,
        ERR_INVALID_SCHEME,
        ERR_NETWORK_MISMATCH,
        ERR_REFUND_PAYLOAD,
        ERR_SETTLE_PAYLOAD,
        ERR_SETTLE_TRANSACTION_FAILED,
        ERR_VOUCHER_PAYLOAD,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator import refund as refund_mod
    from x402.mechanisms.evm.batch_settlement.facilitator.claim import (
        execute_claim_with_signature,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.refund import (
        execute_refund_with_signature,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.scheme import (
        BatchSettlementEvmFacilitator,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator.settle import execute_settle
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        ChannelState,
        ClaimPayload,
        DepositAuthorization,
        DepositFields,
        DepositPayload,
        EnrichedRefundPayload,
        Erc3009Authorization,
        Permit2Authorization,
        Permit2DepositWitness,
        Permit2TokenPermissions,
        RefundPayload,
        SettlePayload,
        VoucherClaim,
        VoucherFields,
        VoucherPayload,
        validate_batch_settlement_payload,
        validate_batch_settlement_settle_payload,
    )
    from x402.mechanisms.evm.constants import ERR_SETTLEMENT_PENDING, TX_STATUS_SUCCESS
    from x402.schemas import PaymentPayload, PaymentRequirements, VerifyResponse
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"


class _FakeAuthorizerSigner:
    def __init__(self, address: str) -> None:
        self.address = address

    def sign_typed_data(self, **kwargs) -> str:  # pragma: no cover
        return "0x" + "11" * 65


class _FakeFacilitatorSigner:
    def get_addresses(self) -> list[str]:
        return ["0xabc"]


def _requirements(scheme: str = SCHEME_BATCH_SETTLEMENT, network: str = NETWORK):
    return PaymentRequirements(
        scheme=scheme,
        network=network,
        asset="0x0000000000000000000000000000000000000001",
        amount="0",
        pay_to="0x0000000000000000000000000000000000000002",
        max_timeout_seconds=60,
        extra={},
    )


def _payload(payload_body: dict, scheme: str = SCHEME_BATCH_SETTLEMENT, network: str = NETWORK):
    return PaymentPayload(
        x402_version=2,
        payload=payload_body,
        accepted=_requirements(scheme=scheme, network=network),
    )


class TestFacilitatorMetadata:
    def test_get_extra_includes_receiver_authorizer(self):
        fac = BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )
        assert fac.get_extra(NETWORK) == {"receiverAuthorizer": "0xauth"}

    def test_get_extra_returns_none_without_authorizer(self):
        fac = BatchSettlementEvmFacilitator(_FakeFacilitatorSigner())  # type: ignore[arg-type]
        assert fac.get_extra(NETWORK) is None

    def test_get_signers_returns_addresses(self):
        fac = BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )
        assert fac.get_signers(NETWORK) == ["0xabc"]

    def test_uses_provided_pending_store_instead_of_a_fresh_default(self):
        """A caller-supplied PendingSettlementStore must be the instance actually used,
        not merely accepted and ignored in favor of the default. This is what lets a
        multi-instance facilitator inject a shared, network-backed store."""
        from x402.pending_settlement_store import InMemoryPendingSettlementStore

        custom_store = InMemoryPendingSettlementStore()

        fac = BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            pending_store=custom_store,
        )

        assert fac._pending_store is custom_store


class TestVerifyDispatchErrors:
    def _fac(self):
        return BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )

    def test_wrong_scheme_returns_invalid(self):
        fac = self._fac()
        payload = _payload({"type": "voucher"}, scheme="exact")
        out = fac.verify(payload, _requirements(scheme="exact"))
        assert out.is_valid is False
        assert out.invalid_reason == ERR_INVALID_SCHEME

    def test_network_mismatch(self):
        fac = self._fac()
        payload = _payload({"type": "voucher"}, network="eip155:1")
        out = fac.verify(payload, _requirements(network=NETWORK))
        assert out.is_valid is False
        assert out.invalid_reason == ERR_NETWORK_MISMATCH

    def test_unknown_payload_type(self):
        fac = self._fac()
        payload = _payload({"type": "junk"})
        out = fac.verify(payload, _requirements())
        assert out.is_valid is False
        assert out.invalid_reason == ERR_INVALID_PAYLOAD_TYPE


class TestSettleDispatchErrors:
    def test_unknown_payload_type(self):
        fac = BatchSettlementEvmFacilitator(
            _FakeFacilitatorSigner(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )
        payload = _payload({"type": "junk"})
        out = fac.settle(payload, _requirements())
        assert out.success is False
        assert out.error_reason == ERR_INVALID_PAYLOAD_TYPE
        assert out.network == NETWORK


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


def _voucher_claim() -> VoucherClaim:
    return VoucherClaim(
        channel=_channel_config(),
        max_claimable_amount="1000",
        signature="0xdead",
        total_claimed="0",
    )


class _SignerNotExpected:
    """Facilitator signer whose use signals the guard failed to short-circuit."""

    def read_contract(self, *args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("read_contract should not be called before the guard")

    def write_contract(self, *args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("write_contract should not be called before the guard")

    def wait_for_transaction_receipt(self, tx):  # pragma: no cover - must not run
        raise AssertionError("wait_for_transaction_receipt should not be called")


_ADDRESS = "0x" + "66" * 20
_SIGNATURE = "0x" + "bb" * 65


def _voucher_fields() -> VoucherFields:
    return VoucherFields(
        channel_id="0x" + "aa" * 32, max_claimable_amount="1000", signature=_SIGNATURE
    )


def _deposit_body(authorization: DepositAuthorization | None = None) -> dict:
    if authorization is None:
        authorization = DepositAuthorization(
            erc3009_authorization=Erc3009Authorization(
                valid_after="0",
                valid_before="9999999999",
                salt="0x" + "00" * 32,
                signature=_SIGNATURE,
            )
        )
    return DepositPayload(
        channel_config=_channel_config(),
        voucher=_voucher_fields(),
        deposit=DepositFields(amount="1000", authorization=authorization),
    ).to_dict()


def _deposit_permit2_body() -> dict:
    return _deposit_body(
        DepositAuthorization(
            permit2_authorization=Permit2Authorization(
                from_address=_ADDRESS,
                permitted=Permit2TokenPermissions(token=_ADDRESS, amount="1000"),
                spender=_ADDRESS,
                nonce="1",
                deadline="9999999999",
                witness=Permit2DepositWitness(channel_id="0x" + "aa" * 32),
                signature=_SIGNATURE,
            )
        )
    )


def _voucher_body() -> dict:
    return VoucherPayload(channel_config=_channel_config(), voucher=_voucher_fields()).to_dict()


def _refund_body() -> dict:
    return RefundPayload(channel_config=_channel_config(), voucher=_voucher_fields()).to_dict()


def _claim_body() -> dict:
    return ClaimPayload(claims=[_voucher_claim()], claim_authorizer_signature=_SIGNATURE).to_dict()


def _settle_body() -> dict:
    return SettlePayload(receiver=_ADDRESS, token=_ADDRESS).to_dict()


def _enriched_refund_body() -> dict:
    return EnrichedRefundPayload(
        channel_config=_channel_config(),
        voucher=_voucher_fields(),
        amount="10",
        refund_nonce="0",
        claims=[_voucher_claim()],
    ).to_dict()


_MISSING = object()

# (body builder, path to the field, malformed value, expected reason); _MISSING deletes the field.
_MALFORMED_VERIFY_PAYLOADS = [
    pytest.param(_deposit_body, ("channelConfig",), "x", ERR_DEPOSIT_PAYLOAD, id="deposit-config"),
    pytest.param(
        _deposit_body,
        ("channelConfig", "withdrawDelay"),
        "900",
        ERR_DEPOSIT_PAYLOAD,
        id="deposit-withdraw-delay-string",
    ),
    pytest.param(
        _deposit_body, ("channelConfig", "payer"), "zz", ERR_DEPOSIT_PAYLOAD, id="deposit-payer"
    ),
    pytest.param(_deposit_body, ("voucher",), "x", ERR_DEPOSIT_PAYLOAD, id="deposit-voucher"),
    pytest.param(
        _deposit_body,
        ("voucher", "maxClaimableAmount"),
        1000,
        ERR_DEPOSIT_PAYLOAD,
        id="deposit-amount-json-number",
    ),
    pytest.param(
        _deposit_body,
        ("deposit", "authorization"),
        None,
        ERR_DEPOSIT_PAYLOAD,
        id="deposit-authorization",
    ),
    pytest.param(
        _deposit_body,
        ("deposit", "authorization", "erc3009Authorization", "validBefore"),
        "abc",
        ERR_DEPOSIT_PAYLOAD,
        id="deposit-valid-before",
    ),
    pytest.param(
        _deposit_permit2_body,
        ("deposit", "authorization", "permit2Authorization", "witness"),
        "x",
        ERR_DEPOSIT_PAYLOAD,
        id="deposit-permit2-witness",
    ),
    pytest.param(_voucher_body, ("channelConfig",), None, ERR_VOUCHER_PAYLOAD, id="voucher-config"),
    pytest.param(
        _voucher_body, ("channelConfig", "salt"), "0x", ERR_VOUCHER_PAYLOAD, id="voucher-salt"
    ),
    pytest.param(
        _voucher_body, ("voucher", "signature"), 123, ERR_VOUCHER_PAYLOAD, id="voucher-signature"
    ),
    pytest.param(_refund_body, ("channelConfig",), "x", ERR_REFUND_PAYLOAD, id="refund-config"),
    pytest.param(_refund_body, ("amount",), "-1", ERR_REFUND_PAYLOAD, id="refund-amount"),
    # Right type, bad content: each of these passed a type-only check and raised later.
    pytest.param(
        _voucher_body,
        ("voucher", "signature"),
        "0xzz",
        ERR_VOUCHER_PAYLOAD,
        id="voucher-signature-not-hex",
    ),
    pytest.param(
        _voucher_body,
        ("voucher", "channelId"),
        "0X" + "aa" * 32,
        ERR_VOUCHER_PAYLOAD,
        id="voucher-channel-id-uppercase-prefix",
    ),
    pytest.param(
        _voucher_body,
        ("channelConfig", "payer"),
        "0x-" + "1" * 39,
        ERR_VOUCHER_PAYLOAD,
        id="payer-signed-hex",
    ),
    pytest.param(
        _voucher_body,
        ("channelConfig", "payer"),
        "0x0x" + "1" * 38,
        ERR_VOUCHER_PAYLOAD,
        id="payer-double-prefix",
    ),
    pytest.param(
        _voucher_body,
        ("channelConfig", "withdrawDelay"),
        -1,
        ERR_VOUCHER_PAYLOAD,
        id="withdraw-delay-negative",
    ),
    pytest.param(
        _voucher_body,
        ("channelConfig", "withdrawDelay"),
        2**40,
        ERR_VOUCHER_PAYLOAD,
        id="withdraw-delay-over-uint40",
    ),
    pytest.param(
        _deposit_body,
        ("deposit", "authorization", "erc3009Authorization", "salt"),
        "abc",
        ERR_DEPOSIT_PAYLOAD,
        id="erc3009-salt-not-hex",
    ),
    pytest.param(
        _deposit_body,
        ("deposit", "authorization", "erc3009Authorization", "salt"),
        "0x" + "11" * 33,
        ERR_DEPOSIT_PAYLOAD,
        id="erc3009-salt-33-bytes",
    ),
]

_MALFORMED_SETTLE_PAYLOADS = [
    pytest.param(_deposit_body, ("voucher",), "x", ERR_DEPOSIT_PAYLOAD, id="deposit-voucher"),
    pytest.param(_claim_body, ("claims",), "x", ERR_CLAIM_PAYLOAD, id="claim-claims"),
    pytest.param(_claim_body, ("claims", 0), {}, ERR_CLAIM_PAYLOAD, id="claim-entry-empty"),
    pytest.param(
        _claim_body, ("claims", 0, "signature"), "zz", ERR_CLAIM_PAYLOAD, id="claim-signature"
    ),
    pytest.param(
        _claim_body,
        ("claims", 0, "voucher", "channel", "token"),
        "",
        ERR_CLAIM_PAYLOAD,
        id="claim-channel-token",
    ),
    pytest.param(
        _claim_body,
        ("claimAuthorizerSignature",),
        "zz",
        ERR_CLAIM_PAYLOAD,
        id="claim-authorizer-signature",
    ),
    pytest.param(_settle_body, ("receiver",), 123, ERR_SETTLE_PAYLOAD, id="settle-receiver"),
    pytest.param(_settle_body, ("token",), None, ERR_SETTLE_PAYLOAD, id="settle-token"),
    pytest.param(
        _enriched_refund_body, ("refundNonce",), "abc", ERR_REFUND_PAYLOAD, id="refund-nonce"
    ),
    pytest.param(_enriched_refund_body, ("claims",), "x", ERR_REFUND_PAYLOAD, id="refund-claims"),
    pytest.param(
        _claim_body,
        ("claims", 0, "totalClaimed"),
        str(2**128),
        ERR_CLAIM_PAYLOAD,
        id="claim-total-claimed-over-uint128",
    ),
    pytest.param(
        _claim_body,
        ("claims", 0, "voucher", "maxClaimableAmount"),
        str(2**128),
        ERR_CLAIM_PAYLOAD,
        id="claim-max-claimable-over-uint128",
    ),
]


def _malformed_payload(build, path: tuple, value) -> PaymentPayload:
    body = build()
    target = body
    for key in path[:-1]:
        target = target[key]
    if value is _MISSING:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    return _payload(body)


class TestMalformedPayloads:
    """Malformed payloads are rejected with the payload type's reason before any chain call."""

    def _fac(self):
        return BatchSettlementEvmFacilitator(
            _SignerNotExpected(),  # type: ignore[arg-type]
            _FakeAuthorizerSigner("0xauth"),  # type: ignore[arg-type]
        )

    @pytest.mark.parametrize(("build", "path", "value", "reason"), _MALFORMED_VERIFY_PAYLOADS)
    def test_verify_returns_invalid(self, build, path, value, reason):
        out = self._fac().verify(_malformed_payload(build, path, value), _requirements())

        assert out.is_valid is False
        assert out.invalid_reason == reason
        assert str(path[-1]) in out.invalid_message

    @pytest.mark.parametrize(("build", "path", "value", "reason"), _MALFORMED_SETTLE_PAYLOADS)
    def test_settle_returns_failure(self, build, path, value, reason):
        out = self._fac().settle(_malformed_payload(build, path, value), _requirements())

        assert out.success is False
        assert out.error_reason == reason
        assert str(path[-1]) in out.error_message
        assert out.network == NETWORK

    def test_verify_missing_key_is_unknown_payload_type(self):
        # A missing key fails the payload type guard, so validation leaves it to the fallback.
        payload = _malformed_payload(_voucher_body, ("channelConfig",), _MISSING)

        out = self._fac().verify(payload, _requirements())

        assert out.is_valid is False
        assert out.invalid_reason == ERR_INVALID_PAYLOAD_TYPE

    def test_settle_missing_key_is_unknown_payload_type(self):
        payload = _malformed_payload(_settle_body, ("token",), _MISSING)

        out = self._fac().settle(payload, _requirements())

        assert out.success is False
        assert out.error_reason == ERR_INVALID_PAYLOAD_TYPE

    @pytest.mark.parametrize(
        "build", [_deposit_body, _deposit_permit2_body, _voucher_body, _refund_body]
    )
    def test_well_formed_client_payloads_pass(self, build):
        assert validate_batch_settlement_payload(build()) is None

    @pytest.mark.parametrize(
        "build",
        [_deposit_body, _deposit_permit2_body, _claim_body, _settle_body, _enriched_refund_body],
    )
    def test_well_formed_settle_payloads_pass(self, build):
        assert validate_batch_settlement_settle_payload(build()) is None

    def test_enriched_refund_ignores_voucher_contents(self):
        body = _enriched_refund_body()
        body["voucher"]["maxClaimableAmount"] = ""

        assert validate_batch_settlement_settle_payload(body) is None

    def test_deposit_ignores_empty_erc3009_authorization_next_to_permit2(self):
        body = _deposit_permit2_body()
        body["deposit"]["authorization"]["erc3009Authorization"] = {}

        assert validate_batch_settlement_payload(body) is None
        assert validate_batch_settlement_settle_payload(body) is None

    def test_erc3009_salt_accepts_short_hex(self):
        body = _deposit_body()
        body["deposit"]["authorization"]["erc3009Authorization"]["salt"] = "0x1"

        assert validate_batch_settlement_payload(body) is None
        assert validate_batch_settlement_settle_payload(body) is None


class _FakeReceipt:
    status = TX_STATUS_SUCCESS


_SUCCESSFUL_TX_HASH = "0x" + "ab" * 32


class _SuccessfulSigner:
    def read_contract(self, *args, **kwargs):
        return None

    def write_contract(self, *args, **kwargs):
        return _SUCCESSFUL_TX_HASH

    def wait_for_transaction_receipt(self, tx):
        return _FakeReceipt()


class TestClaimAuthorizerNotConfigured:
    def test_missing_signature_without_signer_returns_not_configured(self):
        payload = ClaimPayload(claims=[_voucher_claim()], claim_authorizer_signature=None)

        out = execute_claim_with_signature(
            _SignerNotExpected(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_AUTHORIZER_NOT_CONFIGURED
        assert out.network == NETWORK

    def test_supplied_signature_proceeds_without_signer(self):
        payload = ClaimPayload(
            claims=[_voucher_claim()],
            claim_authorizer_signature="0x" + "11" * 65,
        )

        out = execute_claim_with_signature(
            _SuccessfulSigner(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is True
        assert out.transaction == _SUCCESSFUL_TX_HASH


class TestRefundAuthorizerNotConfigured:
    def _enriched_refund(
        self, *, with_claims: bool, refund_sig: str | None
    ) -> EnrichedRefundPayload:
        payload = EnrichedRefundPayload()
        payload.channel_config = _channel_config()
        payload.amount = "500"
        payload.refund_nonce = "0"
        payload.claims = [_voucher_claim()] if with_claims else []
        payload.refund_authorizer_signature = refund_sig
        payload.claim_authorizer_signature = None
        return payload

    def test_missing_refund_signature_without_signer_returns_not_configured(self, monkeypatch):
        monkeypatch.setattr(
            refund_mod,
            "read_channel_state",
            lambda signer, channel_id: ChannelState(
                balance=1000, total_claimed=0, withdraw_requested_at=0, refund_nonce=0
            ),
        )
        payload = self._enriched_refund(with_claims=False, refund_sig=None)

        out = execute_refund_with_signature(
            _SignerNotExpected(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_AUTHORIZER_NOT_CONFIGURED

    def test_missing_claim_signature_without_signer_returns_not_configured(self, monkeypatch):
        monkeypatch.setattr(
            refund_mod,
            "read_channel_state",
            lambda signer, channel_id: ChannelState(
                balance=1000, total_claimed=0, withdraw_requested_at=0, refund_nonce=0
            ),
        )
        payload = self._enriched_refund(with_claims=True, refund_sig="0x" + "11" * 65)

        out = execute_refund_with_signature(
            _SignerNotExpected(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_AUTHORIZER_NOT_CONFIGURED


class _ReceiptWaitFailsSigner:
    """Broadcasts successfully but fails to confirm the receipt (RPC error/timeout)."""

    def __init__(
        self,
        tx_hash: str = _SUCCESSFUL_TX_HASH,
        error: Exception | None = None,
    ) -> None:
        self._tx_hash = tx_hash
        self._error = error or RuntimeError("rpc: timeout waiting for receipt")

    def read_contract(self, *args, **kwargs):
        return (1000, 0)

    def write_contract(self, *args, **kwargs):
        return self._tx_hash

    def wait_for_transaction_receipt(self, tx):
        raise self._error


class _MalformedReceiptSigner:
    """Broadcasts and confirms, but returns a receipt object missing `.status`."""

    def __init__(self, tx_hash: str = _SUCCESSFUL_TX_HASH) -> None:
        self._tx_hash = tx_hash

    def read_contract(self, *args, **kwargs):
        return (1000, 0)

    def write_contract(self, *args, **kwargs):
        return self._tx_hash

    def wait_for_transaction_receipt(self, tx):
        return object()


class TestSettleReceiptWait:
    def test_deposit_single_hash_without_balance_increase_fails(self, monkeypatch):
        """A single extension-signer hash is not blindly trusted as an atomic bundle.

        If the hash's receipt succeeds (e.g. because it is only the approve
        transaction from a non-conforming sequential signer) but the channel
        balance never reflects the deposit, settlement must fail rather than report
        success without funds moving.
        """
        from x402.mechanisms.evm.batch_settlement.facilitator import deposit as deposit_mod

        class BaseSigner:
            def wait_for_transaction_receipt(self, tx_hash):
                raise AssertionError("base signer must not wait for extension transaction")

        class ExtensionSigner:
            def send_transactions(self, transactions):
                return [_SUCCESSFUL_TX_HASH]

            def wait_for_transaction_receipt(self, tx_hash):
                return _FakeReceipt()

        payload = SimpleNamespace(
            channel_config=SimpleNamespace(payer="0xpayer"),
            voucher=SimpleNamespace(channel_id="0x" + "11" * 32),
            deposit=SimpleNamespace(amount="100"),
        )
        execution = deposit_mod._DepositExecution(
            kind="erc20Approval",
            collector="",
            collector_data=b"",
            signed_transaction="0xsigned",
            extension_signer=ExtensionSigner(),
        )
        monkeypatch.setattr(
            deposit_mod,
            "verify_deposit",
            lambda *args: VerifyResponse(is_valid=True, extra={"balance": "0"}),
        )
        monkeypatch.setattr(deposit_mod, "_resolve_deposit_execution", lambda *args: execution)
        monkeypatch.setattr(
            deposit_mod, "_resolve_deposit_transfer_method", lambda *args: "permit2"
        )
        monkeypatch.setattr(
            deposit_mod, "_build_deposit_write_call", lambda *args, **kwargs: object()
        )
        # Balance never reflects the deposit — e.g. because the single hash only
        # broadcast the approve and the deposit call never ran.
        monkeypatch.setattr(
            deposit_mod,
            "read_channel_state",
            lambda *args: SimpleNamespace(
                balance=0, total_claimed=0, withdraw_requested_at=0, refund_nonce=0
            ),
        )

        out = deposit_mod.settle_deposit(
            BaseSigner(),
            SimpleNamespace(),
            payload,
            _requirements(),  # type: ignore[arg-type]
        )

        assert out.success is False
        assert out.error_reason == ERR_DEPOSIT_TRANSACTION_FAILED

    def test_deposit_single_hash_with_read_error_returns_settlement_pending(self, monkeypatch):
        """A single extension-signer hash whose deposit cannot be confirmed is not
        reported as success. The bundle receipt only proves some transaction did not
        revert, not that the deposit landed; when the confirming balance read fails we
        cannot distinguish a landed deposit from a non-conforming approve-only broadcast,
        so settlement is pending with the broadcast hash for the caller to reconcile.
        """
        from x402.mechanisms.evm.batch_settlement.facilitator import deposit as deposit_mod

        class BaseSigner:
            def wait_for_transaction_receipt(self, tx_hash):
                raise AssertionError("base signer must not wait for extension transaction")

        class ExtensionSigner:
            def send_transactions(self, transactions):
                return [_SUCCESSFUL_TX_HASH]

            def wait_for_transaction_receipt(self, tx_hash):
                return _FakeReceipt()

        payload = SimpleNamespace(
            channel_config=SimpleNamespace(payer="0xpayer"),
            voucher=SimpleNamespace(channel_id="0x" + "11" * 32),
            deposit=SimpleNamespace(amount="100"),
        )
        execution = deposit_mod._DepositExecution(
            kind="erc20Approval",
            collector="",
            collector_data=b"",
            signed_transaction="0xsigned",
            extension_signer=ExtensionSigner(),
        )
        monkeypatch.setattr(
            deposit_mod,
            "verify_deposit",
            lambda *args: VerifyResponse(is_valid=True, extra={"balance": "0"}),
        )
        monkeypatch.setattr(deposit_mod, "_resolve_deposit_execution", lambda *args: execution)
        monkeypatch.setattr(
            deposit_mod, "_resolve_deposit_transfer_method", lambda *args: "permit2"
        )
        monkeypatch.setattr(
            deposit_mod, "_build_deposit_write_call", lambda *args, **kwargs: object()
        )
        monkeypatch.setattr(
            deposit_mod,
            "read_channel_state",
            lambda *args: (_ for _ in ()).throw(RuntimeError("rpc read failed")),
        )

        out = deposit_mod.settle_deposit(
            BaseSigner(),
            SimpleNamespace(),
            payload,
            _requirements(),  # type: ignore[arg-type]
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == _SUCCESSFUL_TX_HASH

    def test_receipt_wait_failure_returns_settlement_pending(self):
        payload = SettlePayload(
            receiver="0x3333333333333333333333333333333333333333",
            token="0x5555555555555555555555555555555555555555",
        )

        out = execute_settle(
            _ReceiptWaitFailsSigner(),  # type: ignore[arg-type]
            payload,
            _requirements(),
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == _SUCCESSFUL_TX_HASH

    def test_receipt_wait_type_error_returns_settlement_pending(self):
        payload = SettlePayload(
            receiver="0x3333333333333333333333333333333333333333",
            token="0x5555555555555555555555555555555555555555",
        )

        out = execute_settle(
            _ReceiptWaitFailsSigner(error=TypeError("invalid receipt")),  # type: ignore[arg-type]
            payload,
            _requirements(),
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == _SUCCESSFUL_TX_HASH

    def test_invalid_broadcast_hash_is_terminal(self):
        payload = SettlePayload(
            receiver="0x3333333333333333333333333333333333333333",
            token="0x5555555555555555555555555555555555555555",
        )

        out = execute_settle(
            _ReceiptWaitFailsSigner(tx_hash="not-a-hash"),  # type: ignore[arg-type]
            payload,
            _requirements(),
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLE_TRANSACTION_FAILED
        assert out.transaction == ""

    def test_malformed_receipt_is_settlement_pending(self):
        """A receipt missing `.status` must not escape as an unhandled exception. The
        broadcast confirmed but the receipt could not be processed, so the effect is
        unknown: non-terminal settlement_pending keeps the hash for reconciliation, matching
        the Go/TS SDKs. Only a reverted receipt or an absent transfer event is terminal."""
        payload = SettlePayload(
            receiver="0x3333333333333333333333333333333333333333",
            token="0x5555555555555555555555555555555555555555",
        )

        out = execute_settle(
            _MalformedReceiptSigner(),  # type: ignore[arg-type]
            payload,
            _requirements(),
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == _SUCCESSFUL_TX_HASH


class TestClaimReceiptWait:
    def test_receipt_wait_failure_returns_settlement_pending(self):
        payload = ClaimPayload(
            claims=[_voucher_claim()],
            claim_authorizer_signature="0x" + "11" * 65,
        )

        out = execute_claim_with_signature(
            _ReceiptWaitFailsSigner(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == _SUCCESSFUL_TX_HASH

    def test_invalid_broadcast_hash_is_terminal(self):
        payload = ClaimPayload(
            claims=[_voucher_claim()],
            claim_authorizer_signature="0x" + "11" * 65,
        )

        out = execute_claim_with_signature(
            _ReceiptWaitFailsSigner(tx_hash="not-a-hash"),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_CLAIM_TRANSACTION_FAILED
        assert out.transaction == ""

    def test_malformed_receipt_is_settlement_pending(self):
        """A receipt missing `.status` must not escape as an unhandled exception. The
        broadcast confirmed but the receipt could not be processed, so the effect is
        unknown: non-terminal settlement_pending keeps the hash for reconciliation, matching
        the Go/TS SDKs. Only a reverted receipt or an absent transfer event is terminal."""
        payload = ClaimPayload(
            claims=[_voucher_claim()],
            claim_authorizer_signature="0x" + "11" * 65,
        )

        out = execute_claim_with_signature(
            _MalformedReceiptSigner(),  # type: ignore[arg-type]
            payload,
            _requirements(),
            None,
        )

        assert out.success is False
        assert out.error_reason == ERR_SETTLEMENT_PENDING
        assert out.transaction == _SUCCESSFUL_TX_HASH
