#!/bin/bash
set -e

echo "Installing Python dependencies for FastAPI server..."
uv sync
echo "✅ Dependencies installed"

