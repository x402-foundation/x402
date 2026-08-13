"""Tests for Sign-In-With-X extension."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from eth_account import Account

from x402 import x402ResourceServer
from x402.extensions.sign_in_with_x import (
    SIGN_IN_WITH_X,
    SOLANA_DEVNET,
    SOLANA_MAINNET,
    CreateSIWxHookOptions,
    CreateSIWxRequestHookOptions,
    CreateSIWxSettleHookOptions,
    DeclareSIWxOptions,
    InMemorySIWxStorage,
    SIWxPayload,
    SIWxValidationCode,
    SIWxValidationOptions,
    SIWxVerifyOptions,
    create_siwx_client_hook,
    create_siwx_payload,
    create_siwx_request_hook,
    create_siwx_resource_server_extension,
    create_siwx_settle_hook,
    declare_siwx_extension,
    decode_base58,
    encode_base58,
    encode_siwx_header,
    extract_solana_chain_reference,
    format_siws_message,
    is_solana_signer,
    normalize_configured_origin,
    parse_siwx_header,
    validate_siwx_message,
    verify_siwx_signature,
    verify_solana_signature,
)
from x402.http.types import HTTPRequestContext, PaymentOption, RouteConfig
from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    ResourceInfo,
)
from x402.schemas.hooks import (
    GrantAccessResult,
    PaymentRequiredContext,
    PaymentRequiredHeadersResult,
)
from x402.server_base import ERR_EXTENSION_ECHO_MISMATCH

pytest.importorskip("siwe")
pytest.importorskip("nacl")

API_ORIGIN = "https://api.example.com"
EXAMPLE_ORIGIN = "http://example.com"


def _valid_payload(**overrides) -> SIWxPayload:
    now = datetime.now(timezone.utc)
    base = {
        "domain": "api.example.com",
        "address": "0x1234567890123456789012345678901234567890",
        "statement": "Sign in to access your content",
        "uri": "https://api.example.com/data",
        "version": "1",
        "chainId": "eip155:8453",
        "type": "eip191",
        "nonce": "abc123def456",
        "issuedAt": now.isoformat().replace("+00:00", "Z"),
        "expirationTime": (now + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
        "resources": ["https://api.example.com/data"],
        "signature": "0xabcdef1234567890",
    }
    base.update(overrides)
    return SIWxPayload.model_validate(base)


def _test_challenge(**opts) -> dict:
    networks = opts.pop("network")
    if isinstance(networks, str):
        networks = [networks]
    return {
        SIGN_IN_WITH_X: {
            "info": {
                "domain": opts.get("domain", "api.example.com"),
                "uri": opts.get("resource_uri", "https://api.example.com/resource"),
                "version": "1",
                "nonce": secrets.token_hex(16),
                "issuedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                **(
                    {
                        "expirationTime": (
                            datetime.now(timezone.utc)
                            + timedelta(seconds=opts["expiration_seconds"])
                        )
                        .isoformat()
                        .replace("+00:00", "Z")
                    }
                    if "expiration_seconds" in opts
                    else {}
                ),
                **({"statement": opts["statement"]} if "statement" in opts else {}),
                "resources": [opts.get("resource_uri", "https://api.example.com/resource")],
            },
            "supportedChains": [
                {
                    "chainId": n,
                    "type": "ed25519" if n.startswith("solana:") else "eip191",
                }
                for n in networks
            ],
            "schema": {"header": "sign-in-with-x", "type": "object"},
        }
    }


class TestPayloadSchema:
    def test_valid_payload(self):
        assert _valid_payload().domain == "api.example.com"

    def test_minimal_payload(self):
        payload = SIWxPayload.model_validate(
            {
                "domain": "api.example.com",
                "address": "0x1234567890123456789012345678901234567890",
                "uri": "https://api.example.com",
                "version": "1",
                "chainId": "eip155:8453",
                "type": "eip191",
                "nonce": "abc123",
                "issuedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "signature": "0xabcdef",
            }
        )
        assert payload.nonce == "abc123"


class TestParseEncode:
    def test_roundtrip(self):
        payload = _valid_payload()
        encoded = encode_siwx_header(payload)
        parsed = parse_siwx_header(encoded)
        assert parsed.domain == payload.domain
        assert parsed.signature == payload.signature

    def test_invalid_base64(self):
        with pytest.raises(ValueError, match="not valid base64"):
            parse_siwx_header("not-valid-base64!@#")

    def test_invalid_json(self):
        import base64

        bad = base64.b64encode(b"not json").decode()
        with pytest.raises(ValueError, match="not valid JSON"):
            parse_siwx_header(bad)


class TestDeclare:
    def test_static_declaration(self):
        result = declare_siwx_extension(
            DeclareSIWxOptions(
                network="eip155:8453",
                statement="Sign in to access",
                expiration_seconds=300,
            )
        )
        ext = result[SIGN_IN_WITH_X]
        assert ext["info"]["version"] == "1"
        assert ext["info"]["statement"] == "Sign in to access"
        assert ext["info"].get("nonce") is None
        assert ext["supportedChains"][0]["chainId"] == "eip155:8453"
        assert ext["_options"].expiration_seconds == 300


class TestValidate:
    @pytest.mark.asyncio
    async def test_valid_message(self):
        payload = _valid_payload()
        result = await validate_siwx_message(payload, API_ORIGIN)
        assert result.is_valid is True

    @pytest.mark.asyncio
    async def test_domain_mismatch(self):
        result = await validate_siwx_message(_valid_payload(), "https://different.example.com")
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_domain_mismatch"
        assert "Domain mismatch" in (result.invalid_message or "")

    @pytest.mark.parametrize(
        ("invalid_reason", "overrides", "options"),
        [
            (
                "invalid_siwx_uri_mismatch",
                {"uri": "https://evil.example.com/data"},
                None,
            ),
            ("invalid_siwx_issued_at", {"issuedAt": "not-a-date"}, None),
            (
                "invalid_siwx_issued_at_too_old",
                {
                    "issuedAt": (datetime.now(timezone.utc) - timedelta(minutes=10))
                    .isoformat()
                    .replace("+00:00", "Z")
                },
                None,
            ),
            (
                "invalid_siwx_issued_at_in_future",
                {
                    "issuedAt": (datetime.now(timezone.utc) + timedelta(seconds=60))
                    .isoformat()
                    .replace("+00:00", "Z")
                },
                None,
            ),
            ("invalid_siwx_expiration_time", {"expirationTime": "not-a-date"}, None),
            (
                "invalid_siwx_expired",
                {
                    "expirationTime": (datetime.now(timezone.utc) - timedelta(seconds=1))
                    .isoformat()
                    .replace("+00:00", "Z")
                },
                None,
            ),
            ("invalid_siwx_not_before", {"notBefore": "not-a-date"}, None),
            (
                "invalid_siwx_not_yet_valid",
                {
                    "notBefore": (datetime.now(timezone.utc) + timedelta(seconds=60))
                    .isoformat()
                    .replace("+00:00", "Z")
                },
                None,
            ),
            (
                "invalid_siwx_nonce",
                {},
                SIWxValidationOptions(check_nonce=lambda _nonce: False),
            ),
        ],
    )
    @pytest.mark.asyncio
    async def test_validation_failure_codes(
        self,
        invalid_reason: SIWxValidationCode,
        overrides: dict,
        options: SIWxValidationOptions | None,
    ):
        payload = _valid_payload(
            **{
                "issuedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                **overrides,
            }
        )
        result = await validate_siwx_message(payload, API_ORIGIN, options)
        assert result.is_valid is False
        assert result.invalid_reason == invalid_reason

    @pytest.mark.asyncio
    async def test_propagates_check_nonce_errors(self):
        payload = _valid_payload(
            issuedAt=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )

        def _raise(_nonce: str) -> bool:
            raise RuntimeError("nonce store unavailable")

        with pytest.raises(RuntimeError, match="nonce store unavailable"):
            await validate_siwx_message(
                payload,
                API_ORIGIN,
                SIWxValidationOptions(check_nonce=_raise),
            )

    @pytest.mark.asyncio
    async def test_rejects_origin_prefix_attacker_domain(self):
        payload = _valid_payload(uri="https://api.example.com.attacker.test/data")
        result = await validate_siwx_message(payload, API_ORIGIN)
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_uri_mismatch"
        assert "URI mismatch" in (result.invalid_message or "")

    @pytest.mark.asyncio
    async def test_rejects_malformed_signed_uri(self):
        payload = _valid_payload(uri="not-a-valid-uri")
        result = await validate_siwx_message(payload, API_ORIGIN)
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_uri_mismatch"
        assert "Invalid URI" in (result.invalid_message or "")


class TestNormalizeConfiguredOrigin:
    def test_accepts_valid_origin(self):
        assert normalize_configured_origin("https://api.example.com") == "https://api.example.com"

    def test_rejects_path(self):
        with pytest.raises(ValueError, match="must not include a path"):
            normalize_configured_origin("https://api.example.com/profile")

    def test_rejects_invalid_scheme(self):
        with pytest.raises(ValueError, match="must use http: or https:"):
            normalize_configured_origin("ftp://api.example.com")

    def test_rejects_invalid_url(self):
        with pytest.raises(ValueError, match="not a valid URL"):
            normalize_configured_origin("not-a-url")


class TestEvmIntegration:
    @pytest.mark.asyncio
    async def test_sign_and_verify(self):
        account = Account.create()
        challenge = _test_challenge(
            domain="api.example.com",
            resource_uri="https://api.example.com/resource",
            network="eip155:8453",
            statement="Sign in",
        )
        ext = challenge[SIGN_IN_WITH_X]
        complete = {
            **ext["info"],
            "chainId": ext["supportedChains"][0]["chainId"],
            "type": "eip191",
        }
        payload = await create_siwx_payload(complete, account)
        parsed = parse_siwx_header(encode_siwx_header(payload))
        assert (await validate_siwx_message(parsed, API_ORIGIN)).is_valid
        verification = await verify_siwx_signature(parsed)
        assert verification.is_valid
        assert verification.payer.lower() == account.address.lower()


class TestSolana:
    def test_constants(self):
        assert SOLANA_MAINNET == "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        assert SOLANA_DEVNET == "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"

    def test_base58_roundtrip(self):
        original = bytes([1, 2, 3, 4, 5, 6, 7, 8])
        assert decode_base58(encode_base58(original)) == original

    def test_extract_reference(self):
        assert extract_solana_chain_reference(SOLANA_MAINNET) == "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"

    def test_format_siws(self):
        message = format_siws_message(
            {
                "domain": "api.example.com",
                "uri": "https://api.example.com/data",
                "statement": "Sign in",
                "version": "1",
                "chainId": SOLANA_MAINNET,
                "type": "ed25519",
                "nonce": "abc123",
                "issuedAt": "2024-01-01T00:00:00.000Z",
            },
            "BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW",
        )
        assert "Solana account" in message
        assert "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" in message

    @pytest.mark.asyncio
    async def test_solana_sign_verify(self):
        import nacl.signing

        keypair = nacl.signing.SigningKey.generate()
        address = encode_base58(bytes(keypair.verify_key))

        class _Signer:
            async def sign_message(self, message: bytes) -> bytes:
                return keypair.sign(message).signature

            public_key = address

        challenge = _test_challenge(
            domain="api.example.com",
            resource_uri="https://api.example.com/resource",
            network=SOLANA_MAINNET,
        )
        ext = challenge[SIGN_IN_WITH_X]
        complete = {
            **ext["info"],
            "chainId": ext["supportedChains"][0]["chainId"],
            "type": "ed25519",
        }
        payload = await create_siwx_payload(complete, _Signer())
        result = await verify_siwx_signature(payload)
        assert result.is_valid
        assert result.payer == address

    def test_rejects_small_order_public_key_forgery(self):
        public_key = b"\x01" + bytes(31)
        signature = b"\x01" + bytes(63)

        assert verify_solana_signature("arbitrary message", signature, public_key) is False

    @pytest.mark.asyncio
    async def test_siwx_rejects_small_order_public_key_forgery(self):
        public_key = b"\x01" + bytes(31)
        signature = b"\x01" + bytes(63)
        payload = _valid_payload(
            chainId=SOLANA_MAINNET,
            type="ed25519",
            address=encode_base58(public_key),
            signature=encode_base58(signature),
        )

        result = await verify_siwx_signature(payload)
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_signature"

    @pytest.mark.asyncio
    async def test_keypair_signer_sign_verify(self):
        pytest.importorskip("solders")
        from solders.keypair import Keypair

        from x402.mechanisms.svm.signers import KeypairSigner

        keypair = Keypair()
        signer = KeypairSigner(keypair)
        assert is_solana_signer(signer)

        challenge = _test_challenge(
            domain="api.example.com",
            resource_uri="https://api.example.com/resource",
            network=SOLANA_MAINNET,
        )
        ext = challenge[SIGN_IN_WITH_X]
        complete = {
            **ext["info"],
            "chainId": ext["supportedChains"][0]["chainId"],
            "type": "ed25519",
        }
        payload = await create_siwx_payload(complete, signer)
        result = await verify_siwx_signature(payload)
        assert result.is_valid
        assert result.payer == signer.address


class TestVerifyStructuredErrors:
    @pytest.mark.asyncio
    async def test_rejects_unsupported_chain_namespace(self):
        payload = _valid_payload(chainId="cosmos:cosmoshub-4")
        result = await verify_siwx_signature(payload)
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_unsupported_chain"
        assert "Unsupported chain namespace" in (result.invalid_message or "")

    @pytest.mark.asyncio
    async def test_rejects_malformed_evm_chain_id(self):
        payload = _valid_payload(chainId="eip155:not-a-number")
        result = await verify_siwx_signature(payload)
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_chain_id"
        assert "Invalid EVM chainId format" in (result.invalid_message or "")

    @pytest.mark.asyncio
    async def test_rejects_invalid_solana_signature_length(self):
        payload = _valid_payload(
            chainId=SOLANA_MAINNET,
            type="ed25519",
            address=encode_base58(bytes([1] * 32)),
            signature=encode_base58(bytes([0] * 32)),
        )
        result = await verify_siwx_signature(payload)
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_malformed_signature"
        assert "Invalid signature length" in (result.invalid_message or "")

    @pytest.mark.asyncio
    async def test_evm_verifier_false_returns_signature_code(self):
        account = Account.create()
        challenge = _test_challenge(
            domain="api.example.com",
            resource_uri="https://api.example.com/resource",
            network="eip155:8453",
        )
        ext = challenge[SIGN_IN_WITH_X]
        complete = {
            **ext["info"],
            "chainId": ext["supportedChains"][0]["chainId"],
            "type": "eip191",
        }
        payload = await create_siwx_payload(complete, account)

        async def _verifier(**_kwargs) -> bool:
            return False

        result = await verify_siwx_signature(payload, SIWxVerifyOptions(evm_verifier=_verifier))
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_signature"
        assert "Signature verification failed" in (result.invalid_message or "")

    @pytest.mark.asyncio
    async def test_evm_verifier_throw_returns_verifier_error_code(self):
        account = Account.create()
        challenge = _test_challenge(
            domain="api.example.com",
            resource_uri="https://api.example.com/resource",
            network="eip155:8453",
        )
        ext = challenge[SIGN_IN_WITH_X]
        complete = {
            **ext["info"],
            "chainId": ext["supportedChains"][0]["chainId"],
            "type": "eip191",
        }
        payload = await create_siwx_payload(complete, account)

        async def _verifier(**_kwargs) -> bool:
            raise RuntimeError("RPC error")

        result = await verify_siwx_signature(payload, SIWxVerifyOptions(evm_verifier=_verifier))
        assert result.is_valid is False
        assert result.invalid_reason == "invalid_siwx_verifier_error"
        assert "RPC error" in (result.invalid_message or "")


class TestStorage:
    def test_record_and_check(self):
        storage = InMemorySIWxStorage()
        assert storage.has_paid("/resource", "0xABC") is False
        storage.record_payment("/resource", "0xABC")
        assert storage.has_paid("/resource", "0xabc") is True


class TestSettleHook:
    @pytest.mark.asyncio
    async def test_records_payer(self):
        storage = InMemorySIWxStorage()
        hook = create_siwx_settle_hook(CreateSIWxSettleHookOptions(storage=storage))

        class _Ctx:
            class _Payload:
                class _Resource:
                    url = "http://example.com/weather"

                resource = _Resource()

            class _Result:
                success = True
                payer = "0xABC123"

            payment_payload = _Payload()
            result = _Result()

        await hook(_Ctx())
        assert storage.has_paid("/weather", "0xABC123")


class TestRequestHook:
    @pytest.mark.asyncio
    async def test_no_header(self):
        storage = InMemorySIWxStorage()
        hook = create_siwx_request_hook(
            CreateSIWxRequestHookOptions(storage=storage, origin=EXAMPLE_ORIGIN)
        )

        class _Adapter:
            def get_header(self, _name: str) -> str | None:
                return None

            def get_url(self) -> str:
                return "http://example.com/test"

        ctx = HTTPRequestContext(adapter=_Adapter(), method="GET", path="/test")
        assert await hook(ctx) is None

    @pytest.mark.asyncio
    async def test_auth_only_grants_without_payment(self):
        storage = InMemorySIWxStorage()
        account = Account.create()
        challenge = _test_challenge(
            domain="example.com",
            resource_uri="http://example.com/profile",
            network="eip155:8453",
        )
        ext = challenge[SIGN_IN_WITH_X]
        complete = {
            **ext["info"],
            "chainId": ext["supportedChains"][0]["chainId"],
            "type": "eip191",
        }
        header = encode_siwx_header(await create_siwx_payload(complete, account))
        hook = create_siwx_request_hook(
            CreateSIWxRequestHookOptions(storage=storage, origin=EXAMPLE_ORIGIN)
        )

        class _Adapter:
            def get_header(self, name: str) -> str | None:
                if name in (SIGN_IN_WITH_X, SIGN_IN_WITH_X.lower()):
                    return header
                return None

            def get_url(self) -> str:
                return "http://example.com/profile"

        ctx = HTTPRequestContext(adapter=_Adapter(), method="GET", path="/profile")
        route = RouteConfig(accepts=[])
        result = await hook(ctx, route)
        assert isinstance(result, GrantAccessResult)


class TestRequestHookOriginBinding:
    @pytest.mark.asyncio
    async def test_rejects_proof_for_wrong_origin_despite_matching_request_url(self):
        storage = InMemorySIWxStorage()
        account = Account.create()
        storage.record_payment("/resource", account.address)

        challenge = _test_challenge(
            domain="malicious-dapp.example",
            resource_uri="https://malicious-dapp.example/resource",
            network="eip155:8453",
        )
        ext = challenge[SIGN_IN_WITH_X]
        complete = {
            **ext["info"],
            "chainId": ext["supportedChains"][0]["chainId"],
            "type": "eip191",
        }
        header = encode_siwx_header(await create_siwx_payload(complete, account))
        hook = create_siwx_request_hook(
            CreateSIWxRequestHookOptions(storage=storage, origin=API_ORIGIN)
        )

        class _Adapter:
            def get_header(self, name: str) -> str | None:
                if name in (SIGN_IN_WITH_X, SIGN_IN_WITH_X.lower()):
                    return header
                return None

            def get_url(self) -> str:
                return "https://malicious-dapp.example/resource"

        ctx = HTTPRequestContext(adapter=_Adapter(), method="GET", path="/resource")
        route = RouteConfig(
            accepts=PaymentOption(
                scheme="exact",
                price="$0.001",
                network="eip155:8453",
                pay_to="0x0",
            )
        )
        assert await hook(ctx, route) is None

    def test_rejects_invalid_origin_at_construction(self):
        storage = InMemorySIWxStorage()
        with pytest.raises(ValueError, match="must not include a path"):
            create_siwx_request_hook(
                CreateSIWxRequestHookOptions(
                    storage=storage, origin="https://api.example.com/profile"
                )
            )
        with pytest.raises(ValueError, match="not a valid URL"):
            create_siwx_resource_server_extension(
                CreateSIWxHookOptions(storage=storage, origin="not-a-url")
            )
        with pytest.raises(ValueError, match="must use http: or https:"):
            create_siwx_resource_server_extension(
                CreateSIWxHookOptions(storage=storage, origin="ftp://api.example.com")
            )


class TestClientHook:
    @pytest.mark.asyncio
    async def test_returns_headers(self):
        account = Account.create()
        hook = create_siwx_client_hook(account)
        challenge = _test_challenge(
            domain="example.com",
            resource_uri="http://example.com/resource",
            network="eip155:1",
        )
        ctx = PaymentRequiredContext(
            payment_required=PaymentRequired(
                x402_version=2,
                accepts=[
                    PaymentRequirements(
                        scheme="exact",
                        network="eip155:1",
                        asset="0xusdc",
                        amount="1000",
                        pay_to="0xpay",
                        max_timeout_seconds=300,
                    )
                ],
                extensions=challenge,
            )
        )
        result = await hook(ctx)
        assert isinstance(result, PaymentRequiredHeadersResult)
        assert SIGN_IN_WITH_X in result.headers

    @pytest.mark.asyncio
    async def test_keypair_signer_returns_headers(self):
        pytest.importorskip("solders")
        from solders.keypair import Keypair

        from x402.mechanisms.svm.signers import KeypairSigner

        signer = KeypairSigner(Keypair())
        hook = create_siwx_client_hook(signer)
        challenge = _test_challenge(
            domain="example.com",
            resource_uri="http://example.com/profile",
            network=SOLANA_DEVNET,
        )
        ctx = PaymentRequiredContext(
            payment_required=PaymentRequired(
                x402_version=2,
                accepts=[],
                extensions=challenge,
            )
        )
        result = await hook(ctx)
        assert isinstance(result, PaymentRequiredHeadersResult)
        assert SIGN_IN_WITH_X in result.headers


class TestServerExtension:
    @pytest.mark.asyncio
    async def test_enrichment_fresh_nonce(self):
        storage = InMemorySIWxStorage()
        ext = create_siwx_resource_server_extension(
            CreateSIWxHookOptions(storage=storage, origin=API_ORIGIN)
        )
        declaration = declare_siwx_extension(DeclareSIWxOptions(expiration_seconds=300))
        ctx = type(
            "Ctx",
            (),
            {
                "requirements": [
                    PaymentRequirements(
                        scheme="exact",
                        network="eip155:8453",
                        asset="0x",
                        amount="1",
                        pay_to="0x0",
                        max_timeout_seconds=300,
                    )
                ],
                "resource_info": ResourceInfo(url="https://api.example.com/data"),
            },
        )()
        result = await ext.enrich_payment_required_response(declaration[SIGN_IN_WITH_X], ctx)
        assert len(result["info"]["nonce"]) == 32
        assert result["supportedChains"][0]["chainId"] == "eip155:8453"
        assert result["info"]["domain"] == "api.example.com"
        assert result["info"]["uri"] == "https://api.example.com/data"

    @pytest.mark.asyncio
    async def test_uses_configured_public_origin_behind_tls_termination(self):
        storage = InMemorySIWxStorage()
        ext = create_siwx_resource_server_extension(
            CreateSIWxHookOptions(storage=storage, origin=API_ORIGIN)
        )
        declaration = declare_siwx_extension()
        ctx = type(
            "Ctx",
            (),
            {
                "requirements": [
                    PaymentRequirements(
                        scheme="exact",
                        network="eip155:8453",
                        asset="0x",
                        amount="1",
                        pay_to="0x0",
                        max_timeout_seconds=300,
                    )
                ],
                "resource_info": ResourceInfo(url="http://127.0.0.1:4021/profile"),
            },
        )()
        result = await ext.enrich_payment_required_response(declaration[SIGN_IN_WITH_X], ctx)
        assert result["info"]["domain"] == "api.example.com"
        assert result["info"]["uri"] == "https://api.example.com/profile"

    def test_declares_dynamic_info_fields(self):
        storage = InMemorySIWxStorage()
        ext = create_siwx_resource_server_extension(
            CreateSIWxHookOptions(storage=storage, origin=API_ORIGIN)
        )
        assert ext.dynamic_info_fields == ["nonce", "issuedAt", "expirationTime"]


class TestServerEchoValidation:
    """Registered SIWX extension keeps static info strict while nonce/time regenerate."""

    def _server(self):
        storage = InMemorySIWxStorage()
        ext = create_siwx_resource_server_extension(
            CreateSIWxHookOptions(storage=storage, origin=API_ORIGIN)
        )
        return x402ResourceServer().register_extension(ext)

    @staticmethod
    def _required(info: dict) -> PaymentRequired:
        return PaymentRequired(
            x402_version=2,
            accepts=[],
            extensions={SIGN_IN_WITH_X: {"info": info}},
        )

    @staticmethod
    def _payload(info: dict) -> PaymentPayload:
        return PaymentPayload(
            x402_version=2,
            payload={"authorization": {}, "signature": "0x"},
            accepted=PaymentRequirements(
                scheme="exact",
                network="eip155:8453",
                asset="0x",
                amount="1",
                pay_to="0x0",
                max_timeout_seconds=300,
            ),
            extensions={SIGN_IN_WITH_X: {"info": info}},
        )

    def test_passes_when_only_dynamic_fields_differ(self):
        server = self._server()
        required = self._required(
            {
                "domain": "api.example.com",
                "uri": "https://api.example.com/data",
                "version": "1",
                "nonce": "aaa",
                "issuedAt": "2024-01-01T00:00:00.000Z",
                "expirationTime": "2024-01-01T00:05:00.000Z",
            }
        )
        payload = self._payload(
            {
                "domain": "api.example.com",
                "uri": "https://api.example.com/data",
                "version": "1",
                "nonce": "bbb",
                "issuedAt": "2024-02-02T00:00:00.000Z",
                "expirationTime": "2024-02-02T00:05:00.000Z",
            }
        )

        assert server.validate_extensions(required, payload).valid

    def test_rejects_when_static_field_differs(self):
        server = self._server()
        required = self._required({"domain": "api.example.com", "nonce": "aaa"})
        payload = self._payload({"domain": "evil.example.com", "nonce": "bbb"})

        result = server.validate_extensions(required, payload)
        assert not result.valid
        assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
        assert result.extension_key == SIGN_IN_WITH_X

    def test_rejects_when_static_field_dropped(self):
        server = self._server()
        required = self._required(
            {"domain": "api.example.com", "uri": "https://api.example.com/data", "nonce": "aaa"}
        )
        payload = self._payload({"domain": "api.example.com", "nonce": "bbb"})

        result = server.validate_extensions(required, payload)
        assert not result.valid
        assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH

    def test_unregistered_siwx_shaped_data_stays_strict(self):
        server = x402ResourceServer()
        required = self._required({"domain": "api.example.com", "nonce": "aaa"})
        payload = self._payload({"domain": "api.example.com", "nonce": "bbb"})

        result = server.validate_extensions(required, payload)
        assert not result.valid
        assert result.invalid_reason == ERR_EXTENSION_ECHO_MISMATCH
