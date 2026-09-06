"""Flask e2e test server using x402 v2 SDK.

Paid routes are mounted from the mechanisms catalog — see `catalog`. Adding a
mechanism does not require editing this file.
"""

import os
import signal
import sys
import logging
from typing import Callable

from flask import Flask, jsonify

from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.http.middleware.flask import PaymentMiddleware, set_settlement_overrides
from catalog import CatalogRoute, catalog_routes
from config import build_payment_routes, configure_resource_server, load_server_config
from handlers import (
    CLOSE_PATH,
    HEALTH_PATH,
    close_body,
    health_body,
    print_startup_banner,
    route_body,
    unconfigured_error_for_path,
)

logging.getLogger("werkzeug").setLevel(logging.ERROR)
logging.getLogger("flask").setLevel(logging.ERROR)

cfg = load_server_config()
app = Flask(__name__)

if cfg.facilitator_url:
    print(f"Using remote facilitator at: {cfg.facilitator_url}")
    facilitator = HTTPFacilitatorClientSync(FacilitatorConfig(url=cfg.facilitator_url))
else:
    print("Using default facilitator")
    facilitator = HTTPFacilitatorClientSync()

server = x402ResourceServerSync(facilitator)
configure_resource_server(server, cfg)
routes = build_payment_routes(cfg)

# Apply payment middleware
PaymentMiddleware(app, routes, server)


@app.before_request
def reject_unconfigured_networks():
    from flask import request

    err = unconfigured_error_for_path(request.path)
    if err:
        return jsonify(err), 501


# Global flag to track if server should accept new requests
shutdown_requested = False


def make_paid_handler(route: CatalogRoute) -> Callable:
    """Build the GET view function for one catalog route."""

    def handler():
        if shutdown_requested:
            return jsonify({"error": "Server shutting down"}), 503
        response = jsonify(route_body())
        if route.settlement_override:
            set_settlement_overrides(response, route.settlement_override)
        return response

    return handler


for paid_route in catalog_routes():
    app.add_url_rule(
        paid_route.path,
        endpoint=f"paid:{paid_route.path}",
        view_func=make_paid_handler(paid_route),
        methods=["GET"],
    )


@app.route(HEALTH_PATH)
def health_check():
    """Health check endpoint."""
    return jsonify(health_body("flask"))


@app.route(CLOSE_PATH, methods=["POST"])
def close_server():
    """Graceful shutdown endpoint."""
    global shutdown_requested
    shutdown_requested = True

    # Schedule server shutdown after response
    def shutdown():
        os.kill(os.getpid(), signal.SIGTERM)

    import threading

    timer = threading.Timer(0.1, shutdown)
    timer.start()

    return jsonify(close_body())


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully."""
    print("Received shutdown signal, exiting...")
    sys.exit(0)


if __name__ == "__main__":
    # Set up signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    print_startup_banner("Starting Flask server", cfg.port, cfg.facilitator_url)

    app.run(
        host="0.0.0.0",
        port=cfg.port,
        debug=False,  # Disable debug mode to reduce logs
        use_reloader=False,  # Disable reloader to reduce logs
    )
