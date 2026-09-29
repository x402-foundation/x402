"""JSON Schema for the EIP-2612 Gas Sponsoring extension info payload."""

eip2612_gas_sponsoring_schema: dict = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "from": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The address of the sender.",
        },
        "asset": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The address of the ERC-20 token contract.",
        },
        "spender": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The address of the spender (Canonical Permit2).",
        },
        "amount": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "The amount to approve (uint256).",
        },
        "nonce": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "The current EIP-2612 nonce of the sender.",
        },
        "deadline": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "The timestamp at which the signature expires.",
        },
        "signature": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]+$",
            "description": "The 65-byte concatenated signature (r, s, v) as a hex string.",
        },
        "version": {
            "type": "string",
            "pattern": r"^[0-9]+(\.[0-9]+)*$",
            "description": "Schema version identifier.",
        },
    },
    "required": [
        "from",
        "asset",
        "spender",
        "amount",
        "nonce",
        "deadline",
        "signature",
        "version",
    ],
}
