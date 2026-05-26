import os
import json
import asyncio
from dotenv import load_dotenv
from eth_account import Account
from x402.clients.httpx import x402_payment_hooks
from x402.clients.base import decode_x_payment_response
import httpx

# Load environment variables
load_dotenv()

# Get environment variables
private_key = os.getenv("EVM_PRIVATE_KEY")
base_url = os.getenv("RESOURCE_SERVER_URL")
endpoint_path = os.getenv("ENDPOINT_PATH")

if not all([private_key, base_url, endpoint_path]):
    error_result = {"success": False, "error": "Missing required environment variables"}
    print(json.dumps(error_result))
    exit(1)

# Create eth_account from private key
account = Account.from_key(private_key)


async def main():
    # Create httpx client with x402 payment hooks and increased timeout
    # Set timeout to 30 seconds to handle busy servers during test runs
    timeout = httpx.Timeout(30.0, connect=10.0)
    async with httpx.AsyncClient(base_url=base_url, timeout=timeout) as client:
        # Add payment hooks directly to client.event_hooks
        client.event_hooks = x402_payment_hooks(account)

        # Make request
        try:
            response = await client.get(endpoint_path)

            # Read the response content
            content = await response.aread()
            response_data = json.loads(content.decode())

            # Prepare result
            result = {
                "success": True,
                "data": response_data,
                "status_code": response.status_code,
                "payment_response": None,
            }

            # Check for payment response header
            if "X-Payment-Response" in response.headers:
                payment_response = decode_x_payment_response(
                    response.headers["X-Payment-Response"]
                )
                result["payment_response"] = payment_response

            # Output structured result as JSON for proxy to parse
            print(json.dumps(result))
            exit(0)

        except Exception as e:
            error_result = {
                "success": False,
                "error": str(e),
                "status_code": getattr(e, "response", {}).get("status_code", None)
                if hasattr(e, "response")
                else None,
            }
            print(json.dumps(error_result))
            exit(1)


if __name__ == "__main__":
    asyncio.run(main())
