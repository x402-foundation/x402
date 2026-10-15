"""Existing e2e Python clients: registration, restart recovery and phase dispatch."""

from __future__ import annotations

import importlib.util
import json
import os
import struct
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from solders.hash import Hash
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from x402 import x402Client, x402ClientSync
from x402.mechanisms.evm.batch_settlement.client import BatchSettlementEvmScheme
from x402.mechanisms.svm.batch_settlement import BatchSvmClientScheme, UntrustedOperatorError
from x402.mechanisms.svm.constants import (
    SOLANA_DEVNET_CAIP2,
    SOLANA_MAINNET_CAIP2,
    TOKEN_PROGRAM_ADDRESS,
    USDC_DEVNET_ADDRESS,
    USDC_MAINNET_ADDRESS,
)
from x402.mechanisms.svm.payment_channels import (
    PAYMENT_CHANNELS_PROGRAM_ID,
    ChannelSplit,
    distribution_hash,
    sign_voucher,
)
from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    PaymentResponseContext,
    SettleResponse,
)

CLIENT_DIR = Path(__file__).resolve().parents[4] / "e2e" / "clients" / "python"
PAYER, FEE, RECEIVER, OPERATOR = [Keypair.from_seed(bytes([n]) * 32) for n in range(1, 5)]
SALT = "0x" + "f0" * 24 + "0123456789abcdef"


