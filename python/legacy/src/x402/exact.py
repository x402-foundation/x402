import time
import secrets
from typing import Dict, Any
from typing_extensions import (
    TypedDict,
)  # use `typing_extensions.TypedDict` instead of `typing.TypedDict` on Python < 3.12
from eth_account import Account
from x402.encoding import safe_base64_encode, safe_base64_decode
from x402.types import (
    PaymentRequirements,
)
from x402.chains import get_chain_id
import json


def create_nonce() -> bytes:
    """Create a random 32-byte nonce for authorization signatures."""
    return secrets.token_bytes(32)


def prepare_payment_header(
    sender_address: str, x402_version: int, payment_requirements: PaymentRequirements
) -> Dict[str, Any]:
    """Prepare an unsigned payment header with sender address, x402 version, and payment requirements."""
    nonce = create_nonce()
    valid_after = str(int(time.time()) - 60)  # 60 seconds before
    valid_before = str(int(time.time()) + payment_requirements.max_timeout_seconds)

    return {
        "x402Version": x402_version,
        "scheme": payment_requirements.scheme,
        "network": payment_requirements.network,
        "payload": {
            "signature": None,
            "authorization": {
                "from": sender_address,
                "to": payment_requirements.pay_to,
                "value": payment_requirements.max_amount_required,
                "validAfter": valid_after,
                "validBefore": valid_before,
                "nonce": nonce,
            },
        },
    }


class PaymentHeader(TypedDict):
    x402Version: int
    scheme: str
    network: str
    payload: dict[str, Any]


def sign_payment_header(
    account: Account, payment_requirements: PaymentRequirements, header: PaymentHeader
) -> str:
    """Sign a payment header using the account's private key."""
    try:
        auth = header["payload"]["authorization"]

        nonce_bytes = bytes.fromhex(auth["nonce"])

        typed_data = {
            "types": {
                "TransferWithAuthorization": [
                    {"name": "from", "type": "address"},
                    {"name": "to", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "validAfter", "type": "uint256"},
                    {"name": "validBefore", "type": "uint256"},
                    {"name": "nonce", "type": "bytes32"},
                ]
            },
            "primaryType": "TransferWithAuthorization",
            "domain": {
                "name": payment_requirements.extra["name"],
                "version": payment_requirements.extra["version"],
                "chainId": int(get_chain_id(payment_requirements.network)),
                "verifyingContract": payment_requirements.asset,
            },
            "message": {
                "from": auth["from"],
                "to": auth["to"],
                "value": int(auth["value"]),
                "validAfter": int(auth["validAfter"]),
                "validBefore": int(auth["validBefore"]),
                "nonce": nonce_bytes,
            },
        }

        signed_message = account.sign_typed_data(
            domain_data=typed_data["domain"],
            message_types=typed_data["types"],
            message_data=typed_data["message"],
        )
        signature = signed_message.signature.hex()
        if not signature.startswith("0x"):
            signature = f"0x{signature}"

        header["payload"]["signature"] = signature

        header["payload"]["authorization"]["nonce"] = f"0x{auth['nonce']}"

        encoded = encode_payment(header)
        return encoded
    except Exception:
        raise


def encode_payment(payment_payload: Dict[str, Any]) -> str:
    """Encode a payment payload into a base64 string, handling HexBytes and other non-serializable types."""
    from hexbytes import HexBytes

    def default(obj):
        if isinstance(obj, HexBytes):
            return obj.hex()
        if hasattr(obj, "to_dict"):
            return obj.to_dict()
        if hasattr(obj, "hex"):
            return obj.hex()
        raise TypeError(
            f"Object of type {obj.__class__.__name__} is not JSON serializable"
        )

    return safe_base64_encode(json.dumps(payment_payload, default=default))


def decode_payment(encoded_payment: str) -> Dict[str, Any]:
    """Decode a base64 encoded payment string back into a PaymentPayload object."""
    return json.loads(safe_base64_decode(encoded_payment))
