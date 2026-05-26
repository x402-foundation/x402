#!/bin/bash
uv sync --reinstall-package x402 --quiet
uv run python main.py
