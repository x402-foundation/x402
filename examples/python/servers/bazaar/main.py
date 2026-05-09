import os

from dotenv import load_dotenv
from fastapi import FastAPI

from x402.extensions.bazaar import OutputConfig, declare_discovery_extension
from x402.http import FacilitatorConfig, HTTPFacilitatorClient, PaymentOption
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http.types import RouteConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.schemas import Network
from x402.server import x402ResourceServer

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
app = FastAPI()


# x402 Middleware
facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=FACILITATOR_URL))
server = x402ResourceServer(facilitator)
server.register(EVM_NETWORK, ExactEvmServerScheme())
server.register(SVM_NETWORK, ExactSvmServerScheme())

payment_options = [
    PaymentOption(scheme="exact", pay_to=EVM_ADDRESS, price="$0.01", network=EVM_NETWORK),
    PaymentOption(scheme="exact", pay_to=SVM_ADDRESS, price="$0.01", network=SVM_NETWORK),
]

routes = {
    # Single path param: /weather/:city
    "GET /weather/:city": RouteConfig(
        accepts=payment_options,
        mime_type="application/json",
        description="Weather data for a city",
        extensions=declare_discovery_extension(
            path_params_schema={
                "properties": {"city": {"type": "string", "description": "City name slug"}},
                "required": ["city"],
            },
            output=OutputConfig(
                example={"city": "san-francisco", "weather": "foggy", "temperature": 60}
            ),
        ),
    ),
    # Multiple path params: /weather/:country/:city
    # Param names are matched by position in the URL, not by declaration order in the schema.
    # /weather/us/san-francisco -> { country: "us", city: "san-francisco" }
    "GET /weather/:country/:city": RouteConfig(
        accepts=payment_options,
        mime_type="application/json",
        description="Weather data for a city in a specific country",
        extensions=declare_discovery_extension(
            path_params_schema={
                "properties": {
                    "country": {"type": "string", "description": "Country code"},
                    "city": {"type": "string", "description": "City name slug"},
                },
                "required": ["country", "city"],
            },
            output=OutputConfig(
                example={
                    "country": "us",
                    "city": "san-francisco",
                    "weather": "foggy",
                    "temperature": 60,
                }
            ),
        ),
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)


# Routes
@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/weather/{city}")
async def get_weather(city: str) -> dict:
    weather_data = {
        "san-francisco": {"weather": "foggy", "temperature": 60},
        "new-york": {"weather": "cloudy", "temperature": 55},
        "tokyo": {"weather": "rainy", "temperature": 65},
    }
    data = weather_data.get(city, {"weather": "sunny", "temperature": 70})
    return {"city": city, "weather": data["weather"], "temperature": data["temperature"]}


@app.get("/weather/{country}/{city}")
async def get_weather_by_country(country: str, city: str) -> dict:
    weather_data: dict[str, dict[str, dict]] = {
        "us": {
            "san-francisco": {"weather": "foggy", "temperature": 60},
            "new-york": {"weather": "cloudy", "temperature": 55},
        },
        "jp": {
            "tokyo": {"weather": "rainy", "temperature": 65},
            "osaka": {"weather": "clear", "temperature": 72},
        },
    }
    data = weather_data.get(country, {}).get(city, {"weather": "sunny", "temperature": 70})
    return {"country": country, "city": city, "weather": data["weather"], "temperature": data["temperature"]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4021)
