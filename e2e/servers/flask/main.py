"""Flask e2e test server using x402 v2 SDK."""

import os
import signal
import sys
import logging
from flask import Flask, jsonify

from dotenv import load_dotenv

# Import from new x402 package (sync variants for Flask)
from x402 import x402ResourceServerSync
from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync
from x402.http.middleware.flask import PaymentMiddleware, set_settlement_overrides
from x402.mechanisms.evm.exact import register_exact_evm_server
from x402.mechanisms.evm.upto import UptoEvmServerScheme
from x402.mechanisms.svm.exact import register_exact_svm_server
from x402.mechanisms.tvm import TVM_TESTNET
from x402.mechanisms.tvm.exact import ExactTvmServerScheme
from x402.extensions.bazaar import (
    bazaar_resource_server_extension,
    declare_discovery_extension,
    OutputConfig,
)
from x402.extensions.eip2612_gas_sponsoring import (
    declare_eip2612_gas_sponsoring_extension,
)
from x402.extensions.erc20_approval_gas_sponsoring import (
    declare_erc20_approval_gas_sponsoring_extension,
)

# Configure logging to reduce verbosity
logging.getLogger("werkzeug").setLevel(logging.ERROR)
logging.getLogger("flask").setLevel(logging.ERROR)

# Load environment variables
load_dotenv()

# Get configuration from environment
EVM_ADDRESS = os.getenv("EVM_PAYEE_ADDRESS")
SVM_ADDRESS = os.getenv("SVM_PAYEE_ADDRESS")
TVM_ADDRESS = os.getenv("TVM_PAYEE_ADDRESS")
PORT = int(os.getenv("PORT", "4021"))
FACILITATOR_URL = os.getenv("FACILITATOR_URL")
EVM_PERMIT2_ASSET = os.getenv(
    "EVM_PERMIT2_ASSET", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
)
TVM_NETWORK = os.getenv("TVM_NETWORK", TVM_TESTNET)

if not any([EVM_ADDRESS, SVM_ADDRESS, TVM_ADDRESS]):
    print(
        "Error: At least one of EVM_PAYEE_ADDRESS, SVM_PAYEE_ADDRESS, or TVM_PAYEE_ADDRESS is required"
    )
    sys.exit(1)

# Network configurations (CAIP-2 format)
EVM_NETWORK = "eip155:84532"  # Base Sepolia
SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"  # Solana Devnet

app = Flask(__name__)

# Create HTTP facilitator client (sync for Flask)
if FACILITATOR_URL:
    print(f"Using remote facilitator at: {FACILITATOR_URL}")
    config = FacilitatorConfig(url=FACILITATOR_URL)
    facilitator = HTTPFacilitatorClientSync(config)
else:
    print("Using default facilitator")
    facilitator = HTTPFacilitatorClientSync()

# Create resource server (sync for Flask)
server = x402ResourceServerSync(facilitator)

# Register EVM and SVM exact schemes
register_exact_evm_server(server, EVM_NETWORK)
server.register(EVM_NETWORK, UptoEvmServerScheme())
register_exact_svm_server(server, SVM_NETWORK)
server.register(TVM_NETWORK, ExactTvmServerScheme())

# Register Bazaar discovery extension
server.register_extension(bazaar_resource_server_extension)

