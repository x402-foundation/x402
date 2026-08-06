"""Tests for paywall handlers and faucet URL plumbing."""

from __future__ import annotations

from x402.http.paywall import (
    EvmPaywallHandler,
    PaywallBuilder,
    SvmPaywallHandler,
)
from x402.schemas import (
    PaymentRequired,
    PaymentRequirements,
    ResourceInfo,
)


def _make_evm_payment_required() -> PaymentRequired:
    return PaymentRequired(
        x402_version=2,
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="eip155:84532",
                asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                amount="1000000",
                pay_to="0x209693Bc6afc0C5328bA36FaF04C514EF312287C",
                max_timeout_seconds=60,
            )
        ],
        resource=ResourceInfo(url="https://example.com/api/data"),
    )


def _make_svm_payment_required() -> PaymentRequired:
    return PaymentRequired(
        x402_version=2,
        accepts=[
            PaymentRequirements(
                scheme="exact",
                network="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                asset="4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                amount="1000000",
                pay_to="2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHEBg4",
                max_timeout_seconds=60,
            )
        ],
        resource=ResourceInfo(url="https://example.com/api/data"),
    )


# --- EvmPaywallHandler ---


def _build_evm_provider(**config_kwargs):  # type: ignore[no-untyped-def]
    return PaywallBuilder().with_network(EvmPaywallHandler()).with_config(**config_kwargs).build()


def _build_svm_provider(**config_kwargs):  # type: ignore[no-untyped-def]
    return PaywallBuilder().with_network(SvmPaywallHandler()).with_config(**config_kwargs).build()


def test_evm_handler_injects_faucet_urls() -> None:
    urls = {
        "eip155:84532": "https://example.com/base-faucet",
        "eip155:421614": "https://example.com/arb-faucet",
    }
    provider = _build_evm_provider(testnet=True, faucet_urls=urls)
    html = provider.generate_html(_make_evm_payment_required())
    assert '"faucetUrls"' in html
    assert "https://example.com/base-faucet" in html
    assert "https://example.com/arb-faucet" in html


def test_evm_handler_omits_faucet_urls_when_unset() -> None:
    """When faucet_urls is unset, the injected config script omits the key.

    The paywall renders 'No faucet configured.' when neither the curated map
    nor a server override has an entry for the chain. The bundled template
    may still mention `faucetUrls` as a property access in compiled JS — that
    test only inspects the injected config object.
    """
    provider = _build_evm_provider(testnet=True)
    html = provider.generate_html(_make_evm_payment_required())
    # Find the config script block and check it doesn't declare faucetUrls.
    config_start = html.find("window.x402 = ")
    assert config_start != -1
    config_end = html.find(";", config_start)
    snippet = html[config_start:config_end]
    assert '"faucetUrls"' not in snippet, (
        f"unexpected faucetUrls in injected config: {snippet[:500]}"
    )


# --- SvmPaywallHandler ---


def test_svm_handler_injects_faucet_urls() -> None:
    urls = {"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "https://example.com/devnet-faucet"}
    provider = _build_svm_provider(testnet=True, faucet_urls=urls)
    html = provider.generate_html(_make_svm_payment_required())
    assert '"faucetUrls"' in html
    assert "https://example.com/devnet-faucet" in html


# --- PaywallBuilder ---


def test_builder_accepts_faucet_urls() -> None:
    urls = {"eip155:84532": "https://example.com/per-chain"}
    provider = (
        PaywallBuilder().with_network(EvmPaywallHandler()).with_config(faucet_urls=urls).build()
    )
    assert provider.faucet_urls == urls


def test_builder_passes_faucet_urls_through_to_handler() -> None:
    urls = {"eip155:84532": "https://example.com/per-chain"}
    provider = (
        PaywallBuilder().with_network(EvmPaywallHandler()).with_config(faucet_urls=urls).build()
    )
    html = provider.generate_html(_make_evm_payment_required())
    assert "https://example.com/per-chain" in html


def test_provider_runtime_faucet_urls_override_builder_faucet_urls() -> None:
    from x402.http.types import PaywallConfig

    builder_urls = {"eip155:84532": "https://example.com/builder"}
    runtime_urls = {"eip155:84532": "https://example.com/runtime"}
    provider = (
        PaywallBuilder()
        .with_network(EvmPaywallHandler())
        .with_config(faucet_urls=builder_urls)
        .build()
    )
    html = provider.generate_html(
        _make_evm_payment_required(),
        config=PaywallConfig(faucet_urls=runtime_urls),
    )
    assert "https://example.com/runtime" in html
    assert "https://example.com/builder" not in html
