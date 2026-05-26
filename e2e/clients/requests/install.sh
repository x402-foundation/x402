#!/bin/bash
set -e

echo "Installing Python dependencies for requests client..."
uv sync
echo "✅ Dependencies installed"

