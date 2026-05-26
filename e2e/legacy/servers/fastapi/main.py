import os
import signal
import sys
import asyncio
from typing import Any, Dict

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from x402.fastapi.middleware import require_payment
from x402.types import EIP712Domain, TokenAmount, TokenAsset
from x402.chains import (
    get_chain_id,
    get_token_decimals,
    get_token_name,
    get_token_version,
    get_default_token_address,
)

# Load environment variables
load_dotenv()

# Get configuration from environment
NETWORK = os.getenv("EVM_NETWORK", "base-sepolia")
ADDRESS = os.getenv("EVM_PAYEE_ADDRESS")
PORT = int(os.getenv("PORT", "4021"))
FACILITATOR_URL = os.getenv("FACILITATOR_URL")

if not ADDRESS:
    print("Error: Missing required environment variable ADDRESS")
    sys.exit(1)

chain_id = get_chain_id(NETWORK)
address = get_default_token_address(chain_id)

app = FastAPI()

# Create facilitator config if URL is provided
facilitator_config = None
if FACILITATOR_URL:
    facilitator_config = {"url": FACILITATOR_URL}
    print(f"Using remote facilitator at: {FACILITATOR_URL}")
else:
    print("Using default facilitator")

# Apply payment middleware to protected endpoints
app.middleware("http")(
    require_payment(
        path="/protected",
        price="$0.001",
        pay_to_address=ADDRESS,
        network=NETWORK,
        facilitator_config=facilitator_config,
    )
)

# Add second protected endpoint with ERC20TokenAmount price
app.middleware("http")(
    require_payment(
        path="/protected-2",
        price=TokenAmount(
            amount="1000",  # 1000 USDC units (0.001 USDC)
            asset=TokenAsset(
                address=address,
                decimals=get_token_decimals(chain_id, address),
                eip712=EIP712Domain(
                    name=get_token_name(chain_id, address),
                    version=get_token_version(chain_id, address),
                ),
            ),
        ),
        pay_to_address=ADDRESS,
        network=NETWORK,
        facilitator_config=facilitator_config,
    )
)

# Global flag to track if server should accept new requests
shutdown_requested = False


@app.get("/protected")
async def protected_endpoint() -> Dict[str, Any]:
    """Protected endpoint that requires payment"""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")

    return {
        "message": "Access granted to protected resource",
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/protected-2")
async def protected_endpoint_2() -> Dict[str, Any]:
    """Protected endpoint that requires ERC20 payment"""
    if shutdown_requested:
        raise HTTPException(status_code=503, detail="Server shutting down")

    return {
        "message": "Access granted to protected resource #2",
        "timestamp": "2024-01-01T00:00:00Z",
    }


@app.get("/health")
async def health_check() -> Dict[str, Any]:
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": "2024-01-01T00:00:00Z",
        "server": "fastapi",
    }


@app.post("/close")
async def close_server() -> Dict[str, Any]:
    """Graceful shutdown endpoint"""
    global shutdown_requested
    shutdown_requested = True

    # Schedule server shutdown after response
    async def delayed_shutdown():
        await asyncio.sleep(0.1)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(delayed_shutdown())

    return {
        "message": "Server shutting down gracefully",
        "timestamp": "2024-01-01T00:00:00Z",
    }


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully"""
    print("Received shutdown signal, exiting...")
    sys.exit(0)


if __name__ == "__main__":
    # Set up signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    import uvicorn

    print(f"Starting FastAPI server on port {PORT}")
    print(f"Server address: {ADDRESS}")
    print(f"Network: {NETWORK}")
    print(f"Using facilitator: {FACILITATOR_URL}")
    print("Server listening on port", PORT)

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
