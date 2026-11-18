from flask import Flask, g
from x402.flask.middleware import PaymentMiddleware


def create_app_with_middleware(configs):
    app = Flask(__name__)

    @app.route("/protected")
    def protected():
        return {"message": "protected"}

    @app.route("/unprotected")
    def unprotected():
        return {"message": "unprotected"}

    middleware = PaymentMiddleware(app)
    for cfg in configs:
        middleware.add(**cfg)
    return app


def test_payment_required_for_protected_route():
    app = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
            }
        ]
    )
    with app.test_client() as client:
        resp = client.get("/protected")
        assert resp.status_code == 402
        assert resp.json is not None
        assert "accepts" in resp.json
        assert resp.json["error"].startswith("No X-PAYMENT header provided")


def test_unprotected_route():
    app = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
            }
        ]
    )
    with app.test_client() as client:
        resp = client.get("/unprotected")
        assert resp.status_code == 200
        assert resp.json == {"message": "unprotected"}


def test_invalid_payment_header():
    app = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
            }
        ]
    )
    with app.test_client() as client:
        resp = client.get("/protected", headers={"X-PAYMENT": "not_base64"})
        assert resp.status_code == 402
        assert resp.json is not None
        assert "Invalid payment header format" in resp.json["error"]


def test_path_pattern_matching():
    app = Flask(__name__)

    @app.route("/foo")
    def foo():
        return {"foo": True}

    @app.route("/bar/123")
    def bar():
        return {"bar": True}

    middleware = PaymentMiddleware(app)
    middleware.add(
        price="$1.00",
        pay_to_address="0x1",
        path=["/foo", "/bar/*", "regex:^/baz/\\d+$"],
        network="base-sepolia",
    )
    with app.test_client() as client:
        assert client.get("/foo").status_code == 402
        assert client.get("/bar/123").status_code == 402

        # Not protected
        @app.route("/baz/abc")
        def baz():
            return {"baz": True}

        assert client.get("/baz/abc").status_code == 200


def test_multiple_middleware_configs():
    app = Flask(__name__)

    @app.route("/a")
    def a():
        return {"a": True}

    @app.route("/b")
    def b():
        return {"b": True}

    middleware = PaymentMiddleware(app)
    middleware.add(
        price="$1.00", pay_to_address="0x1", path="/a", network="base-sepolia"
    )
    middleware.add(
        price="$2.00", pay_to_address="0x2", path="/b", network="base-sepolia"
    )
    with app.test_client() as client:
        assert client.get("/a").status_code == 402
        assert client.get("/b").status_code == 402

        # Not protected
        @app.route("/c")
        def c():
            return {"c": True}

        assert client.get("/c").status_code == 200


def test_payment_details_in_g():
    app = Flask(__name__)

    @app.route("/protected")
    def protected():
        return {
            "has_payment_details": hasattr(g, "payment_details"),
            "has_verify_response": hasattr(g, "verify_response"),
        }

    middleware = PaymentMiddleware(app)
    middleware.add(
        price="$1.00", pay_to_address="0x1", path="/protected", network="base-sepolia"
    )
    with app.test_client() as client:
        resp = client.get("/protected")
        assert resp.status_code == 402


def test_browser_request_returns_html():
    """Test that browser requests return HTML paywall instead of JSON."""
    app = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
            }
        ]
    )

    # Simulate browser request headers
    browser_headers = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    }

    with app.test_client() as client:
        resp = client.get("/protected", headers=browser_headers)
        assert resp.status_code == 402
        assert resp.content_type == "text/html; charset=utf-8"

        # Check that HTML is returned
        html_content = resp.get_data(as_text=True)
        assert "<!DOCTYPE html>" in html_content or "<html>" in html_content
        assert "window.x402" in html_content


def test_api_client_request_returns_json():
    """Test that API client requests return JSON response."""
    app = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
            }
        ]
    )

    # Simulate API client request headers
    api_headers = {
        "Accept": "application/json",
        "User-Agent": "curl/7.68.0",
    }

    with app.test_client() as client:
        resp = client.get("/protected", headers=api_headers)
        assert resp.status_code == 402
        assert resp.content_type == "application/json"
        assert resp.json is not None
        assert "accepts" in resp.json
        assert "error" in resp.json


def test_paywall_config_injection():
    """Test that paywall configuration is properly injected into HTML."""
    paywall_config = {
        "app_name": "Test Application",
        "app_logo": "https://example.com/logo.png",
    }

    app = create_app_with_middleware(
        [
            {
                "price": "$2.50",
                "pay_to_address": "0x123",
                "path": "/protected",
                "network": "base-sepolia",
                "paywall_config": paywall_config,
            }
        ]
    )

    browser_headers = {
        "Accept": "text/html",
        "User-Agent": "Mozilla/5.0 (compatible browser)",
    }

    with app.test_client() as client:
        resp = client.get("/protected", headers=browser_headers)
        assert resp.status_code == 402

        html_content = resp.get_data(as_text=True)
        assert "window.x402" in html_content
        assert '"appName": "Test Application"' in html_content
        assert '"appLogo": "https://example.com/logo.png"' in html_content
        assert '"amount": 2.5' in html_content


def test_custom_paywall_html():
    """Test that custom paywall HTML is used when provided."""
    custom_html = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Custom Paywall</title>
    </head>
    <body>
        <h1>Custom Payment Required</h1>
        <div id="custom-payment">Please pay to continue</div>
    </body>
    </html>
    """

    app = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
                "custom_paywall_html": custom_html,
            }
        ]
    )

    browser_headers = {
        "Accept": "text/html",
        "User-Agent": "Mozilla/5.0",
    }

    with app.test_client() as client:
        resp = client.get("/protected", headers=browser_headers)
        assert resp.status_code == 402

        html_content = resp.get_data(as_text=True)
        assert "Custom Payment Required" in html_content
        assert "custom-payment" in html_content
        assert "Custom Paywall" in html_content


def test_mainnet_vs_testnet_config():
    """Test that mainnet vs testnet is properly configured."""
    # Test testnet (base-sepolia)
    app_testnet = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
            }
        ]
    )

    # Test mainnet (base)
    app_mainnet = create_app_with_middleware(
        [
            {
                "price": "$1.00",
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base",
            }
        ]
    )

    browser_headers = {
        "Accept": "text/html",
        "User-Agent": "Mozilla/5.0",
    }

    with app_testnet.test_client() as client:
        resp = client.get("/protected", headers=browser_headers)
        html_content = resp.get_data(as_text=True)
        assert '"testnet": true' in html_content
        assert "console.log('Payment requirements initialized" in html_content

    with app_mainnet.test_client() as client:
        resp = client.get("/protected", headers=browser_headers)
        html_content = resp.get_data(as_text=True)
        assert '"testnet": false' in html_content
        # Should not have console.log for mainnet
        assert "console.log('Payment requirements initialized" not in html_content


def test_payment_amount_conversion():
    """Test that payment amounts are properly converted to display values."""
    app = create_app_with_middleware(
        [
            {
                "price": "$0.001",  # Small amount
                "pay_to_address": "0x1",
                "path": "/protected",
                "network": "base-sepolia",
            }
        ]
    )

    browser_headers = {
        "Accept": "text/html",
        "User-Agent": "Mozilla/5.0",
    }

    with app.test_client() as client:
        resp = client.get("/protected", headers=browser_headers)
        html_content = resp.get_data(as_text=True)
        # $0.001 should be converted to 0.001 in the display
        assert '"amount": 0.001' in html_content
