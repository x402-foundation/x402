"""FastMCP exercises the real SVM batch accounting without chain transactions."""

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.mcp.server import create_payment_wrapper
from x402.mcp.types import PaymentWrapperHooks
from x402.schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyResponse,
)


@pytest.fixture(params=[x402ResourceServer, x402ResourceServerSync])
def batch(request):
    Keypair = pytest.importorskip("solders.keypair").Keypair
    from x402.mechanisms.svm.batch_settlement.authorization import sign_batch_authorization
    from x402.mechanisms.svm.batch_settlement.server import BatchSvmScheme, BatchSvmServerConfig
    from x402.mechanisms.svm.batch_settlement.types import ChannelState
    from x402.mechanisms.svm.constants import SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS
    from x402.mechanisms.svm.payment_channels import find_payment_channel_pda

    payer, fee, receiver, authorizer, operator, mint = [
        Keypair.from_seed(bytes([n]) * 32) for n in range(1, 7)
    ]
    scheme = BatchSvmScheme(BatchSvmServerConfig(receiver_authorizer=authorizer, operator=operator))
    kind = SupportedKind(
        x402_version=2,
        scheme=scheme.scheme,
        network=SOLANA_DEVNET_CAIP2,
        extra={"feePayer": str(fee.pubkey())},
    )
    requirements = scheme.enhance_payment_requirements(
        PaymentRequirements(
            scheme=scheme.scheme,
            network=kind.network,
            asset=str(mint.pubkey()),
            amount="10",
            pay_to=str(receiver.pubkey()),
            max_timeout_seconds=60,
            extra={},
        ),
        kind,
        [],
    )
    config = {
        "payer": str(payer.pubkey()),
        "payerAuthorizer": str(operator.pubkey()),
        "receiver": requirements.pay_to,
        "receiverAuthorizer": str(authorizer.pubkey()),
        "token": requirements.asset,
        "withdrawDelay": 900,
        "salt": "7",
        "openSlot": 123,
        "voucherSigner": "server",
    }
    channel = find_payment_channel_pda(
        payer=config["payer"],
        payee=str(fee.pubkey()),
        mint=config["token"],
        authorized_signer=config["payerAuthorizer"],
        salt=7,
        open_slot=123,
    )
    scheme.store.put(
        ChannelState(
            channel_id=channel,
            network=kind.network,
            channel_config=config,
            fee_payer=str(fee.pubkey()),
            token_program=TOKEN_PROGRAM_ADDRESS,
            deposit=100,
            onchain_synced_at=time.time(),
        )
    )
    mock_type = AsyncMock if request.param is x402ResourceServer else Mock
    facilitator = SimpleNamespace(
        get_supported=lambda: SupportedResponse(kinds=[kind]),
        verify=mock_type(return_value=VerifyResponse(is_valid=True)),
        settle=mock_type(
            return_value=SettleResponse(
                success=True,
                transaction="refund-tx",
                network=kind.network,
                extra={
                    "channelState": {
                        "channelId": channel,
                        "balance": "100",
                        "totalClaimed": "0",
                        "withdrawRequestedAt": 0,
                    }
                },
            )
        ),
    )
    core = request.param(facilitator).register(kind.network, scheme)
    core.initialize()

    def context(kind="authorization"):
        raw = {
            "type": kind,
            "channelConfig": config,
            "authorization": sign_batch_authorization(
                payer,
                channel,
                config["payerAuthorizer"],
                "request-1",
                0 if kind == "refund" else 10,
                int(time.time()) + 60,
            ),
        }
        payload = PaymentPayload(x402_version=2, accepted=requirements, payload=raw)
        return SimpleNamespace(
            request_context=SimpleNamespace(
                meta=SimpleNamespace(
                    model_extra={
                        MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True),
                    }
                )
            )
        )

    return SimpleNamespace(
        core=core,
        scheme=scheme,
        requirements=requirements,
        channel=channel,
        facilitator=facilitator,
        context=context,
        payer=payer,
        channel_config=config,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("actual", ["4", "11"])
async def test_metered_amount_uses_core_ceiling_and_keeps_advertised_accepts(batch, actual):
    original = batch.requirements.model_dump()

    def meter(ctx):
        ctx.payment_requirements.amount = actual
        # Only amount is used; hooks cannot replace verified channel terms.
        ctx.payment_requirements.pay_to = "different-recipient"

    wrapped = create_payment_wrapper(
        batch.core,
        accepts=[batch.requirements],
        hooks=PaymentWrapperHooks(on_after_execution=meter),
    )(lambda: "ok")
    result = await wrapped(ctx=batch.context())
    state = batch.scheme.store.get(batch.channel)
    assert batch.requirements.model_dump() == original
    assert result.isError is (actual == "11")
    assert state.charged_cumulative_amount == (4 if actual == "4" else 0)
    assert not state.reservations
    if actual == "4":
        assert result.meta[MCP_PAYMENT_RESPONSE_META_KEY]["extra"]["chargedAmount"] == "4"
    batch.facilitator.settle.assert_not_called()


@pytest.mark.asyncio
async def test_refund_skips_handler_and_metering_but_settles(batch):
    executed = Mock()

    def handler():
        executed()
        return "must not run"

    before = Mock(return_value=True)
    after = Mock()
    wrapped = create_payment_wrapper(
        batch.core,
        accepts=[batch.requirements],
        hooks=PaymentWrapperHooks(
            on_before_execution=before,
            on_after_execution=after,
        ),
    )(handler)
    result = await wrapped(ctx=batch.context("refund"))
    assert not result.isError
    executed.assert_not_called()
    before.assert_not_called()
    after.assert_not_called()
    batch.facilitator.settle.assert_called_once()
    settled_payload = batch.facilitator.settle.call_args.args[0]
    assert settled_payload.payload["authorization"]["authorizedAmount"] == "0"
    assert settled_payload.payload["voucher"]["maxClaimableAmount"] == "0"
    state = batch.scheme.store.get(batch.channel)
    assert state.charged_cumulative_amount == 0
    assert not state.reservations
    assert state.status == "distributed"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["blocked", "threw", "error", "invalid_result"])
