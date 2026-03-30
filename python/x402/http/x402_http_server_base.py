"""x402HTTPResourceServer base classes and internal types.

Contains shared logic for HTTP server implementations.
"""

from __future__ import annotations

import dataclasses
import html
import logging
import re
from collections.abc import Generator
from typing import TYPE_CHECKING, Any, Literal, Protocol
from urllib.parse import unquote

from ..schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
)
from ..schemas.errors import SettleError
from ..schemas.v1 import PaymentPayloadV1
from .constants import (
    PAYMENT_REQUIRED_HEADER,
    PAYMENT_RESPONSE_HEADER,
    PAYMENT_SIGNATURE_HEADER,
)
from .types import (
    RESULT_NO_PAYMENT_REQUIRED,
    RESULT_PAYMENT_ERROR,
    RESULT_PAYMENT_VERIFIED,
    CompiledRoute,
    HTTPAdapter,
    HTTPProcessResult,
    HTTPRequestContext,
    HTTPResponseInstructions,
    PaymentOption,
    PaywallConfig,
    ProcessSettleResult,
    RouteConfig,
    RouteConfigurationError,
    RoutesConfig,
    RouteValidationError,
)
from .utils import (
    decode_payment_signature_header,
    encode_payment_required_header,
    encode_payment_response_header,
    htmlsafe_json_dumps,
)

if TYPE_CHECKING:
    from ..server import x402ResourceServer, x402ResourceServerSync

logger = logging.getLogger("x402")

# ============================================================================
# Paywall Provider Protocol
# ============================================================================


class PaywallProvider(Protocol):
    """Protocol for custom paywall HTML generation."""

    def generate_html(
        self,
        payment_required: PaymentRequired,
        config: PaywallConfig | None = None,
    ) -> str:
        """Generate HTML for the paywall.

        Args:
            payment_required: Payment requirements.
            config: Optional paywall configuration.

        Returns:
            HTML string.
        """
        ...


# ============================================================================
# Generator Types
# ============================================================================

# Phase for generator yields
ProcessPhase = Literal["resolve_options", "verify_payment", "build_requirements"]
ProcessCommand = tuple[ProcessPhase, Any, Any]  # (phase, target, context)


# ============================================================================
# Base HTTP Server Class (Shared Logic)
# ============================================================================


