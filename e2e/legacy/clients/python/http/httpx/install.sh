#!/bin/bash
set -e

echo "Installing Python dependencies for httpx client..."
uv sync
echo "✅ Dependencies installed"

