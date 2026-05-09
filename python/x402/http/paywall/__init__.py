"""x402 Paywall module for browser-based payment UI.

Provides PaywallBuilder for creating custom paywall providers with EVM and SVM support.
Templates are auto-generated from the TypeScript @x402/paywall package.

Example:
    ```python
    from x402.http.paywall import create_paywall, evm_paywall, svm_paywall

    # EVM only
    paywall = create_paywall().with_network(evm_paywall).build()

    # Multi-network
    paywall = (
        create_paywall()
        .with_network(evm_paywall)
        .with_network(svm_paywall)
        .with_config(app_name="My App", testnet=True)
        .build()
    )

    # Use with middleware
    app.add_middleware(
        PaymentMiddlewareASGI,
        routes=routes,
        server=server,
        paywall_provider=paywall,
    )
    ```
"""

from __future__ import annotations

import html
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from ..utils import htmlsafe_json_dumps

if TYPE_CHECKING:
    from ...schemas import PaymentRequired
    from ..types import PaywallConfig


# ============================================================================
# Template Loading
# ============================================================================


def _load_evm_template() -> str | None:
    """Load EVM paywall template if available."""
    try:
        from .evm_paywall_template import EVM_PAYWALL_TEMPLATE

        return EVM_PAYWALL_TEMPLATE
    except ImportError:
        return None


def _load_svm_template() -> str | None:
    """Load SVM paywall template if available."""
    try:
        from .svm_paywall_template import SVM_PAYWALL_TEMPLATE

        return SVM_PAYWALL_TEMPLATE
    except ImportError:
        return None


# ============================================================================
# Paywall Network Handler Protocol
# ============================================================================


class PaywallNetworkHandler(Protocol):
    """Protocol for network-specific paywall handlers."""

    def supports(self, requirement: dict) -> bool:
        """Check if this handler supports the given requirement.

        Args:
            requirement: Payment requirement dict with 'network' field.

        Returns:
            True if this handler can generate paywall for this network.
        """
        ...

    def generate_html(
        self,
        requirement: dict,
        payment_required: PaymentRequired,
        config: PaywallConfig | None = None,
    ) -> str:
        """Generate HTML for the paywall.

        Args:
            requirement: The specific payment requirement being used.
            payment_required: Full payment required response.
            config: Optional paywall configuration.

        Returns:
            HTML string for the paywall page.
        """
        ...


# ============================================================================
# EVM Paywall Handler
# ============================================================================


def _get_display_amount(payment_required: PaymentRequired) -> float:
    """Extract display amount from payment requirements."""
    if payment_required.accepts:
        first = payment_required.accepts[0]
        amount = getattr(first, "amount", None)
        if amount:
            try:
                return float(amount) / 1_000_000  # USDC 6 decimals
            except (ValueError, TypeError):
                pass
    return 0.0


@dataclass
class EvmPaywallHandler:
    """EVM network paywall handler."""

    def supports(self, requirement: dict) -> bool:
        """Check if requirement is for an EVM network."""
        network = requirement.get("network", "")
        return network.startswith("eip155:")

    def generate_html(
        self,
        requirement: dict,
        payment_required: PaymentRequired,
        config: PaywallConfig | None = None,
    ) -> str:
        """Generate EVM paywall HTML."""
        template = _load_evm_template()

        if not template:
            return self._fallback_html(payment_required, config)

        # Extract config values
        app_name = config.app_name if config else ""
        app_logo = config.app_logo if config else ""
        testnet = config.testnet if config else True
        current_url = config.current_url if config else ""

        amount = _get_display_amount(payment_required)
        payment_required_json = payment_required.model_dump(by_alias=True, exclude_none=True)

        x402_config = {
            "amount": amount,
            "paymentRequired": payment_required_json,
            "testnet": testnet,
            "currentUrl": current_url,
            "appName": app_name,
            "appLogo": app_logo,
        }
        config_script = f"""
  <script>
    window.x402 = {htmlsafe_json_dumps(x402_config)};
  </script>"""

        return template.replace("</head>", f"{config_script}\n</head>", 1)

    def _fallback_html(
        self,
        payment_required: PaymentRequired,
        config: PaywallConfig | None = None,
    ) -> str:
        """Generate fallback HTML when template not available."""
        amount = _get_display_amount(payment_required)
        app_name = config.app_name if config else ""
        title = f"{html.escape(app_name)} - Payment Required" if app_name else "Payment Required"

        return f"""<!DOCTYPE html>
<html>
<head>
    <title>{title}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="max-width: 600px; margin: 50px auto; padding: 20px; font-family: system-ui;">
    <h1>{title}</h1>
    <p><strong>Amount:</strong> ${amount:.2f} USDC</p>
    <p style="padding: 1rem; background: #fef3c7;">
        EVM Paywall template not found. Run 'pnpm build:paywall' in typescript/packages/http/paywall.
    </p>
</body>
</html>"""


# ============================================================================
# SVM Paywall Handler
# ============================================================================


