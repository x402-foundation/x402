#!/bin/bash
set -e

# Rebuild the local x402 editable dependency so the venv reflects source changes
uv sync --reinstall-package x402
