"""Exercise the existing e2e entrypoints without starting servers or contacting RPCs."""

import importlib.util
import json
import os
import socket
import sys
from pathlib import Path

import pytest
from solders.keypair import Keypair

from x402 import x402ResourceServer, x402ResourceServerSync
from x402.mechanisms.svm.batch_settlement import (
    BatchFacilitatorKeypairSigner,
    BatchSvmFacilitatorScheme,
    BatchSvmServerScheme,
    MemoryBatchPendingSettlementStore,
    MemoryPaymentChannelStorage,
)
from x402.mechanisms.svm.signers import KeypairSigner
from x402.schemas import PaymentRequirements, SupportedKind, SupportedResponse

ROOT = Path(__file__).resolve().parents[4]
CATALOG = ROOT / "e2e/config"
SVM_CATALOG = json.loads((CATALOG / "mechanisms_svm.json").read_text())
AUTH, OPERATOR, FEE, RECEIVER = [Keypair.from_seed(bytes([n]) * 32) for n in range(1, 5)]


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for key in os.environ:
        if key.startswith(("SERVER_", "FACILITATOR_", "E2E_")) or key in {
            "SVM_NETWORK",
            "SVM_RPC_URL",
            "SVM_ARCHIVE_RPC_URL",
            "EVM_NETWORK",
            "EVM_RPC_URL",
            "TVM_NETWORK",
            "PORT",
        }:
            monkeypatch.delenv(key)
    monkeypatch.setenv("E2E_MECHANISMS_CATALOG", str(CATALOG))

    def unexpected_network(*args, **kwargs):
        raise AssertionError("e2e registration must not make network requests")

    monkeypatch.setattr(socket, "getaddrinfo", unexpected_network)
    monkeypatch.setattr(socket.socket, "connect", unexpected_network)
    monkeypatch.setattr(socket.socket, "connect_ex", unexpected_network)