def load_module(monkeypatch, name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def e2e(monkeypatch):
    monkeypatch.syspath_prepend(str(CLIENT_DIR))
    for name in list(os.environ):
        if name.startswith(("CLIENT_", "BATCH_SETTLEMENT_", "EVM_BATCH_SETTLEMENT_")):
            monkeypatch.delenv(name)
    monkeypatch.setenv("RESOURCE_SERVER_URL", "http://merchant.invalid:4021")
    monkeypatch.setenv("ENDPOINT_PATH", "/batch-settlement/svm")
    monkeypatch.setenv("CLIENT_SVM_PRIVATE_KEY", str(PAYER))
    monkeypatch.setenv("SVM_RPC_URL", "https://rpc.invalid")
    monkeypatch.setenv("EVM_RPC_URL", "https://evm-rpc.invalid")
    monkeypatch.setenv("SVM_NETWORK", SOLANA_DEVNET_CAIP2)
    return load_module(monkeypatch, "_e2e_svm_batch_client", CLIENT_DIR / "client.py")


def requirements(network=SOLANA_DEVNET_CAIP2, server=False):
    return PaymentRequirements(
        scheme="batch-settlement",
        network=network,
        asset=USDC_MAINNET_ADDRESS if network == SOLANA_MAINNET_CAIP2 else USDC_DEVNET_ADDRESS,
        amount="100",
        pay_to=str(RECEIVER.pubkey()),
        max_timeout_seconds=60,
        extra={
            "feePayer": str(FEE.pubkey()),
            "receiverAuthorizer": str(OPERATOR.pubkey()),
            "withdrawDelay": 900,
            "minDeposit": "10000",
            "tokenProgram": TOKEN_PROGRAM_ADDRESS,
            "recentBlockhash": str(Hash.default()),
            "recentSlot": 42,
            **({"voucherSigner": "server", "operator": str(OPERATOR.pubkey())} if server else {}),
        },
    )


def fake_rpc(scheme, network=SOLANA_DEVNET_CAIP2):
    rpc = MagicMock()
    rpc.get_account_info.return_value = SimpleNamespace(
        value=SimpleNamespace(
            owner=Pubkey.from_string(TOKEN_PROGRAM_ADDRESS),
            data=bytes(44) + bytes([6]) + bytes(37),
        )
    )
    rpc.get_program_accounts.return_value = SimpleNamespace(value=[])
    scheme._clients[network] = rpc
    return rpc


@pytest.mark.parametrize("sync", [False, True])
@pytest.mark.parametrize("network", [SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2])
@pytest.mark.parametrize(
    "endpoint", ["/batch-settlement-server-signed/svm", "batch_settlement_server_signed_svm"]
)
def test_svm_registration_uses_neutral_env_and_operator_policy(
    e2e, monkeypatch, sync, network, endpoint
):
    monkeypatch.setenv("CLIENT_EVM_PRIVATE_KEY", "0x" + "11" * 32)
    monkeypatch.setenv("BATCH_SETTLEMENT_CHANNEL", SALT)
    monkeypatch.setenv("EVM_BATCH_SETTLEMENT_CHANNEL", "0x" + "22" * 32)
    monkeypatch.setenv("BATCH_SETTLEMENT_PHASE", "full")
    monkeypatch.setenv("EVM_BATCH_SETTLEMENT_PHASE", "initial")
    monkeypatch.setenv("SVM_NETWORK", network)
    monkeypatch.setenv("ENDPOINT_PATH", endpoint)
    monkeypatch.setenv("CLIENT_SVM_SERVER_SIGNED_OPERATORS", f" , {OPERATOR.pubkey()} , ")
    monkeypatch.setenv("CLIENT_SVM_SERVER_SIGNED_MAX_DEPOSIT", " $0.01 ")
    ctx = e2e.create_e2e_client(sync=sync)
    assert isinstance(ctx.client, x402ClientSync if sync else x402Client)
    assert isinstance(ctx.batch_scheme, BatchSvmClientScheme)
    assert ctx.batch_settlement_phase == "full"
    assert ctx.batch_scheme.config.salt == str(0x0123456789ABCDEF)
    assert ctx.batch_scheme.config.discover_channels is True
    assert ctx.batch_scheme.config.rpc_url == "https://rpc.invalid"
    assert {
        "network": "solana:*",
        "scheme": "batch-settlement",
    } in ctx.client.get_registered_schemes()[2]
    assert {
        "network": "eip155:*",
        "scheme": "batch-settlement",
    } in ctx.client.get_registered_schemes()[2]
    client_accept, server_accept = requirements(network), requirements(network, server=True)
    assert ctx.client._policies[0](2, [client_accept, server_accept]) == [
        server_accept,
        client_accept,
    ]
    assert ctx.batch_scheme._trust.grant_for(server_accept).max_deposit == 10000


def test_legacy_aliases_preserve_evm_salt_and_correct_refund_family(e2e, monkeypatch):
    monkeypatch.setenv("CLIENT_EVM_PRIVATE_KEY", "0x" + "11" * 32)
    monkeypatch.setenv("EVM_BATCH_SETTLEMENT_CHANNEL", SALT)
    monkeypatch.setenv("EVM_BATCH_SETTLEMENT_PHASE", "recovery-refund")
    monkeypatch.setenv("ENDPOINT_PATH", "/batch-settlement/evm")
    evm = e2e.create_e2e_client(sync=True)
    assert isinstance(evm.batch_scheme, BatchSettlementEvmScheme)
    assert evm.batch_scheme._salt == SALT
    assert evm.batch_settlement_phase == "recovery-refund"
    monkeypatch.setenv("ENDPOINT_PATH", "/batch-settlement/svm/server-signed")
    svm = e2e.create_e2e_client(sync=True)
    assert isinstance(svm.batch_scheme, BatchSvmClientScheme)
    assert svm.batch_scheme.config.salt == str(0x0123456789ABCDEF)


def test_server_vouchers_require_explicit_operator_grant(e2e, monkeypatch):
    # A cap alone is not a grant, even though generic e2e spend controls are disabled.
    monkeypatch.setenv("CLIENT_SVM_SERVER_SIGNED_MAX_DEPOSIT", "$0.01")
    ctx = e2e.create_e2e_client(sync=True)
    with pytest.raises(UntrustedOperatorError):
        ctx.client.create_payment_payload(PaymentRequired(accepts=[requirements(server=True)]))
    assert ctx.batch_scheme.config.server_signed_channels_policy is None


def test_svm_salt_matches_typescript_u64_fold(e2e):
    assert e2e.svm_channel_salt("0x" + "ff" * 32) == str(2**64 - 1)
    assert e2e.svm_channel_salt("0x" + "00" * 32) == "0"
    assert e2e.svm_channel_salt(str(2**64 + 7)) == "7"
    with pytest.raises(ValueError):
        e2e.svm_channel_salt("-1")


def discovered_account(req, cfg, channel_id, settled=0):
    data = bytearray(256)
    data[:2] = bytes([1, 1])
    struct.pack_into("<QQQQqqI", data, 4, int(cfg["salt"]), 10000, settled, 0, 0, 0, 900)
    data[56:88] = distribution_hash([ChannelSplit(req.pay_to, 10000)])
    for offset, address in (
        (88, cfg["payer"]),
        (120, str(FEE.pubkey())),
        (152, cfg["payerAuthorizer"]),
        (184, req.asset),
        (216, str(FEE.pubkey())),
    ):
        data[offset : offset + 32] = bytes(Pubkey.from_string(address))
    struct.pack_into("<Q", data, 248, cfg["openSlot"])
    return SimpleNamespace(
        pubkey=Pubkey.from_string(channel_id),
        account=SimpleNamespace(
            owner=Pubkey.from_string(PAYMENT_CHANNELS_PROGRAM_ID),
            data=bytes(data),
            executable=False,
        ),
    )


def test_fresh_client_recovers_discovered_channel_from_corrective_voucher(e2e, monkeypatch):
    monkeypatch.setenv("BATCH_SETTLEMENT_CHANNEL", SALT)
    initial = e2e.create_e2e_client(sync=True)
    fake_rpc(initial.batch_scheme)
    req = requirements()
    opened = initial.client.create_payment_payload(PaymentRequired(accepts=[req]))
    cfg, voucher = opened.payload["channelConfig"], opened.payload["voucher"]
    channel_id = voucher["channelId"]
    # The initial process charged 200 offchain, while the chain's settled watermark is 0.
    recovered = e2e.create_e2e_client(sync=True)
    rpc = fake_rpc(recovered.batch_scheme)
    rpc.get_program_accounts.return_value = SimpleNamespace(
        value=[discovered_account(req, cfg, channel_id)]
    )
    stale = recovered.client.create_payment_payload(PaymentRequired(accepts=[req]))
    assert stale.payload["type"] == "voucher"
    assert stale.payload["voucher"]["maxClaimableAmount"] == "100"
    corrected = req.model_copy(
        update={
            "extra": {
                **req.extra,
                "channelState": {
                    "channelId": channel_id,
                    "balance": "10000",
                    "totalClaimed": "0",
                    "chargedCumulativeAmount": "200",
                },
                "voucherState": {
                    "signedMaxClaimable": "200",
                    "expiresAt": 0,
                    "signature": sign_voucher(PAYER, channel_id, 200),
                },
            }
        }
    )
    response = recovered.client.handle_payment_response(
        PaymentResponseContext(
            payment_payload=stale,
            requirements=req,
            payment_required=PaymentRequired(
                error="invalid_batch_settlement_svm_cumulative_amount_mismatch", accepts=[corrected]
            ),
        )
    )
    assert response.recovered
    next_payment = recovered.client.create_payment_payload(PaymentRequired(accepts=[corrected]))
    assert next_payment.payload["type"] == "voucher"
    assert next_payment.payload["voucher"]["channelId"] == channel_id
    assert next_payment.payload["voucher"]["maxClaimableAmount"] == "300"


@pytest.mark.parametrize("settled,valid_signer", [(200, True), (0, True), (200, False)])
def test_server_recovery_requires_confirmed_baseline_and_trusted_receipt(
    e2e, monkeypatch, settled, valid_signer
):
    monkeypatch.setenv("BATCH_SETTLEMENT_CHANNEL", SALT)
    monkeypatch.setenv("CLIENT_SVM_SERVER_SIGNED_OPERATORS", str(OPERATOR.pubkey()))
    initial = e2e.create_e2e_client(sync=True)
    fake_rpc(initial.batch_scheme)
    req = requirements(server=True)
    opened = initial.client.create_payment_payload(PaymentRequired(accepts=[req]))
    cfg = opened.payload["channelConfig"]
    channel_id = opened.payload["authorization"]["channelId"]
    recovered = e2e.create_e2e_client(sync=True)
    rpc = fake_rpc(recovered.batch_scheme)
    rpc.get_program_accounts.return_value = SimpleNamespace(
        value=[discovered_account(req, cfg, channel_id, settled)]
    )
    payment = recovered.client.create_payment_payload(PaymentRequired(accepts=[req]))
    assert payment.payload["type"] == "authorization"
    assert payment.payload["authorization"]["authorizedAmount"] == "100"
    receipt = SettleResponse(
        success=True,
        network=req.network,
        transaction="",
        extra={
            "commitmentId": "accepted-request",
            "chargedAmount": "100",
            "channelState": {"balance": "10000", "chargedCumulativeAmount": "300"},
            "voucher": {
                "channelId": channel_id,
                "maxClaimableAmount": "300",
                "expiresAt": 0,
                "signature": sign_voucher(OPERATOR if valid_signer else PAYER, channel_id, 300),
            },
        },
    )
    context = PaymentResponseContext(
        payment_payload=payment, requirements=req, settle_response=receipt
    )
    if settled == 200 and valid_signer:
        recovered.client.handle_payment_response(context)
        assert next(iter(recovered.batch_scheme._channels.values())).cumulative == 300
        refund = recovered.batch_scheme.create_refund_payload(req)
        assert refund["authorization"]["authorizedAmount"] == "0"
        assert refund["authorization"]["channelId"] == channel_id
    else:
        with pytest.raises(ValueError):
            recovered.client.handle_payment_response(context)
        assert next(iter(recovered.batch_scheme._channels.values())).cumulative == settled
        assert not recovered.batch_scheme._pending
        refund = recovered.batch_scheme.create_refund_payload(req)
        assert refund["authorization"]["authorizedAmount"] == "0"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "phase,request_count,refund_count",
    [("initial", 2, 0), ("recovery-refund", 1, 1), ("full", 2, 1)],
)
@pytest.mark.parametrize("sync", [True, False])
async def test_existing_phase_runners_dispatch_svm_refund(
    e2e, monkeypatch, capsys, phase, request_count, refund_count, sync
):
    monkeypatch.setenv("BATCH_SETTLEMENT_PHASE", phase)
    ctx = e2e.create_e2e_client(sync=sync)
    request_result = {"success": True, "status_code": 200, "payment_response": {"transaction": ""}}
    receipt = SettleResponse(
        success=True, network=SOLANA_DEVNET_CAIP2, transaction="confirmed-refund"
    )
    issue = (
        MagicMock(return_value=request_result) if sync else AsyncMock(return_value=request_result)
    )
    refund = MagicMock(return_value=receipt) if sync else AsyncMock(return_value=receipt)
    with pytest.raises(SystemExit) as exit_info:
        if sync:
            e2e.run_client_scenario_sync(ctx, issue, refund)
        else:
            await e2e.run_client_scenario(ctx, issue, refund)
    assert exit_info.value.code == 0
    result = json.loads(capsys.readouterr().out)
    assert result["success"]
    assert result["data"]["batchSettlement"]["phase"] == phase
    assert issue.call_count == request_count
    assert refund.call_count == refund_count
    if refund_count:
        refund.assert_called_once_with(ctx.base_url + ctx.endpoint_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["initial", "full"])
