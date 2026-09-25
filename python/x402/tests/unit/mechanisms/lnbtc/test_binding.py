"""Published vectors and mutations of actual HTTP/MCP requests."""

import pytest

from x402.mechanisms.lnbtc import http_request_binding, mcp_request_binding

URL = "https://api.example.com/article/A"


def http(**kwargs):
    return http_request_binding("GET", URL, public_origin="https://api.example.com", **kwargs)


def mcp(params=None, **kwargs):
    return mcp_request_binding(
        "https://api.example.com/mcp", params or {"name": "get_article"}, resource_url=URL, **kwargs
    )


def test_published_http_vectors():
    assert http().digest == "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018"
    assert http_request_binding(
        "GET", URL[:-1] + "B", public_origin="https://api.example.com"
    ).digest == ("4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509")


@pytest.mark.parametrize(
    "name,arguments,digest",
    [
        (
            "get_article",
            {"article": "A"},
            "03941bfedc6af8a09b2f459fe83470284a76a8c75801caa9e1487a9276a693f4",
        ),
        (
            "get_article",
            {"article": "B"},
            "b3e425970d64cd4f08fc4d57a11b76da59ce6a5760d92687398c91f063120678",
        ),
        (
            "delete_article",
            {"article": "A"},
            "3a52bbf19dda8b5765a27246b12e805770298273b48526956c421f02fe043455",
        ),
    ],
)
def test_published_mcp_vectors(name, arguments, digest):
    assert mcp({"name": name, "arguments": arguments}).digest == digest


def test_raw_http_bytes_and_target_spelling_are_not_normalized():
    assert http(body=b'{"a":1}').digest != http(body=b'{"a": 1}').digest
    assert (
        http_request_binding("get", URL, public_origin="https://api.example.com").digest
        != http().digest
    )
    hashes = {
        http_request_binding(
            "GET", "https://api.example.com/" + path, public_origin="https://api.example.com"
        ).digest
        for path in ("%2f", "%2F", "?a=1&b=2", "?b=2&a=1")
    }
    assert len(hashes) == 4


def test_bound_header_absence_empty_and_repeated_values():
    assert (
        http(bound_headers=["cookie"]).digest
        != http(bound_headers=["cookie"], headers=[("cookie", "")]).digest
    )
    assert http(
        bound_headers=["cookie"], headers=[("Cookie", " a "), ("COOKIE", "\tb\t")]
    ).digest == (http(bound_headers=["cookie"], headers=[("cookie", "a, b")]).digest)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"bound_headers": ["Cookie"]},
        {"bound_headers": ["z", "a"]},
        {"bound_headers": ["a", "a"]},
        {"bound_headers": ["payment-signature"]},
        {"bound_headers": ["a"], "headers": [("a", "bad\r\nvalue")]},
        {"bound_headers": ["a"], "headers": [("a", "é")]},
        {"body": "parsed"},
    ],
)
def test_invalid_http_inputs_fail_closed(kwargs):
    with pytest.raises(ValueError, match="request_binding"):
        http(**kwargs)


@pytest.mark.parametrize(
    "url",
    [
        "/article/A",
        "https://user:pass@api.example.com/a",
        URL + "#fragment",
        URL + "%zz",
        "https://api.example.com/é",
        "https://evil.example/a",
    ],
)
def test_unsafe_uri_or_untrusted_origin(url):
    with pytest.raises(ValueError):
        http_request_binding("GET", url, public_origin="https://api.example.com")


def test_mcp_canonical_arguments_and_nonbinding_metadata():
    first = mcp({"name": "get_article", "arguments": {"b": 2, "a": 1}})
    retry = mcp(
        {
            "name": "get_article",
            "arguments": {"a": 1, "b": 2},
            "_meta": {"progressToken": "new", "x402/payment": {"preimage": "proof"}},
        }
    )
    assert first.digest == retry.digest
    assert mcp().digest == mcp({"name": "get_article", "arguments": {}}).digest
    assert (
        mcp(bound_metadata=["account"]).digest
        != mcp(
            {"name": "get_article", "_meta": {"account": None}}, bound_metadata=["account"]
        ).digest
    )


@pytest.mark.parametrize(
    "params,metadata",
    [
        ({"name": "get_article", "arguments": None}, []),
        ({"name": "get_article", "arguments": []}, []),
        ({"name": "get_article", "_meta": None}, []),
        ({"name": "get_article", "arguments": {"x": float("nan")}}, []),
        ({"name": "get_article", "arguments": {"x": 2**64}}, []),
        ({"name": "get_article", "arguments": {"x": "\ud800"}}, []),
        ({"name": "get_article"}, ["progressToken"]),
        ({"name": "get_article"}, ["x402/payment"]),
        ({"name": "get_article"}, ["z", "a"]),
    ],
)
def test_invalid_mcp_inputs_fail_closed(params, metadata):
    with pytest.raises(ValueError, match="request_binding"):
        mcp(params, bound_metadata=metadata)
