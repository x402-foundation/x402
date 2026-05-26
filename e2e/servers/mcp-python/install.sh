#!/bin/bash
set -e

echo "Installing Python dependencies for MCP server..."
uv sync
echo "✅ Dependencies installed"