def load_module(monkeypatch, name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module


def server_config(monkeypatch):
    load_module(monkeypatch, "catalog", "e2e/servers/python/catalog.py")
    return load_module(monkeypatch, "_e2e_server_config", "e2e/servers/python/config.py")


def facilitator_main(monkeypatch):
    load_module(monkeypatch, "bazaar", "e2e/facilitators/python/bazaar.py")
    return load_module(monkeypatch, "_e2e_facilitator", "e2e/facilitators/python/main.py")


@pytest.mark.parametrize("server_type", [x402ResourceServer, x402ResourceServerSync])
@pytest.mark.parametrize("environment", ["testnet", "mainnet"])
@pytest.mark.parametrize("with_operator", [False, True])
def test_server_registers_batch_with_distinct_signers(
    monkeypatch, server_type, environment, with_operator
):
    network = SVM_CATALOG[environment]["caip2"]
    monkeypatch.setenv("SERVER_SVM_ADDRESS", str(RECEIVER.pubkey()))
    monkeypatch.setenv("SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", str(AUTH))
    monkeypatch.setenv("SVM_NETWORK", network)
    if with_operator:
        monkeypatch.setenv("SERVER_SVM_OPERATOR_PRIVATE_KEY", str(OPERATOR))
    config = server_config(monkeypatch)
    server = server_type()
    config.configure_resource_server(server, config.load_server_config())
    assert server.has_registered_scheme(network, "exact")
    scheme = server.get_registered_scheme(network, "batch-settlement")
    assert isinstance(scheme, BatchSvmServerScheme)
    assert isinstance(scheme.config.receiver_authorizer, KeypairSigner)
    assert scheme.config.receiver_authorizer.address == str(AUTH.pubkey())
    assert (scheme.config.operator.address if scheme.config.operator else None) == (
        str(OPERATOR.pubkey()) if with_operator else None
    )

    requirements = PaymentRequirements(
        scheme="batch-settlement",
        network=network,
        asset=scheme.parse_price("$0.001", network).asset,
        amount="1000",
        pay_to=str(RECEIVER.pubkey()),
        max_timeout_seconds=60,
    )
    supported = SupportedKind(
        x402_version=2,
        scheme="batch-settlement",
        network=network,
        extra={"feePayer": str(FEE.pubkey())},
    )
    enriched = scheme.enhance_payment_requirements(requirements, supported, [])
    assert enriched.extra["receiverAuthorizer"] == str(AUTH.pubkey())
    assert enriched.extra.get("operator") == (str(OPERATOR.pubkey()) if with_operator else None)
    assert enriched.extra.get("voucherSigner") == ("server" if with_operator else None)
    # The client-signed catalog route stays client-signed when an operator is configured.
    client_requirements = requirements.model_copy(update={"extra": {"voucherSigner": "client"}})
    client_extra = scheme.enhance_payment_requirements(client_requirements, supported, []).extra
    assert "operator" not in client_extra
    assert "voucherSigner" not in client_extra


@pytest.mark.parametrize("with_operator", [False, True])
def test_server_requires_receiver_authorizer_for_batch(monkeypatch, with_operator):
    monkeypatch.setenv("SERVER_SVM_ADDRESS", str(RECEIVER.pubkey()))
    if with_operator:
        monkeypatch.setenv("SERVER_SVM_OPERATOR_PRIVATE_KEY", str(OPERATOR))
    config = server_config(monkeypatch)
    server = x402ResourceServerSync()
    config.configure_resource_server(server, config.load_server_config())
    assert server.has_registered_scheme(SVM_CATALOG["testnet"]["caip2"], "exact")
    assert not server.has_registered_scheme(SVM_CATALOG["testnet"]["caip2"], "batch-settlement")


@pytest.mark.parametrize(
    "bad_key", ["SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", "SERVER_SVM_OPERATOR_PRIVATE_KEY"]
)
def test_server_rejects_invalid_batch_keys(monkeypatch, bad_key):
    monkeypatch.setenv("SERVER_SVM_ADDRESS", str(RECEIVER.pubkey()))
    monkeypatch.setenv("SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", str(AUTH))
    monkeypatch.setenv(bad_key, "invalid")
    config = server_config(monkeypatch)
    with pytest.raises(ValueError):
        config.configure_resource_server(x402ResourceServerSync(), config.load_server_config())


@pytest.mark.parametrize("environment", ["testnet", "mainnet"])
@pytest.mark.parametrize("custom_rpc", [None, "http://rpc.invalid/svm"])
def test_facilitator_registers_batch_and_exact_on_catalog_network(
    monkeypatch, environment, custom_rpc
):
    monkeypatch.setenv("FACILITATOR_SVM_PRIVATE_KEY", str(FEE))
    network = SVM_CATALOG[environment]["caip2"]
    if environment == "mainnet":
        monkeypatch.setenv("SVM_NETWORK", network)
    if custom_rpc:
        monkeypatch.setenv("SVM_RPC_URL", custom_rpc)
    main = facilitator_main(monkeypatch)
    assert isinstance(main.svm_signer, BatchFacilitatorKeypairSigner)
    assert main.svm_signer._custom_rpc_url == (
        custom_rpc or SVM_CATALOG[environment]["rpcUrlDefault"]
    )
    supported = main.facilitator.get_supported()
    v2_kinds = [kind for kind in supported.kinds if kind.x402_version == 2]
    assert {(kind.scheme, kind.network) for kind in v2_kinds} == {
        ("exact", network),
        ("batch-settlement", network),
    }
    batch_kind = next(kind for kind in v2_kinds if kind.scheme == "batch-settlement")
    assert batch_kind.extra["feePayer"] == str(FEE.pubkey())
    schemes = [entry.facilitator for entry in main.facilitator._schemes]
    batch_scheme = next(s for s in schemes if isinstance(s, BatchSvmFacilitatorScheme))
    assert isinstance(batch_scheme.config.channel_storage, MemoryPaymentChannelStorage)
    assert isinstance(
        batch_scheme.config.pending_settlement_store, MemoryBatchPendingSettlementStore
    )
    assert any(kind.x402_version == 1 and kind.scheme == "exact" for kind in supported.kinds)
    assert main.svm_signer._clients == {}


def test_evm_server_and_facilitator_registration_unchanged(monkeypatch):
    monkeypatch.setenv("SERVER_EVM_ADDRESS", "0x" + "12" * 20)
    config = server_config(monkeypatch)
    server = x402ResourceServerSync()
    config.configure_resource_server(server, config.load_server_config())
    evm_network = json.loads((CATALOG / "mechanisms_evm.json").read_text())["testnet"]["caip2"]
    for scheme in ("exact", "upto", "batch-settlement"):
        assert server.has_registered_scheme(evm_network, scheme)
    monkeypatch.setenv("FACILITATOR_EVM_PRIVATE_KEY", "0x" + "01" * 32)
    main = facilitator_main(monkeypatch)
    supported = main.facilitator.get_supported()
    assert {(kind.scheme, kind.network) for kind in supported.kinds if kind.x402_version == 2} == {
        (scheme, evm_network) for scheme in ("exact", "upto", "batch-settlement")
    }
    assert main.svm_signer is None


@pytest.mark.parametrize("value", ["memory", " InMemory ", "true", "1"])
def test_facilitator_accepts_explicit_memory_binding_store(monkeypatch, value):
    monkeypatch.setenv("FACILITATOR_SVM_PRIVATE_KEY", str(FEE))
    monkeypatch.setenv("FACILITATOR_SVM_BATCH_BINDING_STORE", value)
    main = facilitator_main(monkeypatch)
    assert any(kind.scheme == "batch-settlement" for kind in main.facilitator.get_supported().kinds)


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("FACILITATOR_SVM_BATCH_BINDING_STORE", "none"),
        ("FACILITATOR_SVM_BATCH_BINDING_STORE", "unknown"),
        ("SVM_ARCHIVE_RPC_URL", "http://archive.invalid"),
    ],
)
def test_facilitator_rejects_unimplemented_binding_recovery(monkeypatch, key, value):
    monkeypatch.setenv("FACILITATOR_SVM_PRIVATE_KEY", str(FEE))
    monkeypatch.setenv(key, value)
    with pytest.raises(ValueError, match=key):
        facilitator_main(monkeypatch)


