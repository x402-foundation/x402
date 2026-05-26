#!/bin/bash
set -e

echo "Installing Go dependencies for MCP server..."
go mod tidy
echo "✅ Dependencies installed"