@pytest.mark.parametrize("sync", [True, False])
async def test_failed_deposit_stops_before_voucher_or_refund(e2e, monkeypatch, capsys, phase, sync):
    monkeypatch.setenv("BATCH_SETTLEMENT_PHASE", phase)
    ctx = e2e.create_e2e_client(sync=sync)
    failed = {
        "success": False,
        "status_code": 402,
        "error": "deposit rejected",
        "payment_response": {"success": False, "error_reason": "deposit rejected"},
    }
    issue = MagicMock(return_value=failed) if sync else AsyncMock(return_value=failed)
    refund = MagicMock() if sync else AsyncMock()
    with pytest.raises(SystemExit):
        if sync:
            e2e.run_client_scenario_sync(ctx, issue, refund)
        else:
            await e2e.run_client_scenario(ctx, issue, refund)
    result = json.loads(capsys.readouterr().out)
    assert result["success"] is False
    assert result["status_code"] == 402
    assert result["error"] == "deposit rejected"
    assert result["payment_response"] == failed["payment_response"]
    assert result["data"]["batchSettlement"]["requests"] == [failed]
    issue.assert_called_once()
    refund.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["full", "recovery-refund"])
@pytest.mark.parametrize("sync", [True, False])
@pytest.mark.parametrize("refund_raises", [True, False])
async def test_failed_voucher_survives_refund_cleanup(
    e2e, monkeypatch, capsys, phase, sync, refund_raises
):
    monkeypatch.setenv("BATCH_SETTLEMENT_PHASE", phase)
    ctx = e2e.create_e2e_client(sync=sync)
    deposit = {"success": True, "status_code": 200, "payment_response": {"transaction": "open"}}
    failed = {
        "success": False,
        "status_code": 402,
        "error": "voucher rejected",
        "payment_response": {"success": False, "error_reason": "voucher rejected"},
    }
    requests = [deposit, failed] if phase == "full" else [failed]
    issue = MagicMock(side_effect=requests) if sync else AsyncMock(side_effect=requests)
    refund = MagicMock() if sync else AsyncMock()
    if refund_raises:
        refund.side_effect = RuntimeError("refund unavailable")
    else:
        refund.return_value = SettleResponse(
            success=True, network=SOLANA_DEVNET_CAIP2, transaction="refund"
        )
    with pytest.raises(SystemExit):
        if sync:
            e2e.run_client_scenario_sync(ctx, issue, refund)
        else:
            await e2e.run_client_scenario(ctx, issue, refund)
    result = json.loads(capsys.readouterr().out)
    assert result["success"] is False
    assert result["status_code"] == 402
    assert result["error"] == "voucher rejected"
    assert result["payment_response"] == failed["payment_response"]
    details = result["data"]["batchSettlement"]
    assert details["requests"][:-1] == requests
    assert details["refund"]["success"] is not refund_raises
    if refund_raises:
        assert details["refund"]["error"] == "refund unavailable"
    refund.assert_called_once_with(ctx.base_url + ctx.endpoint_path)


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["httpx", "requests"])
async def test_http_entrypoints_report_non_2xx_as_failure(e2e, monkeypatch, capsys, transport):
    monkeypatch.setitem(sys.modules, "client", e2e)
    entry = load_module(
        monkeypatch, "_e2e_svm_" + transport, CLIENT_DIR / "http" / transport / "main.py"
    )
    response = SimpleNamespace(status_code=402, content=b"{}", headers={})
    session = MagicMock()
    if transport == "httpx":
        session.get = AsyncMock(return_value=response)
        session.__aenter__ = AsyncMock(return_value=session)
        session.__aexit__ = AsyncMock(return_value=None)
        monkeypatch.setattr(entry.httpx, "AsyncClient", lambda **kwargs: session)
    else:
        session.get.return_value = response
        monkeypatch.setattr(entry, "x402_requests", lambda client: session)
    with pytest.raises(SystemExit):
        if transport == "httpx":
            await entry.main()
        else:
            entry.main()
    result = json.loads(capsys.readouterr().out)
    assert result["success"] is False
    assert result["status_code"] == 402


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["httpx", "requests"])
async def test_http_refund_uses_plain_fetch_with_confirmation_timeout(e2e, monkeypatch, transport):
    import httpx

    ctx = e2e.create_e2e_client(sync=transport == "requests")
    url = ctx.base_url + ctx.endpoint_path
    headers = {"PAYMENT-SIGNATURE": "signed-refund"}
    response = SimpleNamespace(headers={"PAYMENT-RESPONSE": "refund-receipt"}, status_code=200)
    plain_get = MagicMock(return_value=response)
    monkeypatch.setattr(httpx, "get", plain_get)

    def refund(request_url, *, fetch):
        assert request_url == url
        assert fetch(request_url, headers) is response
        return "settled"

    monkeypatch.setattr(ctx.batch_scheme, "refund", refund)
    monkeypatch.setitem(sys.modules, "client", e2e)
    entry = load_module(
        monkeypatch, "_e2e_refund_" + transport, CLIENT_DIR / "http" / transport / "main.py"
    )
    monkeypatch.setattr(entry, "create_e2e_client", lambda **kwargs: ctx)

    if transport == "httpx":

        async def scenario(context, issue_request, refund):
            assert await refund(url) == "settled"

        monkeypatch.setattr(entry, "run_client_scenario", scenario)
        await entry.main()
    else:

        def scenario(context, issue_request, refund):
            assert refund(url) == "settled"

        monkeypatch.setattr(entry, "run_client_scenario_sync", scenario)
        entry.main()

    plain_get.assert_called_once()
    assert plain_get.call_args.args == (url,)
    assert plain_get.call_args.kwargs["headers"] == headers
    timeout = plain_get.call_args.kwargs["timeout"]
    assert timeout.read == 30.0 and timeout.connect == 10.0


