import os
import json
from dotenv import load_dotenv
from eth_account import Account
from x402.clients.requests import x402_http_adapter
from x402.clients.base import decode_x_payment_response
import requests

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


def main():
    # Create a session and mount the x402 adapter
    session = requests.Session()
    adapter = x402_http_adapter(account)

    # Mount the adapter for both HTTP and HTTPS
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    # Make request
    try:
        response = session.get(f"{base_url}{endpoint_path}")

        # Read the response content
        content = response.content
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
    main()
