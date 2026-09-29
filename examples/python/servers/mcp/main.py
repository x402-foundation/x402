"""MCP Server Example Entry Point.

Routes to simple, advanced, or existing-server example based on CLI arguments.

Usage:
    python main.py simple           - Run simple example (create_payment_wrapper)
    python main.py advanced         - Run advanced example (create_payment_wrapper with hooks)
    python main.py existing         - Run existing server example (create_payment_wrapper with existing server)
"""

import sys

from simple import run_simple
from advanced import run_advanced
from existing_server import run_existing

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "simple"

    try:
        if mode == "advanced":
            run_advanced()
        elif mode == "existing":
            run_existing()
        else:
            run_simple()
    except Exception as e:
        print(f"Fatal error: {e}", file=sys.stderr)
        sys.exit(1)