def test_http_refund_preserves_evm_call_signature(e2e):
    scheme = MagicMock(spec=BatchSettlementEvmScheme)
    ctx = SimpleNamespace(batch_scheme=scheme)
    assert e2e.refund_batch_channel(ctx, "https://merchant.invalid") is scheme.refund.return_value
    scheme.refund.assert_called_once_with("https://merchant.invalid")


@pytest.mark.asyncio
@pytest.mark.parametrize("server_mode", [False, True])
async def test_mcp_svm_refund_uses_existing_transport_adapter(e2e, monkeypatch, server_mode):
    from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY

    tool_name = "batch_settlement_server_signed_svm" if server_mode else "batch_settlement_svm"
    monkeypatch.setenv("ENDPOINT_PATH", tool_name)
    monkeypatch.setenv("CLIENT_SVM_SERVER_SIGNED_OPERATORS", str(OPERATOR.pubkey()))
    ctx = e2e.create_e2e_client()
    assert isinstance(ctx.batch_scheme, BatchSvmClientScheme)
    fake_rpc(ctx.batch_scheme)
    req = requirements(server=server_mode)
    inner = ctx.batch_scheme.create_payment_payload(req)
    credential = inner.get("voucher") or inner["authorization"]
    channel_id = credential["channelId"]
    extra = {
        "commitmentId": "first-request",
        "chargedAmount": "100",
        "channelState": {"balance": "10000", "chargedCumulativeAmount": "100"},
    }
    if server_mode:
        extra["voucher"] = {
            "channelId": channel_id,
            "maxClaimableAmount": "100",
            "expiresAt": 0,
            "signature": sign_voucher(OPERATOR, channel_id, 100),
        }
    receipt = SettleResponse(success=True, network=req.network, transaction="deposit", extra=extra)
    ctx.batch_scheme.on_payment_response(
        PaymentResponseContext(
            payment_payload=PaymentPayload(x402_version=2, accepted=req, payload=inner),
            requirements=req,
            settle_response=receipt,
        )
    )
    required = PaymentRequired(accepts=[req])
    refund_receipt = SettleResponse(
        success=True, network=req.network, transaction="refund", amount="9900"
    )
    calls = []

    async def raw_call_tool(*, name, arguments, meta=None):
        assert name == tool_name and arguments == {}
        calls.append(meta)
        if meta is None:
            return SimpleNamespace(isError=True)
        raw = meta[MCP_PAYMENT_META_KEY]["payload"]
        assert raw["type"] == "refund"
        assert raw["channelConfig"] == inner["channelConfig"]
        if server_mode:
            assert raw["authorization"]["authorizedAmount"] == "0"
        else:
            assert raw["voucher"]["maxClaimableAmount"] == "100"
        return SimpleNamespace(
            isError=False, meta={MCP_PAYMENT_RESPONSE_META_KEY: refund_receipt.model_dump()}
        )

    mcp = MagicMock()
    mcp._session.call_tool = raw_call_tool
    mcp.__aenter__ = AsyncMock(return_value=mcp)
    mcp.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr("x402.mcp.create_x402_mcp_client", lambda *args, **kwargs: mcp)
    monkeypatch.setattr("x402.mcp.utils.convert_mcp_result", lambda value: value)
    monkeypatch.setattr(
        "x402.mcp.utils.extract_payment_required_from_result", lambda value: required
    )
    monkeypatch.setitem(sys.modules, "client", e2e)
    entry = load_module(monkeypatch, "_e2e_svm_mcp", CLIENT_DIR / "mcp" / "main.py")
    monkeypatch.setattr(entry, "create_e2e_client", lambda: ctx)

    async def scenario(context, issue_request, refund):
        result = await refund(context.base_url + context.endpoint_path)
        assert result == refund_receipt

    monkeypatch.setattr(entry, "run_client_scenario", scenario)
    await entry.main()
    assert len(calls) == 2  # Probe, then the signed refund through raw MCP metadata.
    assert not ctx.batch_scheme._channels


@pytest.mark.parametrize(
    "override,expected", [({"amount": "50%"}, "500"), ({"amount": "200"}, "200")]
)
def test_mcp_server_uses_catalog_metering(monkeypatch, override, expected):
    spec = importlib.util.spec_from_file_location(
        "_e2e_mcp_metering",
        CLIENT_DIR.parents[1] / "servers/python/mcp/main.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    requirements = PaymentRequirements(
        scheme="batch-settlement",
        network=SOLANA_DEVNET_CAIP2,
        asset=USDC_DEVNET_ADDRESS,
        amount="1000",
        pay_to=str(RECEIVER.pubkey()),
        max_timeout_seconds=60,
    )
    context = SimpleNamespace(payment_requirements=requirements)
    module.settlement_hooks(SimpleNamespace(), override).on_after_execution(context)
    assert context.payment_requirements.amount == expected
    assert module.settlement_hooks(SimpleNamespace(), None) is None
