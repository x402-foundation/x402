"""Request bindings built from actual HTTP requests or MCP tool calls."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from hashlib import sha256
from typing import Any
from urllib.parse import urlsplit

import rfc8785

from .constants import invalid

_TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
_URI = re.compile(r"[A-Za-z0-9._~:/?\[\]@!$&'()*+,;=%-]+")
_HEX = re.compile(r"[0-9a-f]{64}")


def canonical(value: Any) -> bytes:
    try:
        return rfc8785.dumps(value)
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise invalid("request_binding") from exc


def validate_uri(uri: str, *, http: bool = False) -> None:
    if not isinstance(uri, str) or not _URI.fullmatch(uri):
        raise invalid("request_binding")
    if re.search(r"%(?![0-9A-Fa-f]{2})", uri):
        raise invalid("request_binding")
    try:
        parts = urlsplit(uri)
        port = parts.port
    except ValueError as exc:
        raise invalid("request_binding") from exc
    if not parts.scheme or parts.username is not None or parts.fragment:
        raise invalid("request_binding")
    if http or parts.scheme in ("http", "https"):
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise invalid("request_binding")
        if port is not None and not 0 < port <= 65535:
            raise invalid("request_binding")


def validate_params(profile: Any, params: Any) -> None:
    if not isinstance(params, dict):
        raise invalid("request_binding")
    if profile == "http:1":
        if set(params) != {"headers"}:
            raise invalid("request_binding")
        names = params["headers"]
        if not isinstance(names, list) or any(
            not isinstance(name, str)
            or not _TOKEN.fullmatch(name)
            or name != name.lower()
            or name == "payment-signature"
            for name in names
        ):
            raise invalid("request_binding")
        if names != sorted(set(names)):
            raise invalid("request_binding")
    elif profile == "mcp:1":
        if set(params) != {"server", "metadata"}:
            raise invalid("request_binding")
        validate_uri(params["server"])
        names = params["metadata"]
        if not isinstance(names, list) or any(
            not isinstance(name, str) or not name or name in ("x402/payment", "progressToken")
            for name in names
        ):
            raise invalid("request_binding")
        canonical(names)
        if names != sorted(set(names), key=lambda name: name.encode("utf-16be")):
            raise invalid("request_binding")
    else:
        raise invalid("request_binding")


def validate_binding(extra: dict[str, Any]) -> None:
    digest = extra.get("requestHash")
    if not isinstance(digest, str) or not _HEX.fullmatch(digest):
        raise invalid("request_binding")
    validate_params(extra.get("requestBindingProfile"), extra.get("requestBindingParams"))


@dataclass(frozen=True)
class RequestBinding:
    profile: str
    params: dict[str, Any]
    digest: str
    resource_url: str

    def extra(self) -> dict[str, Any]:
        import copy

        result = {
            "requestBindingProfile": self.profile,
            "requestBindingParams": copy.deepcopy(self.params),
            "requestHash": self.digest,
        }
        validate_binding(result)
        return result

    def check(self, extra: dict[str, Any]) -> None:
        validate_binding(extra)
        if any(canonical(extra[key]) != canonical(value) for key, value in self.extra().items()):
            raise invalid("request_mismatch")


def http_request_binding(
    method: str,
    url: str,
    *,
    public_origin: str,
    body: bytes = b"",
    headers: Sequence[tuple[str, str]] = (),
    bound_headers: Sequence[str] = (),
) -> RequestBinding:
    """Hash raw content and RFC 9421 header values; reject an untrusted origin."""
    validate_uri(url, http=True)
    validate_uri(public_origin, http=True)
    target = urlsplit(url)
    origin = urlsplit(public_origin)
    if origin.path not in ("", "/") or origin.query:
        raise invalid("request_binding")
    if (target.scheme, target.netloc) != (origin.scheme, origin.netloc):
        raise invalid("request_mismatch")
    if not isinstance(method, str) or not _TOKEN.fullmatch(method) or not isinstance(body, bytes):
        raise invalid("request_binding")
    params = {"headers": list(bound_headers)}
    validate_params("http:1", params)
    selected: dict[str, list[str]] = {name: [] for name in bound_headers}
    for name, value in headers:
        if not isinstance(name, str) or not _TOKEN.fullmatch(name):
            raise invalid("request_binding")
        name = name.lower()
        if name in selected:
            if not isinstance(value, str) or any(
                (ord(char) < 32 and char != "\t") or ord(char) > 126 for char in value
            ):
                raise invalid("request_binding")
            selected[name].append(value.strip(" \t"))
    fields = []
    for name, values in selected.items():
        encoded = b"\x01" + ", ".join(values).encode("ascii") if values else b"\x00"
        fields.append({"name": name, "valueHash": sha256(encoded).hexdigest()})
    binding = {
        "domain": "x402:exact:lnbtc:bolt11:http:1",
        "method": method,
        "url": url,
        "bodyHash": sha256(body).hexdigest(),
        "headers": fields,
    }
    return RequestBinding("http:1", params, sha256(canonical(binding)).hexdigest(), url)


def mcp_request_binding(
    server: str,
    params: dict[str, Any],
    *,
    resource_url: str,
    bound_metadata: Sequence[str] = (),
) -> RequestBinding:
    """Bind an actual tools/call; server identity comes from trusted configuration."""
    profile_params = {"server": server, "metadata": list(bound_metadata)}
    validate_params("mcp:1", profile_params)
    validate_uri(resource_url)
    if not isinstance(params, dict):
        raise invalid("request_binding")
    name = params.get("name")
    arguments = params.get("arguments", {})
    metadata = params.get("_meta", {})
    if (
        not isinstance(name, str)
        or not name
        or not isinstance(arguments, dict)
        or not isinstance(metadata, dict)
    ):
        raise invalid("request_binding")
    fields = []
    for key in bound_metadata:
        value = b"\x01" + canonical(metadata[key]) if key in metadata else b"\x00"
        fields.append({"name": key, "valueHash": sha256(value).hexdigest()})
    binding = {
        "domain": "x402:exact:lnbtc:bolt11:mcp:1",
        "server": server,
        "method": "tools/call",
        "name": name,
        "arguments": arguments,
        "metadata": fields,
    }
    return RequestBinding(
        "mcp:1", profile_params, sha256(canonical(binding)).hexdigest(), resource_url
    )