async def test_failed_execution_releases_batch_reservation(batch, failure):
    from mcp.types import CallToolResult, TextContent

    def handler():
        if failure == "invalid_result":
            return {"unserializable": object()}
        if failure == "threw":
            raise RuntimeError("failed")
        return CallToolResult(content=[TextContent(type="text", text="failed")], isError=True)

    wrapped = create_payment_wrapper(
        batch.core,
        accepts=[batch.requirements],
        hooks=PaymentWrapperHooks(
            on_before_execution=lambda _: failure != "blocked",
        ),
    )(handler)
    result = await wrapped(ctx=batch.context())
    assert result.isError
    state = batch.scheme.store.get(batch.channel)
    assert not state.reservations
    assert state.charged_cumulative_amount == 0
    batch.facilitator.settle.assert_not_called()


@pytest.mark.asyncio
async def test_metering_cancellation_releases_real_server_signed_client_allocation(batch):
    from solders.pubkey import Pubkey

    from x402.mcp.server_async import PaymentWrapperConfig
    from x402.mcp.server_async import create_payment_wrapper as wrap_async
    from x402.mcp.server_sync import create_payment_wrapper_sync
    from x402.mcp.types import SyncPaymentWrapperConfig
    from x402.mcp.utils import (
        extract_payment_required_from_result,
        extract_payment_response_from_result,
    )
    from x402.mechanisms.svm.batch_settlement.client import BatchSvmScheme
    from x402.mechanisms.svm.batch_settlement.client_types import BatchSvmClientConfig, OpenChannel
    from x402.mechanisms.svm.batch_settlement.trust import (
        BatchServerSignedChannelsPolicy,
        ServerSignedChannelsAsset,
    )
    from x402.mechanisms.svm.constants import TOKEN_PROGRAM_ADDRESS
    from x402.mechanisms.svm.signers import KeypairSigner
    from x402.schemas import PaymentResponseContext

    requirements = batch.requirements
    client = BatchSvmScheme(
        KeypairSigner(batch.payer),
        BatchSvmClientConfig(
            salt=7,
            discover_channels=False,
            server_signed_channels_policy=BatchServerSignedChannelsPolicy(
                allowed_operators=[batch.channel_config["payerAuthorizer"]],
                allowed_assets=[
                    ServerSignedChannelsAsset(str(requirements.network), requirements.asset, "100")
                ],
            ),
        ),
    )
    rpc = Mock()
    rpc.get_account_info.return_value = SimpleNamespace(
        value=SimpleNamespace(
            owner=Pubkey.from_string(TOKEN_PROGRAM_ADDRESS),
            data=bytes(44) + bytes([6]) + bytes(37),
        )
    )
    client._clients[str(requirements.network)] = rpc
    terms, _ = client._terms(requirements)
    client._save_confirmed(
        client._key(requirements, terms),
        OpenChannel(
            batch.channel,
            batch.channel_config,
            100,
        ),
    )
    inner = client.create_payment_payload(requirements)
    assert inner["type"] == "authorization"
    payload = PaymentPayload(x402_version=2, accepted=requirements, payload=inner)
    with pytest.raises(ValueError, match="pending request"):
        client.create_payment_payload(requirements)

    def meter(_):
        raise ValueError("meter unavailable")

    hooks = PaymentWrapperHooks(on_after_execution=meter)
    extra = {
        "toolName": "paid_tool",
        "_meta": {MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)},
    }
    if isinstance(batch.core, x402ResourceServerSync):
        wrapped = create_payment_wrapper_sync(
            batch.core, SyncPaymentWrapperConfig(accepts=[requirements], hooks=hooks)
        )(lambda *_: "ok")
        result = wrapped({}, extra)
    else:
        wrapped = wrap_async(batch.core, PaymentWrapperConfig(accepts=[requirements], hooks=hooks))(
            lambda *_: "ok"
        )
        result = await wrapped({}, extra)
    receipt = extract_payment_response_from_result(result)
    assert result.is_error and receipt is not None and not receipt.success
    client.on_payment_response(
        PaymentResponseContext(
            payment_payload=payload,
            requirements=requirements,
            settle_response=receipt,
            payment_required=extract_payment_required_from_result(result),
        )
    )
    retry = client.create_payment_payload(requirements)
    assert retry["type"] == "authorization"
    assert retry["authorization"]["requestId"] != inner["authorization"]["requestId"]
    state = batch.scheme.store.get(batch.channel)
    assert not state.reservations
    assert state.charged_cumulative_amount == 0
    batch.facilitator.settle.assert_not_called()
