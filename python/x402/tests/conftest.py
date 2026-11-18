"""Pytest configuration and fixtures.

This file is automatically loaded by pytest before running tests.
"""

import os
from pathlib import Path


def pytest_configure(config):
    """Load .env file before tests run."""
    # Try to load from python/x402/.env first, then root .env
    possible_paths = [
        Path(__file__).parent.parent / ".env",  # python/x402/.env
        Path(__file__).parent.parent.parent.parent / ".env",  # root .env
    ]

    for env_path in possible_paths:
        if env_path.exists():
            _load_dotenv(env_path)
            break


def _load_dotenv(path: Path) -> None:
    """Load environment variables from a .env file.

    Args:
        path: Path to the .env file.
    """
    with open(path) as f:
        for line in f:
            line = line.strip()
            # Skip empty lines and comments
            if not line or line.startswith("#"):
                continue
            # Parse KEY=VALUE
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                # Remove surrounding quotes if present
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]
                # Only set if not already in environment
                if key not in os.environ:
                    os.environ[key] = value
