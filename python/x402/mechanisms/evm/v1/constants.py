"""V1 legacy network constants for EVM mechanisms."""

from ..constants import AssetInfo

# Default assets keyed by v1 legacy network name.
V1_DEFAULT_ASSETS: dict[str, AssetInfo] = {
    "ethereum": {
        "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "name": "USD Coin",
        "version": "2",
        "decimals": 6,
    },
    "base": {
        "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "name": "USD Coin",
        "version": "2",
        "decimals": 6,
    },
    "base-sepolia": {
        "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "name": "USDC",
        "version": "2",
        "decimals": 6,
    },
    "polygon": {
        "address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        "name": "USD Coin",
        "version": "2",
        "decimals": 6,
    },
    "avalanche": {
        "address": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        "name": "USD Coin",
        "version": "2",
        "decimals": 6,
    },
    "monad": {
        "address": "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
        "name": "USD Coin",
        "version": "2",
        "decimals": 6,
    },
    "stable": {
        "address": "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
        "name": "USDT0",
        "version": "1",
        "decimals": 6,
    },
    "stable-testnet": {
        "address": "0x78Cf24370174180738C5B8E352B6D14c83a6c9A9",
        "name": "USDT0",
        "version": "1",
        "decimals": 6,
    },
}


# V1 supported networks (legacy name-based)
V1_NETWORKS = [
    "abstract",
    "abstract-testnet",
    "base-sepolia",
    "base",
    "avalanche-fuji",
    "avalanche",
    "iotex",
    "sei",
    "sei-testnet",
    "polygon",
    "polygon-amoy",
    "peaq",
    "story",
    "educhain",
    "skale-base-sepolia",
    "megaeth",
    "monad",
    "stable",
    "stable-testnet",
]

# V1 network name to chain ID mapping
V1_NETWORK_CHAIN_IDS: dict[str, int] = {
    "base": 8453,
    "base-sepolia": 84532,
    "ethereum": 1,
    "polygon": 137,
    "polygon-amoy": 80002,
    "avalanche": 43114,
    "avalanche-fuji": 43113,
    "abstract": 2741,
    "abstract-testnet": 11124,
    "iotex": 4689,
    "sei": 1329,
    "sei-testnet": 713715,
    "peaq": 3338,
    "story": 1513,
    "educhain": 656476,
    "skale-base-sepolia": 1444673419,
    "megaeth": 4326,
    "monad": 143,
    "stable": 988,
    "stable-testnet": 2201,
}
