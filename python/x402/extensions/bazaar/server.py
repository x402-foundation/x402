"""Resource server extension for Bazaar discovery.

This module provides the bazaar_resource_server_extension which enriches
discovery extensions with HTTP method information from the request context.
"""

from __future__ import annotations

import re
from typing import Any

from .types import BAZAAR

# Compiled once at module level.
_BRACKET_PARAM_RE = re.compile(r"\[([^\]]+)\]")  # [paramName] (Next.js style)
_COLON_PARAM_RE = re.compile(r":([a-zA-Z_]\w*)")  # :paramName (Express style)

# Cache compiled capture regexes per route pattern to avoid per-request recompilation.
_pattern_cache: dict[str, tuple[re.Pattern[str], list[str]]] = {}


def _normalize_wildcard_pattern(pattern: str) -> str:
    """Convert wildcard segments to :var1, :var2, etc. for discovery normalization."""
    if "*" not in pattern:
        return pattern
    counter = 0
    segments = pattern.split("/")
    for i, seg in enumerate(segments):
        if seg == "*":
            counter += 1
            segments[i] = f":var{counter}"
    return "/".join(segments)


def _is_http_request_context(ctx: Any) -> bool:
    """Check if context is an HTTP request context.

    Args:
        ctx: The context to check.

    Returns:
        True if context has a method attribute.
    """
    return hasattr(ctx, "method") and isinstance(getattr(ctx, "method", None), str)


def _extract_dynamic_route_info(
    route_pattern: str, url_path: str
) -> tuple[str, dict[str, str]] | None:
    """Convert a parameterized route pattern to a :param template and extract concrete values.

    Supports both [param] (Next.js) and :param (Express) syntax. The output routeTemplate
    always uses :param syntax regardless of input format.

    Args:
        route_pattern: Route pattern (e.g. "/users/[userId]" or "/users/:userId")
        url_path: Concrete URL path (e.g. "/users/123")

    Returns:
        (routeTemplate, pathParams) tuple, or None if route_pattern has no param segments.
    """
    has_bracket = bool(_BRACKET_PARAM_RE.search(route_pattern))
    has_colon = bool(_COLON_PARAM_RE.search(route_pattern))
    if not has_bracket and not has_colon:
        return None
    # When both [param] and :param are present, normalize brackets to colons first
    # so all params are extracted uniformly.
    normalized = _BRACKET_PARAM_RE.sub(r":\1", route_pattern) if has_bracket else route_pattern
    path_params = _extract_path_params(normalized, url_path, is_bracket=False)
    return normalized, path_params


def _get_or_compile_pattern(
    route_pattern: str, *, is_bracket: bool
) -> tuple[re.Pattern[str], list[str]]:
    """Return a cached (regex, param_names) pair for the route pattern, compiling on first access."""
    if route_pattern in _pattern_cache:
        return _pattern_cache[route_pattern]

    split_re = _BRACKET_PARAM_RE if is_bracket else _COLON_PARAM_RE
    parts = split_re.split(route_pattern)
    regex_parts: list[str] = []
    param_names: list[str] = []
    for i, part in enumerate(parts):
        if i % 2 == 0:
            regex_parts.append(re.escape(part))
        else:
            param_names.append(part)
            regex_parts.append("([^/]+)")

    compiled = re.compile("^" + "".join(regex_parts) + "$")
    _pattern_cache[route_pattern] = (compiled, param_names)
    return compiled, param_names


def _extract_path_params(route_pattern: str, url_path: str, *, is_bracket: bool) -> dict[str, str]:
    """Extract concrete path parameter values by matching a URL path against a route pattern.

    Args:
        route_pattern: Route pattern with [paramName] or :paramName segments
        url_path: Concrete URL path (e.g. "/users/123")
        is_bracket: True if pattern uses [param] syntax, False for :param

    Returns:
        Dict mapping param names to their concrete values.
    """
    compiled, param_names = _get_or_compile_pattern(route_pattern, is_bracket=is_bracket)
    match = compiled.match(url_path)
    if not match:
        return {}

    return {name: match.group(i + 1) for i, name in enumerate(param_names)}


