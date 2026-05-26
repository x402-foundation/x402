#!/bin/bash
# Ensure dependencies are synced before running
uv sync --reinstall-package x402 --quiet
uv run python main.py
