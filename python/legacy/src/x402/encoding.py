import base64
from typing import Union


def safe_base64_encode(data: Union[str, bytes]) -> str:
    """Safely encode string or bytes to base64 string.

    Args:
        data: String or bytes to encode

    Returns:
        Base64 encoded string
    """
    if isinstance(data, str):
        data = data.encode("utf-8")
    return base64.b64encode(data).decode("utf-8")


def safe_base64_decode(data: str) -> str:
    """Safely decode base64 string to bytes and then to utf-8 string.

    Args:
        data: Base64 encoded string

    Returns:
        Decoded utf-8 string
    """
    return base64.b64decode(data).decode("utf-8")