class BazaarResourceServerExtension:
    """Resource server extension that enriches discovery extensions with HTTP method.

    This extension automatically injects the HTTP method from the request context
    into the discovery extension info and schema.

    Usage:
        ```python
        from x402 import x402ResourceServer
        from x402.extensions.bazaar import bazaar_resource_server_extension

        server = x402ResourceServer(facilitator_client)
        server.register_extension(bazaar_resource_server_extension)
        ```
    """

    @property
    def key(self) -> str:
        """Extension key."""
        return BAZAAR.key

    def enrich_declaration(
        self,
        declaration: Any,
        transport_context: Any,
    ) -> Any:
        """Enrich extension declaration with HTTP method from transport context.

        Args:
            declaration: The extension declaration to enrich.
            transport_context: Framework-specific context (e.g., HTTP request).

        Returns:
            Enriched declaration with HTTP method added.
        """
        if not _is_http_request_context(transport_context):
            return declaration

        method = transport_context.method

        # Handle both dict and Pydantic model
        if hasattr(declaration, "model_dump"):
            ext = declaration.model_dump(by_alias=True)
        elif isinstance(declaration, dict):
            ext = dict(declaration)
        else:
            return declaration

        # Get or create info section
        info = ext.get("info", {})
        if not isinstance(info, dict):
            if hasattr(info, "model_dump"):
                info = info.model_dump(by_alias=True)
            else:
                info = {}

        # Get or create input section
        input_data = info.get("input", {})
        if not isinstance(input_data, dict):
            if hasattr(input_data, "model_dump"):
                input_data = input_data.model_dump(by_alias=True)
            else:
                input_data = {}

        # Inject method into input
        input_data["method"] = method
        info["input"] = input_data
        ext["info"] = info

        # Update schema to require method
        schema = ext.get("schema", {})
        if isinstance(schema, dict):
            properties = schema.get("properties", {})
            if isinstance(properties, dict):
                input_schema = properties.get("input", {})
                if isinstance(input_schema, dict):
                    required = list(input_schema.get("required", []))
                    if "method" not in required:
                        required.append("method")
                    input_schema["required"] = required
                    properties["input"] = input_schema
                schema["properties"] = properties
            ext["schema"] = schema

        # Check for dynamic route pattern.
        # Wildcard * segments are auto-converted to :var1, :var2, etc. for catalog normalization.
        raw_route_pattern = getattr(transport_context, "route_pattern", None)
        route_pattern = (
            _normalize_wildcard_pattern(raw_route_pattern) if raw_route_pattern else None
        )
        dynamic = (
            _extract_dynamic_route_info(route_pattern, transport_context.adapter.get_path())
            if route_pattern
            else None
        )
        if dynamic is not None:
            route_template, path_params = dynamic
            input_data = ext.get("info", {}).get("input", {})
            if isinstance(input_data, dict):
                input_data["pathParams"] = path_params
            info = ext.get("info", {})
            if isinstance(info, dict):
                info["input"] = input_data
            ext["info"] = info
            ext["routeTemplate"] = route_template

            # Ensure pathParams is allowed in the schema (additionalProperties: false would reject it)
            schema = ext.get("schema", {})
            if isinstance(schema, dict):
                props = schema.get("properties", {})
                if isinstance(props, dict):
                    input_schema = props.get("input", {})
                    if isinstance(input_schema, dict):
                        input_props = input_schema.get("properties", {})
                        if isinstance(input_props, dict) and "pathParams" not in input_props:
                            input_props["pathParams"] = {"type": "object"}

        return ext


# Singleton instance for convenience
bazaar_resource_server_extension = BazaarResourceServerExtension()
