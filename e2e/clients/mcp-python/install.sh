#!/bin/bash
set -e

echo "Installing Python dependencies for MCP client..."
uv sync
echo "✅ Dependencies installed"