# Define routes with payment requirements
routes = {
    "GET /exact/evm/eip3009": {
        "accepts": {
            "scheme": "exact",
            "payTo": EVM_ADDRESS,
            "price": "$0.001",
            "network": EVM_NETWORK,
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Access granted to protected resource",
                        "timestamp": "2024-01-01T00:00:00Z",
                        "data": {"resource": "premium_content", "access_level": "paid"},
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                            "data": {"type": "object"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /exact/svm": {
        "accepts": {
            "scheme": "exact",
            "payTo": SVM_ADDRESS,
            "price": "$0.001",
            "network": SVM_NETWORK,
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Access granted to SVM protected resource",
                        "timestamp": "2024-01-01T00:00:00Z",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /exact/tvm": {
        "accepts": {
            "scheme": "exact",
            "payTo": TVM_ADDRESS,
            "price": "$0.001",
            "network": TVM_NETWORK,
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Access granted to TVM protected resource",
                        "timestamp": "2024-01-01T00:00:00Z",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /exact/evm/permit2-eip2612GasSponsoring": {
        "accepts": {
            "scheme": "exact",
            "payTo": EVM_ADDRESS,
            "network": EVM_NETWORK,
            "price": {
                "amount": "1000",
                "asset": EVM_PERMIT2_ASSET,
                "extra": {
                    "assetTransferMethod": "permit2",
                    "name": "USDC",
                    "version": "2",
                },
            },
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Permit2 endpoint accessed successfully",
                        "timestamp": "2024-01-01T00:00:00Z",
                        "method": "permit2",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                            "method": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
            **declare_eip2612_gas_sponsoring_extension(),
        },
    },
    "GET /exact/evm/permit2-erc20ApprovalGasSponsoring": {
        "accepts": {
            "scheme": "exact",
            "payTo": EVM_ADDRESS,
            "network": EVM_NETWORK,
            "price": {
                "amount": "1000",
                "asset": EVM_PERMIT2_ASSET,
                "extra": {"assetTransferMethod": "permit2"},
            },
        },
        "extensions": {
            **declare_erc20_approval_gas_sponsoring_extension(),
        },
    },
    "GET /upto/evm/permit2": {
        "accepts": {
            "scheme": "upto",
            "payTo": EVM_ADDRESS,
            "network": EVM_NETWORK,
            "price": {
                "amount": "2000",
                "asset": EVM_PERMIT2_ASSET,
                "extra": {
                    "assetTransferMethod": "permit2",
                    "name": "USDC",
                    "version": "2",
                },
            },
        },
        "extensions": {
            **declare_discovery_extension(
                output=OutputConfig(
                    example={
                        "message": "Upto endpoint accessed successfully",
                        "timestamp": "2024-01-01T00:00:00Z",
                        "method": "upto-permit2",
                    },
                    schema={
                        "properties": {
                            "message": {"type": "string"},
                            "timestamp": {"type": "string"},
                            "method": {"type": "string"},
                        },
                        "required": ["message", "timestamp"],
                    },
                )
            ),
        },
    },
    "GET /upto/evm/permit2-eip2612GasSponsoring": {
        "accepts": {
            "scheme": "upto",
            "payTo": EVM_ADDRESS,
            "network": EVM_NETWORK,
            "price": {
                "amount": "2000",
                "asset": EVM_PERMIT2_ASSET,
                "extra": {
                    "assetTransferMethod": "permit2",
                    "name": "USDC",
                    "version": "2",
                },
            },
        },
        "extensions": {
            **declare_eip2612_gas_sponsoring_extension(),
        },
    },
    "GET /upto/evm/permit2-erc20ApprovalGasSponsoring": {
        "accepts": {
            "scheme": "upto",
            "payTo": EVM_ADDRESS,
            "network": EVM_NETWORK,
            "price": {
                "amount": "2000",
                "asset": EVM_PERMIT2_ASSET,
                "extra": {
                    "assetTransferMethod": "permit2",
                },
            },
        },
        "extensions": {
            **declare_erc20_approval_gas_sponsoring_extension(),
        },
    },
}

routes = {
    route: requirements
    for route, requirements in routes.items()
    if requirements["accepts"].get("payTo")
}

# Apply payment middleware
PaymentMiddleware(app, routes, server)

# Global flag to track if server should accept new requests
shutdown_requested = False


@app.route("/exact/evm/eip3009")
def protected_endpoint():
    """Protected endpoint that requires payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503

    return jsonify(
        {
            "message": "Access granted to protected resource",
            "timestamp": "2024-01-01T00:00:00Z",
            "data": {"resource": "premium_content", "access_level": "paid"},
        }
    )


@app.route("/exact/svm")
def protected_svm_endpoint():
    """Protected endpoint that requires SVM (Solana) payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503

    return jsonify(
        {
            "message": "Access granted to SVM protected resource",
            "timestamp": "2024-01-01T00:00:00Z",
        }
    )


@app.route("/exact/tvm")
def protected_tvm_endpoint():
    """Protected endpoint that requires TVM payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503

    return jsonify(
        {
            "message": "Access granted to TVM protected resource",
            "timestamp": "2024-01-01T00:00:00Z",
        }
    )


@app.route("/exact/evm/permit2-eip2612GasSponsoring")
def protected_permit2_endpoint():
    """Protected endpoint that requires Permit2 payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Permit2 endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "permit2",
        }
    )


@app.route("/exact/evm/permit2-erc20ApprovalGasSponsoring")
def protected_permit2_erc20_endpoint():
    """Protected endpoint that requires Permit2 payment with ERC-20 approval sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    return jsonify(
        {
            "message": "Permit2+ERC20Approval endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "permit2+erc20approval",
        }
    )


@app.route("/upto/evm/permit2")
def protected_upto_permit2_endpoint():
    """Protected endpoint that requires upto Permit2 payment."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    resp = jsonify(
        {
            "message": "Upto endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "upto-permit2",
        }
    )
    set_settlement_overrides(resp, {"amount": "1000"})
    return resp


@app.route("/upto/evm/permit2-eip2612GasSponsoring")
def protected_upto_permit2_eip2612_endpoint():
    """Protected endpoint that requires upto Permit2 payment with EIP-2612 gas sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    resp = jsonify(
        {
            "message": "Upto Permit2 EIP-2612 endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "upto-permit2-eip2612",
        }
    )
    set_settlement_overrides(resp, {"amount": "1000"})
    return resp


@app.route("/upto/evm/permit2-erc20ApprovalGasSponsoring")
def protected_upto_permit2_erc20_endpoint():
    """Protected endpoint that requires upto Permit2 payment with ERC-20 approval gas sponsoring."""
    if shutdown_requested:
        return jsonify({"error": "Server shutting down"}), 503
    resp = jsonify(
        {
            "message": "Upto Permit2 ERC-20 approval endpoint accessed successfully",
            "timestamp": "2024-01-01T00:00:00Z",
            "method": "upto-permit2-erc20-approval",
        }
    )
    set_settlement_overrides(resp, {"amount": "1000"})
    return resp


@app.route("/health")
def health_check():
    """Health check endpoint."""
    return jsonify(
        {"status": "healthy", "timestamp": "2024-01-01T00:00:00Z", "server": "flask"}
    )


@app.route("/close", methods=["POST"])
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

    return jsonify(
        {
            "message": "Server shutting down gracefully",
            "timestamp": "2024-01-01T00:00:00Z",
        }
    )


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully."""
    print("Received shutdown signal, exiting...")
    sys.exit(0)


if __name__ == "__main__":
    # Set up signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    print(f"Starting Flask server on port {PORT}")
    print(f"EVM address: {EVM_ADDRESS}")
    print(f"SVM address: {SVM_ADDRESS}")
    print(f"EVM Network: {EVM_NETWORK}")
    print(f"SVM Network: {SVM_NETWORK}")
    print(f"Using facilitator: {FACILITATOR_URL}")
    print("Server listening on port", PORT)

    app.run(
        host="0.0.0.0",
        port=PORT,
        debug=False,  # Disable debug mode to reduce logs
        use_reloader=False,  # Disable reloader to reduce logs
    )
