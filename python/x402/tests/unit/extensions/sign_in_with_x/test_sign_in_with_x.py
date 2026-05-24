"""Tests for Sign-In-With-X extension."""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from eth_account import Account

from x402.extensions.sign_in_with_x import (
    SIGN_IN_WITH_X,
    SOLANA_DEVNET,
    SOLANA_MAINNET,
    CreateSIWxHookOptions,
    DeclareSIWxOptions,
    InMemorySIWxStorage,
    SIWxPayload,
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
    parse_siwx_header,
    validate_siwx_message,
    verify_siwx_signature,
)
from x402.http.types import HTTPRequestContext, RouteConfig
from x402.schemas import PaymentRequired, PaymentRequirements, ResourceInfo
from x402.schemas.hooks import (
    GrantAccessResult,
    PaymentRequiredContext,
    PaymentRequiredHeadersResult,
)

pytest.importorskip("siwe")
pytest.importorskip("nacl")


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
                domain="api.example.com",
                resource_uri="https://api.example.com/data",
                network="eip155:8453",
                statement="Sign in to access",
                expiration_seconds=300,
            )
        )
        ext = result[SIGN_IN_WITH_X]
        assert ext["info"]["domain"] == "api.example.com"
        assert ext["info"].get("nonce") is None
        assert ext["supportedChains"][0]["chainId"] == "eip155:8453"
        assert ext["_options"].expiration_seconds == 300


class TestValidate:
    @pytest.mark.asyncio
    async def test_valid_message(self):
        payload = _valid_payload()
        result = await validate_siwx_message(payload, "https://api.example.com/data")
        assert result.valid is True

    @pytest.mark.asyncio
    async def test_domain_mismatch(self):
        result = await validate_siwx_message(_valid_payload(), "https://different.example.com/data")
        assert result.valid is False
        assert "Domain mismatch" in (result.error or "")


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
        assert (await validate_siwx_message(parsed, "https://api.example.com/resource")).valid
        verification = await verify_siwx_signature(parsed)
        assert verification.valid
        assert verification.address.lower() == account.address.lower()


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
        assert result.valid
        assert result.address == address

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
        assert result.valid
        assert result.address == signer.address


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
        hook = create_siwx_settle_hook(CreateSIWxHookOptions(storage=storage))

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
        hook = create_siwx_request_hook(CreateSIWxHookOptions(storage=storage))

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
        hook = create_siwx_request_hook(CreateSIWxHookOptions(storage=storage))

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
        ext = create_siwx_resource_server_extension(CreateSIWxHookOptions(storage=storage))
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
