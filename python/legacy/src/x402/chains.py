NETWORK_TO_ID = {
    "base-sepolia": "84532",
    "base": "8453",
    "avalanche-fuji": "43113",
    "avalanche": "43114",
}


def get_chain_id(network: str) -> str:
    """Get the chain ID for a given network
    Supports string encoded chain IDs and human readable networks
    """
    try:
        int(network)
        return network
    except ValueError:
        pass
    if network not in NETWORK_TO_ID:
        raise ValueError(f"Unsupported network: {network}")
    return NETWORK_TO_ID[network]


KNOWN_TOKENS = {
    "84532": [
        {
            "human_name": "usdc",
            "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
            "name": "USDC",
            "decimals": 6,
            "version": "2",
        }
    ],
    "8453": [
        {
            "human_name": "usdc",
            "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "name": "USD Coin",  # needs to be exactly what is returned by name() on contract
            "decimals": 6,
            "version": "2",
        }
    ],
    "43113": [
        {
            "human_name": "usdc",
            "address": "0x5425890298aed601595a70AB815c96711a31Bc65",
            "name": "USD Coin",
            "decimals": 6,
            "version": "2",
        }
    ],
    "43114": [
        {
            "human_name": "usdc",
            "address": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
            "name": "USDC",
            "decimals": 6,
            "version": "2",
        }
    ],
}


def get_token_name(chain_id: str, address: str) -> str:
    """Get the token name for a given chain and address"""
    for token in KNOWN_TOKENS[chain_id]:
        if token["address"] == address:
            return token["name"]
    raise ValueError(f"Token not found for chain {chain_id} and address {address}")


def get_token_version(chain_id: str, address: str) -> str:
    """Get the token version for a given chain and address"""
    for token in KNOWN_TOKENS[chain_id]:
        if token["address"] == address:
            return token["version"]
    raise ValueError(f"Token not found for chain {chain_id} and address {address}")


def get_token_decimals(chain_id: str, address: str) -> int:
    """Get the token decimals for a given chain and address"""
    for token in KNOWN_TOKENS[chain_id]:
        if token["address"] == address:
            return token["decimals"]
    raise ValueError(f"Token not found for chain {chain_id} and address {address}")


def get_default_token_address(chain_id: str, token_type: str = "usdc") -> str:
    """Get the default token address for a given chain and token type"""
    for token in KNOWN_TOKENS[chain_id]:
        if token["human_name"] == token_type:
            return token["address"]
    raise ValueError(f"Token type '{token_type}' not found for chain {chain_id}")