@pytest.mark.parametrize("environment", ["testnet", "mainnet"])
def test_catalog_preserves_batch_route_modes_and_min_deposit(monkeypatch, tmp_path, environment):
    # Use the same catalog injection path as the e2e harness, including local overrides.
    svm_catalog = json.loads((CATALOG / "mechanisms_svm.json").read_text())
    for path in ("/batch-settlement/svm", "/batch-settlement-server-signed/svm"):
        svm_catalog["routes"][path].setdefault("requirementsExtra", {})["minDeposit"] = "25000"
    (tmp_path / "mechanisms_svm.json").write_text(json.dumps(svm_catalog))
    (tmp_path / "mechanisms_global.json").write_text(
        (CATALOG / "mechanisms_global.json").read_text()
    )
    monkeypatch.setenv("E2E_MECHANISMS_CATALOG", str(tmp_path))
    monkeypatch.setenv("SERVER_SVM_ADDRESS", str(RECEIVER.pubkey()))
    monkeypatch.setenv("SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", str(AUTH))
    monkeypatch.setenv("SERVER_SVM_OPERATOR_PRIVATE_KEY", str(OPERATOR))
    network = SVM_CATALOG[environment]["caip2"]
    monkeypatch.setenv("SVM_NETWORK", network)
    config = server_config(monkeypatch)
    cfg = config.load_server_config()
    server = x402ResourceServerSync()
    config.configure_resource_server(server, cfg)
    scheme = server.get_registered_scheme(network, "batch-settlement")
    routes = config.build_payment_routes(cfg)
    supported = SupportedKind(
        x402_version=2,
        scheme="batch-settlement",
        network=network,
        extra={"feePayer": str(FEE.pubkey())},
    )
    for path, server_signed in (
        ("/batch-settlement/svm", False),
        ("/batch-settlement-server-signed/svm", True),
    ):
        accepts = routes[f"GET {path}"]["accepts"]
        price = scheme.parse_price(accepts["price"], network)
        requirements = PaymentRequirements(
            scheme=accepts["scheme"],
            network=accepts["network"],
            asset=price.asset,
            amount=price.amount,
            pay_to=accepts["payTo"],
            max_timeout_seconds=60,
            extra=accepts["extra"],
        )
        assert scheme.is_server_signed(requirements) is server_signed
        enriched = scheme.enhance_payment_requirements(requirements, supported, [])
        assert enriched.extra["minDeposit"] == "25000"
        assert enriched.extra.get("voucherSigner") == ("server" if server_signed else None)


