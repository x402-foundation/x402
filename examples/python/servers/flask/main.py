import os

from dotenv import load_dotenv
from flask import Flask, jsonify

from x402.http import FacilitatorConfig, HTTPFacilitatorClientSync, PaymentOption
from x402.http.middleware.flask import payment_middleware
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.schemas import AssetAmount, Network
from x402.server import x402ResourceServerSync

load_dotenv()

# Config
EVM_ADDRESS = os.getenv("EVM_ADDRESS")
SVM_ADDRESS = os.getenv("SVM_ADDRESS")
EVM_NETWORK: Network = "eip155:84532"  # Base Sepolia
SVM_NETWORK: Network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"  # Solana Devnet
FACILITATOR_URL = os.getenv("FACILITATOR_URL", "https://x402.org/facilitator")

if not EVM_ADDRESS or not SVM_ADDRESS:
    raise ValueError("Missing required environment variables")


# App
app = Flask(__name__)


# x402 Middleware
facilitator = HTTPFacilitatorClientSync(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServerSync(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())
server.register(SVM_NETWORK, ExactSvmServerScheme())

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price="$0.01",
                network=EVM_NETWORK,
            ),
            PaymentOption(
                scheme="exact",
                pay_to=SVM_ADDRESS,
                price="$0.01",
                network=SVM_NETWORK,
            ),
        ],
        mime_type="application/json",
        description="Weather report",
    ),
    "GET /premium/*": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                pay_to=EVM_ADDRESS,
                price=AssetAmount(
                    amount="10000",  # $0.01 USDC
                    asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
                    extra={"name": "USDC", "version": "2"},
                ),
                network=EVM_NETWORK,
            ),
            PaymentOption(
                scheme="exact",
                pay_to=SVM_ADDRESS,
                price="$0.01",
                network=SVM_NETWORK,
            ),
        ],
        mime_type="application/json",
        description="Premium content",
    ),
}
payment_middleware(app, routes=routes, server=server)


# Routes
@app.route("/health")
def health_check():
    return jsonify({"status": "ok"})


@app.route("/weather")
def get_weather():
    return jsonify({"report": {"weather": "sunny", "temperature": 70}})


@app.route("/premium/content")
def get_premium_content():
    return jsonify({"content": "This is premium content"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=4021, debug=False)
