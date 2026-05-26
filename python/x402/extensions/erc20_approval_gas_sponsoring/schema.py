"""JSON Schema for the ERC-20 Approval Gas Sponsoring extension info payload."""

erc20_approval_gas_sponsoring_schema: dict = {
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
            "description": "The ERC-20 token contract address to approve.",
        },
        "spender": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]{40}$",
            "description": "The address of the spender (Canonical Permit2).",
        },
        "amount": {
            "type": "string",
            "pattern": "^[0-9]+$",
            "description": "Approval amount (uint256).",
        },
        "signedTransaction": {
            "type": "string",
            "pattern": "^0x[a-fA-F0-9]+$",
            "description": "RLP-encoded signed transaction calling ERC20.approve().",
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
        "signedTransaction",
        "version",
    ],
}