class x402HTTPServerBase:
    """Base class with shared logic for x402 HTTP servers.

    Contains route matching, payment extraction, paywall generation,
    and generator-based request processing logic.
    """

    def __init__(
        self,
        server: x402ResourceServer | x402ResourceServerSync,
        routes: RoutesConfig,
    ) -> None:
        """Create HTTP resource server.

        Args:
            server: Core x402ResourceServer instance.
            routes: Route configuration for payment-protected endpoints.
        """
        self._server = server
        self._routes_config = routes
        self._compiled_routes: list[CompiledRoute] = []
        self._paywall_provider: PaywallProvider | None = None

        # Compile routes
        self._compile_routes(routes)

    def _compile_routes(self, routes: RoutesConfig) -> None:
        """Compile route patterns to regex for matching."""
        normalized: dict[str, RouteConfig] = {}

        if isinstance(routes, RouteConfig):
            # Single RouteConfig instance - apply to all paths
            normalized = {"*": routes}
        elif isinstance(routes, dict):
            # Check if it's a single route config dict (has "accepts" key)
            # or a dict of path -> config
            if "accepts" in routes:
                # Single route config dict - apply to all paths
                normalized = {"*": self._parse_route_config(routes)}  # type: ignore
            else:
                # Dict of path -> config
                for pattern, config in routes.items():
                    if isinstance(config, RouteConfig):
                        normalized[pattern] = config
                    elif isinstance(config, dict):
                        normalized[pattern] = self._parse_route_config(config)
                    else:
                        raise ValueError(f"Invalid route config for pattern {pattern}")

        for pattern, config in normalized.items():
            verb, path, regex = self._parse_route_pattern(pattern)
            self._compiled_routes.append(
                CompiledRoute(verb=verb, regex=regex, config=config, pattern=path)
            )

    def _parse_route_config(self, config: dict[str, Any]) -> RouteConfig:
        """Parse a raw dict into a RouteConfig."""
        accepts = config.get("accepts", [])

        # Handle single accepts dict vs list
        if isinstance(accepts, dict):
            accepts = [accepts]

        # Convert to PaymentOption objects
        payment_options = []
        for acc in accepts:
            if isinstance(acc, PaymentOption):
                payment_options.append(acc)
            else:
                payment_options.append(
                    PaymentOption(
                        scheme=acc.get("scheme", ""),
                        pay_to=acc.get("payTo", acc.get("pay_to", "")),
                        price=acc.get("price", ""),
                        network=acc.get("network", ""),
                        max_timeout_seconds=acc.get(
                            "maxTimeoutSeconds", acc.get("max_timeout_seconds")
                        ),
                        extra=acc.get("extra"),
                    )
                )

        return RouteConfig(
            accepts=payment_options,
            resource=config.get("resource"),
            description=config.get("description"),
            mime_type=config.get("mimeType", config.get("mime_type")),
            custom_paywall_html=config.get("customPaywallHtml", config.get("custom_paywall_html")),
            unpaid_response_body=config.get(
                "unpaidResponseBody", config.get("unpaid_response_body")
            ),
            settlement_failed_response_body=config.get(
                "settlementFailedResponseBody",
                config.get("settlement_failed_response_body"),
            ),
            extensions=config.get("extensions"),
            hook_timeout_seconds=config.get("hook_timeout_seconds"),
        )

    # =========================================================================
    # Initialization
    # =========================================================================

    def initialize(self) -> None:
        """Initialize the HTTP resource server.

        Initializes underlying resource server (fetches facilitator support)
        and validates route configuration.

        Raises:
            RouteConfigurationError: If any route's payment options don't have
                corresponding registered schemes or facilitator support.
        """
        # Initialize underlying server
        self._server.initialize()

        # Validate routes
        errors = self._validate_route_configuration()
        if errors:
            raise RouteConfigurationError(errors)

    def register_paywall_provider(self, provider: PaywallProvider) -> x402HTTPServerBase:
        """Register custom paywall provider for HTML generation.

        Args:
            provider: PaywallProvider instance.

        Returns:
            Self for chaining.
        """
        self._paywall_provider = provider
        return self

    # =========================================================================
    # Route Matching
    # =========================================================================

    def requires_payment(self, context: HTTPRequestContext) -> bool:
        """Check if a request requires payment.

        Args:
            context: HTTP request context.

        Returns:
            True if route requires payment.
        """
        method = context.method or context.adapter.get_method()
        # _get_route_config returns tuple[RouteConfig, str] | None; 'is not None' is the
        # correct check for a union-with-None return type and does not rely on tuple truthiness.
        return self._get_route_config(context.path, method) is not None

    def _get_route_config(self, path: str, method: str) -> tuple[RouteConfig, str] | None:
        """Find matching route configuration, returning (config, pattern) or None."""
        normalized_path = self._normalize_path(path)
        upper_method = method.upper()

        for route in self._compiled_routes:
            if route.regex.match(normalized_path):
                if route.verb == "*" or route.verb == upper_method:
                    return route.config, route.pattern

        return None

    # =========================================================================
    # Core Request Processing Generator
    # =========================================================================

    def _process_request_core(
        self,
        context: HTTPRequestContext,
        paywall_config: PaywallConfig | None,
    ) -> Generator[ProcessCommand, Any, HTTPProcessResult]:
        """Core request processing logic as generator.

        Yields commands for async/sync operations:
        - ("resolve_options", route_config, context): Resolve dynamic values
        - ("verify_payment", (payload, requirements), None): Verify payment

        Returns HTTPProcessResult.
        """
        if not context.method:
            context = dataclasses.replace(context, method=context.adapter.get_method())

        # Find matching route
        route_match = self._get_route_config(context.path, context.method)
        if route_match is None:
            return HTTPProcessResult(type=RESULT_NO_PAYMENT_REQUIRED)
        route_config, route_pattern = route_match
        context = dataclasses.replace(context, route_pattern=route_pattern)

        # Extract payment from headers
        payment_payload = self._extract_payment(context.adapter)

        # Build resource info (Static metadata as per maintainer feedback)
        resource_info = ResourceInfo(
            url=route_config.resource or context.adapter.get_url(),
            description=route_config.description or "",
            mime_type=route_config.mime_type or "",
        )

        # Yield for option resolution (handles async/sync dynamic values)
        try:
            requirements: list[PaymentRequirements] = yield (
                "resolve_options",
                route_config,
                context,
            )
        except TimeoutError:
            return HTTPProcessResult(
                type=RESULT_PAYMENT_ERROR,
                response=HTTPResponseInstructions(
                    status=500,
                    headers={},
                    body={"error": "Hook execution timed out"},
                ),
            )
        except Exception:
            return HTTPProcessResult(
                type=RESULT_PAYMENT_ERROR,
                response=HTTPResponseInstructions(
                    status=500,
                    headers={},
                    body={"error": "Failed to process request"},
                ),
            )

        # Enrich extensions if present
        extensions = route_config.extensions
        if extensions:
            extensions = self._server.enrich_extensions(extensions, context)

        # Create PaymentRequired response
        payment_required = self._server.create_payment_required_response(
            requirements,
            resource_info,
            None if payment_payload else "Payment required",
            extensions,
        )

        # No payment provided
        if payment_payload is None:
            unpaid_body = None
            if route_config.unpaid_response_body:
                unpaid_body = route_config.unpaid_response_body(context)

            return HTTPProcessResult(
                type=RESULT_PAYMENT_ERROR,
                response=self._create_http_response(
                    payment_required,
                    is_web_browser=self._is_web_browser(context.adapter),
                    paywall_config=paywall_config,
                    custom_html=route_config.custom_paywall_html,
                    unpaid_response=unpaid_body,
                ),
            )

        # Find matching requirements
        matching_reqs = self._server.find_matching_requirements(
            payment_required.accepts,
            payment_payload,
        )

        if matching_reqs is None:
            return HTTPProcessResult(
                type=RESULT_PAYMENT_ERROR,
                response=self._create_http_response(
                    self._server.create_payment_required_response(
                        requirements,
                        resource_info,
                        "No matching payment requirements",
                        extensions,
                    ),
                    is_web_browser=False,
                    paywall_config=paywall_config,
                ),
            )

        # Verify payment (yield for async/sync handling)
        try:
            verify_result = yield (
                "verify_payment",
                (payment_payload, matching_reqs),
                None,
            )

            if not verify_result.is_valid:
                return HTTPProcessResult(
                    type=RESULT_PAYMENT_ERROR,
                    response=self._create_http_response(
                        self._server.create_payment_required_response(
                            requirements,
                            resource_info,
                            verify_result.invalid_reason,
                            extensions,
                        ),
                        is_web_browser=False,
                        paywall_config=paywall_config,
                    ),
                )

            # Payment valid
            return HTTPProcessResult(
                type=RESULT_PAYMENT_VERIFIED,
                payment_payload=payment_payload,
                payment_requirements=matching_reqs,
            )

        except Exception as e:
            return HTTPProcessResult(
                type=RESULT_PAYMENT_ERROR,
                response=self._create_http_response(
                    self._server.create_payment_required_response(
                        requirements,
                        resource_info,
                        str(e),
                        extensions,
                    ),
                    is_web_browser=False,
                    paywall_config=paywall_config,
                ),
            )

    # =========================================================================
    # Settlement
    # =========================================================================

    def process_settlement(
        self,
        payment_payload: PaymentPayload | PaymentPayloadV1,
        requirements: PaymentRequirements,
        context: HTTPRequestContext | None = None,
    ) -> ProcessSettleResult:
        """Process settlement after successful response.

        Call this after the protected resource has been served.

        Args:
            payment_payload: The verified payment payload.
            requirements: The matching payment requirements.
            context: Optional HTTP request context for route config lookup and hooks.

        Returns:
            ProcessSettleResult with headers if success, or response if failure.
        """
        try:
            settle_response = self._server.settle_payment(
                payment_payload,
                requirements,
            )

            if not settle_response.success:
                failure = ProcessSettleResult(
                    success=False,
                    error_reason=settle_response.error_reason or "Settlement failed",
                    headers=self._create_settlement_headers(settle_response, requirements),
                    transaction=settle_response.transaction,
                    network=settle_response.network,
                    payer=settle_response.payer,
                )
                failure.response = self._build_settlement_failure_response(failure, context)
                return failure

            return ProcessSettleResult(
                success=True,
                headers=self._create_settlement_headers(settle_response, requirements),
                transaction=settle_response.transaction,
                network=settle_response.network,
                payer=settle_response.payer,
            )

        except SettleError as e:
            settle_response = SettleResponse(
                success=False,
                error_reason=e.error_reason,
                error_message=e.error_message or e.error_reason,
                transaction=e.transaction or "",
                network=requirements.network,
                payer=e.payer,
            )
            failure = ProcessSettleResult(
                success=False,
                error_reason=e.error_reason,
                headers=self._create_settlement_headers(settle_response, requirements),
                transaction=settle_response.transaction,
                network=settle_response.network,
                payer=settle_response.payer,
            )
            failure.response = self._build_settlement_failure_response(failure, context)
            return failure

        except Exception as e:
            settle_response = SettleResponse(
                success=False,
                error_reason=str(e),
                error_message=str(e),
                transaction="",
                network=requirements.network,
            )
            failure = ProcessSettleResult(
                success=False,
                error_reason=str(e),
                headers=self._create_settlement_headers(settle_response, requirements),
                transaction="",
                network=requirements.network,
            )
            failure.response = self._build_settlement_failure_response(failure, context)
            return failure

    # =========================================================================
    # Internal Methods
    # =========================================================================

    def _extract_payment(self, adapter: HTTPAdapter) -> PaymentPayload | PaymentPayloadV1 | None:
        """Extract payment from HTTP headers (V2 only)."""
        # Check V2 header (case-insensitive)
        header = adapter.get_header(PAYMENT_SIGNATURE_HEADER) or adapter.get_header(
            PAYMENT_SIGNATURE_HEADER.lower()
        )

        if header:
            try:
                return decode_payment_signature_header(header)
            except Exception:
                return None

        return None

    def _is_web_browser(self, adapter: HTTPAdapter) -> bool:
        """Check if request is from a web browser."""
        accept = adapter.get_accept_header()
        user_agent = adapter.get_user_agent()
        return "text/html" in accept and "Mozilla" in user_agent

    def _create_http_response(
        self,
        payment_required: PaymentRequired,
        is_web_browser: bool,
        paywall_config: PaywallConfig | None = None,
        custom_html: str | None = None,
        unpaid_response: Any = None,
    ) -> HTTPResponseInstructions:
        """Create HTTP response instructions."""
        if is_web_browser:
            html_content = self._generate_paywall_html(
                payment_required,
                paywall_config,
                custom_html,
            )
            return HTTPResponseInstructions(
                status=402,
                headers={"Content-Type": "text/html"},
                body=html_content,
                is_html=True,
            )

        # API response
        content_type = "application/json"
        body: Any = {}

        if unpaid_response:
            content_type = unpaid_response.content_type
            body = unpaid_response.body

        return HTTPResponseInstructions(
            status=402,
            headers={
                "Content-Type": content_type,
                PAYMENT_REQUIRED_HEADER: encode_payment_required_header(payment_required),
            },
            body=body,
        )

    def _create_settlement_headers(
        self,
        settle_response: SettleResponse,
        requirements: PaymentRequirements,
    ) -> dict[str, str]:
        """Create settlement response headers."""
        return {
            PAYMENT_RESPONSE_HEADER: encode_payment_response_header(settle_response),
        }

    def _build_settlement_failure_response(
        self,
        failure: ProcessSettleResult,
        context: HTTPRequestContext | None,
    ) -> HTTPResponseInstructions:
        """Build HTTPResponseInstructions for settlement failure.

        Uses settlement_failed_response_body hook if configured, otherwise defaults to empty body.
        Merges settlement headers (including PAYMENT-RESPONSE) into the response.
        """
        settlement_headers = failure.headers
        if context and not context.method:
            context = dataclasses.replace(context, method=context.adapter.get_method())
        route_match = self._get_route_config(context.path, context.method) if context else None
        route_config = route_match[0] if route_match else None

        custom_body = None
        if route_config and route_config.settlement_failed_response_body:
            custom_body = route_config.settlement_failed_response_body(context, failure)

        content_type = custom_body.content_type if custom_body else "application/json"
        body = custom_body.body if custom_body else {}

        return HTTPResponseInstructions(
            status=402,
            headers={
                "Content-Type": content_type,
                **settlement_headers,
            },
            body=body,
            is_html=content_type.startswith("text/html"),
        )

    def _validate_route_configuration(self) -> list[RouteValidationError]:
        """Validate all payment options have registered schemes."""
        errors: list[RouteValidationError] = []

        for route in self._compiled_routes:
            pattern = f"{route.verb} {route.regex.pattern}"

            # Warn if wildcard routes are used with discovery extensions
            if (
                "*" in route.pattern
                and route.config.extensions
                and "bazaar" in route.config.extensions
            ):
                logger.warning(
                    'Route "%s %s": Wildcard (*) patterns with bazaar discovery extensions '
                    "will auto-generate parameter names (var1, var2, ...). "
                    "Consider using named parameters instead (e.g. /weather/:city) "
                    "for better discovery metadata.",
                    route.verb,
                    route.pattern,
                )

            # Get options as list
            options = route.config.accepts
            if isinstance(options, PaymentOption):
                options = [options]

            for option in options:
                # Check scheme registered
                if not self._server.has_registered_scheme(option.network, option.scheme):
                    errors.append(
                        RouteValidationError(
                            route_pattern=pattern,
                            scheme=option.scheme,
                            network=option.network,
                            reason="missing_scheme",
                            message=f'Route "{pattern}": No scheme for "{option.scheme}" on "{option.network}"',
                        )
                    )
                    continue

                # Check facilitator support
                supported_kind = self._server.get_supported_kind(2, option.network, option.scheme)
                if not supported_kind:
                    errors.append(
                        RouteValidationError(
                            route_pattern=pattern,
                            scheme=option.scheme,
                            network=option.network,
                            reason="missing_facilitator",
                            message=f'Route "{pattern}": Facilitator doesn\'t support "{option.scheme}" on "{option.network}"',
                        )
                    )

        return errors

    @staticmethod
    def _parse_route_pattern(pattern: str) -> tuple[str, str, re.Pattern[str]]:
        """Parse route pattern into verb, raw path, and regex."""
        parts = pattern.split(None, 1)  # Split on whitespace

        if len(parts) == 2:
            verb = parts[0].upper()
            path = parts[1]
        else:
            verb = "*"
            path = pattern

        # Convert to regex
        regex_pattern = "^" + re.escape(path)
        regex_pattern = regex_pattern.replace(r"\*", ".*?")  # Wildcards
        regex_pattern = re.sub(r"\\\[([^\]]+)\\\]", r"[^/]+", regex_pattern)  # [param]
        regex_pattern = re.sub(r":([a-zA-Z_]\w*)", r"[^/]+", regex_pattern)  # :param
        regex_pattern += "$"

        return verb, path, re.compile(regex_pattern, re.IGNORECASE)

    @staticmethod
    def _normalize_path(path: str) -> str:
        """Normalize path for matching."""
        # Remove query string and fragment
        path = path.split("?")[0].split("#")[0]

        # Decode URL encoding
        try:
            path = unquote(path)
        except Exception:
            pass

        # Normalize slashes
        path = re.sub(r"/+", "/", path)
        path = path.rstrip("/")

        return path or "/"

    def _generate_paywall_html(
        self,
        payment_required: PaymentRequired,
        config: PaywallConfig | None,
        custom_html: str | None,
    ) -> str:
        """Generate HTML paywall for browser requests."""
        if custom_html:
            return custom_html

        if self._paywall_provider:
            return self._paywall_provider.generate_html(payment_required, config)

        # Auto-select template based on network
        template = self._select_paywall_template(payment_required)
        if template:
            return self._inject_paywall_config(template, payment_required, config)

        # Fallback: Basic HTML (only if templates not available)
        return self._generate_fallback_html(payment_required, config)

    def _select_paywall_template(self, payment_required: PaymentRequired) -> str | None:
        """Select appropriate paywall template based on network.

        Returns EVM template for eip155:* networks, SVM template for solana:* networks.
        """
        # Determine network from first requirement
        network = ""
        if payment_required.accepts:
            first = payment_required.accepts[0]
            network = getattr(first, "network", "")

        # Try to load appropriate template
        try:
            if network.startswith("solana:"):
                from .paywall.svm_paywall_template import SVM_PAYWALL_TEMPLATE

                return SVM_PAYWALL_TEMPLATE
            else:
                from .paywall.evm_paywall_template import EVM_PAYWALL_TEMPLATE

                return EVM_PAYWALL_TEMPLATE
        except ImportError:
            return None

    def _inject_paywall_config(
        self,
        template: str,
        payment_required: PaymentRequired,
        config: PaywallConfig | None,
    ) -> str:
        """Inject configuration into paywall template (like Go)."""
        display_amount = self._get_display_amount(payment_required)
        app_name = config.app_name if config and config.app_name else ""
        app_logo = config.app_logo if config and config.app_logo else ""
        testnet = config.testnet if config else True
        current_url = config.current_url if config and config.current_url else ""

        # Use resource URL as currentUrl if not explicitly configured
        if not current_url and payment_required.resource:
            current_url = payment_required.resource.url or ""

        payment_data = payment_required.model_dump(by_alias=True, exclude_none=True)

        x402_config = {
            "paymentRequired": payment_data,
            "appName": app_name,
            "appLogo": app_logo,
            "amount": display_amount,
            "testnet": testnet,
            "displayAmount": round(display_amount, 2),
            "currentUrl": current_url,
        }
        config_script = (
            f"<script>\n    window.x402 = {htmlsafe_json_dumps(x402_config)};\n</script>"
        )

        return template.replace("</head>", config_script + "\n</head>", 1)

    def _generate_fallback_html(
        self,
        payment_required: PaymentRequired,
        config: PaywallConfig | None,
    ) -> str:
        """Generate fallback HTML when templates not available."""
        display_amount = self._get_display_amount(payment_required)
        resource_desc = ""
        if payment_required.resource:
            resource_desc = payment_required.resource.description or payment_required.resource.url

        app_logo = ""
        app_name = ""
        if config:
            if config.app_logo:
                app_logo = f'<img src="{html.escape(config.app_logo)}" alt="{html.escape(config.app_name or "")}" style="max-width: 200px;">'
            app_name = config.app_name or ""

        payment_data = payment_required.model_dump_json(by_alias=True, exclude_none=True)

        title = f"{html.escape(app_name)} - Payment Required" if app_name else "Payment Required"

        return f"""<!DOCTYPE html>
<html>
<head>
    <title>{title}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="max-width: 600px; margin: 50px auto; padding: 20px; font-family: system-ui;">
    {app_logo}
    <h1>{title}</h1>
    <p><strong>Resource:</strong> {html.escape(resource_desc)}</p>
    <p><strong>Amount:</strong> ${display_amount:.2f} USDC</p>
    <div id="payment-widget" data-requirements='{html.escape(payment_data)}'>
        <p style="padding: 1rem; background: #fef3c7;">
            Payment widget not available. Use an x402-compatible client.
        </p>
    </div>
</body>
</html>"""

    @staticmethod
    def _get_display_amount(payment_required: PaymentRequired) -> float:
        """Extract display amount from requirements."""
        if payment_required.accepts:
            first = payment_required.accepts[0]
            if hasattr(first, "amount") and first.amount:
                try:
                    return float(first.amount) / 1_000_000  # USDC 6 decimals
                except (ValueError, TypeError):
                    pass
        return 0.0