def test_catalog_gates_requires_env_using_supplied_environment(monkeypatch):
    config = server_config(monkeypatch)
    catalog = sys.modules["catalog"]
    lookup = {"SERVER_SVM_ADDRESS": str(RECEIVER.pubkey())}
    client_path = "/batch-settlement/svm"
    server_path = "/batch-settlement-server-signed/svm"

    def paths():
        mounted = {route.path for route in catalog.catalog_routes(lookup.get)}
        resolved = {route.path for route in config.resolve_routes(lookup.get)}
        return mounted, resolved

    for route_paths in paths():
        assert client_path not in route_paths and server_path not in route_paths
    lookup["SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"] = "   "
    assert client_path not in paths()[0]
    lookup["SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"] = str(AUTH)
    for route_paths in paths():
        assert client_path in route_paths and server_path not in route_paths
    lookup["SERVER_SVM_OPERATOR_PRIVATE_KEY"] = str(OPERATOR)
    for route_paths in paths():
        assert client_path in route_paths and server_path in route_paths
    # The generic absence gate is used by mutually exclusive catalog variants.
    monkeypatch.setitem(
        catalog._CATALOG["routes"][client_path],
        "requiresEnvAbsent",
        "SERVER_SVM_OPERATOR_PRIVATE_KEY",
    )
    for route_paths in paths():
        assert client_path not in route_paths and server_path in route_paths


def test_fastapi_initializes_middleware_once_and_health_needs_no_facilitator(monkeypatch):
    from fastapi.testclient import TestClient

    from x402.http import HTTPFacilitatorClient
    from x402.http.utils import decode_payment_required_header

    network = SVM_CATALOG["testnet"]["caip2"]
    monkeypatch.setenv("SERVER_SVM_ADDRESS", str(RECEIVER.pubkey()))
    monkeypatch.setenv("SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", str(AUTH))
    monkeypatch.setenv("SERVER_SVM_OPERATOR_PRIVATE_KEY", str(OPERATOR))
    monkeypatch.setenv("FACILITATOR_URL", "http://facilitator.invalid")
    monkeypatch.setenv("E2E_EXCLUDE_SCHEMES", "exact,upto,auth-capture")
    supported_calls = []

    def get_supported(self):
        supported_calls.append(True)
        if len(supported_calls) > 1:
            raise AssertionError("requests must reuse initialized payment middleware")
        return SupportedResponse(
            kinds=[
                SupportedKind(
                    x402_version=2,
                    scheme="batch-settlement",
                    network=network,
                    extra={"feePayer": str(FEE.pubkey())},
                )
            ],
            extensions=[],
            signers={},
        )

    monkeypatch.setattr(HTTPFacilitatorClient, "get_supported", get_supported)
    config = server_config(monkeypatch)
    monkeypatch.setitem(sys.modules, "config", config)
    load_module(monkeypatch, "handlers", "e2e/servers/python/handlers.py")
    main = load_module(monkeypatch, "_e2e_fastapi", "e2e/servers/python/http/fastapi/main.py")
    assert len(supported_calls) == 1
    with TestClient(main.app) as client:
        for _ in range(2):
            response = client.get("/health")
            assert response.status_code == 200
            assert response.json()["server"] == "fastapi"
        for path, server_signed in (
            ("/batch-settlement/svm", False),
            ("/batch-settlement-server-signed/svm", True),
        ):
            response = client.get(path, headers={"Accept": "application/json"})
            assert response.status_code == 402
            required = decode_payment_required_header(response.headers["payment-required"])
            assert required.accepts[0].extra.get("voucherSigner") == (
                "server" if server_signed else None
            )
    assert len(supported_calls) == 1