@dataclass
class SvmPaywallHandler:
    """SVM (Solana) network paywall handler."""

    def supports(self, requirement: dict) -> bool:
        """Check if requirement is for a Solana network."""
        network = requirement.get("network", "")
        return network.startswith("solana:")

    def generate_html(
        self,
        requirement: dict,
        payment_required: PaymentRequired,
        config: PaywallConfig | None = None,
    ) -> str:
        """Generate SVM paywall HTML."""
        template = _load_svm_template()

        if not template:
            return self._fallback_html(payment_required, config)

        # Extract config values
        app_name = config.app_name if config else ""
        app_logo = config.app_logo if config else ""
        testnet = config.testnet if config else True
        current_url = config.current_url if config else ""

        amount = _get_display_amount(payment_required)
        payment_required_json = payment_required.model_dump(by_alias=True, exclude_none=True)

        x402_config = {
            "amount": amount,
            "paymentRequired": payment_required_json,
            "testnet": testnet,
            "currentUrl": current_url,
            "appName": app_name,
            "appLogo": app_logo,
        }
        config_script = f"""
  <script>
    window.x402 = {htmlsafe_json_dumps(x402_config)};
  </script>"""

        return template.replace("</head>", f"{config_script}\n</head>", 1)

    def _fallback_html(
        self,
        payment_required: PaymentRequired,
        config: PaywallConfig | None = None,
    ) -> str:
        """Generate fallback HTML when template not available."""
        amount = _get_display_amount(payment_required)
        app_name = config.app_name if config else ""
        title = f"{html.escape(app_name)} - Payment Required" if app_name else "Payment Required"

        return f"""<!DOCTYPE html>
<html>
<head>
    <title>{title}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="max-width: 600px; margin: 50px auto; padding: 20px; font-family: system-ui;">
    <h1>{title}</h1>
    <p><strong>Amount:</strong> ${amount:.2f} USDC</p>
    <p style="padding: 1rem; background: #fef3c7;">
        SVM Paywall template not found. Run 'pnpm build:paywall' in typescript/packages/http/paywall.
    </p>
</body>
</html>"""


# ============================================================================
# Pre-configured handlers
# ============================================================================

evm_paywall = EvmPaywallHandler()
svm_paywall = SvmPaywallHandler()


# ============================================================================
# Paywall Builder
# ============================================================================


@dataclass
class PaywallBuilder:
    """Builder for creating configured paywall providers."""

    _handlers: list[PaywallNetworkHandler] = field(default_factory=list)
    _app_name: str = ""
    _app_logo: str = ""
    _testnet: bool = True
    _current_url: str = ""

    def with_network(self, handler: PaywallNetworkHandler) -> PaywallBuilder:
        """Register a network-specific paywall handler.

        Args:
            handler: Network handler to register.

        Returns:
            Self for method chaining.
        """
        self._handlers.append(handler)
        return self

    def with_config(
        self,
        app_name: str = "",
        app_logo: str = "",
        testnet: bool = True,
        current_url: str = "",
    ) -> PaywallBuilder:
        """Set configuration options for the paywall.

        Args:
            app_name: Application name shown in wallet connection.
            app_logo: Application logo URL.
            testnet: Whether to use testnet (default: True).
            current_url: URL of the protected resource.

        Returns:
            Self for method chaining.
        """
        if app_name:
            self._app_name = app_name
        if app_logo:
            self._app_logo = app_logo
        self._testnet = testnet
        if current_url:
            self._current_url = current_url
        return self

    def build(self) -> PaywallProvider:
        """Build the paywall provider.

        Returns:
            A configured PaywallProvider instance.
        """
        return PaywallProvider(
            handlers=list(self._handlers),
            app_name=self._app_name,
            app_logo=self._app_logo,
            testnet=self._testnet,
            current_url=self._current_url,
        )


@dataclass
class PaywallProvider:
    """Paywall provider that generates HTML for payment pages."""

    handlers: list[PaywallNetworkHandler]
    app_name: str = ""
    app_logo: str = ""
    testnet: bool = True
    current_url: str = ""

    def generate_html(
        self,
        payment_required: PaymentRequired,
        config: PaywallConfig | None = None,
    ) -> str:
        """Generate HTML for the paywall.

        Args:
            payment_required: Payment requirements.
            config: Optional runtime paywall configuration (overrides builder config).

        Returns:
            HTML string for the paywall page.
        """
        from ..types import PaywallConfig as PaywallConfigClass

        if not self.handlers:
            raise ValueError(
                "No paywall handlers registered. Use .with_network(evm_paywall) or .with_network(svm_paywall)"
            )

        # Merge builder config with runtime config (runtime takes precedence)
        merged_config = PaywallConfigClass(
            app_name=config.app_name if config and config.app_name else self.app_name,
            app_logo=config.app_logo if config and config.app_logo else self.app_logo,
            testnet=config.testnet if config else self.testnet,
            current_url=(config.current_url if config and config.current_url else self.current_url),
        )

        # Find first handler that supports the payment requirements
        for requirement in payment_required.accepts:
            req_dict = requirement.model_dump(by_alias=True, exclude_none=True)
            for handler in self.handlers:
                if handler.supports(req_dict):
                    return handler.generate_html(req_dict, payment_required, merged_config)

        networks = ", ".join(
            req.network for req in payment_required.accepts if hasattr(req, "network")
        )
        raise ValueError(
            f"No paywall handler supports networks: {networks}. Register appropriate handlers with .with_network()"
        )


def create_paywall() -> PaywallBuilder:
    """Create a new paywall builder.

    Returns:
        A new PaywallBuilder instance.

    Example:
        ```python
        paywall = (
            create_paywall()
            .with_network(evm_paywall)
            .with_network(svm_paywall)
            .with_config(app_name="My App", testnet=True)
            .build()
        )
        ```
    """
    return PaywallBuilder()


# ============================================================================
# Public API
# ============================================================================

__all__ = [
    "create_paywall",
    "PaywallBuilder",
    "PaywallProvider",
    "PaywallNetworkHandler",
    "EvmPaywallHandler",
    "SvmPaywallHandler",
    "evm_paywall",
    "svm_paywall",
]
