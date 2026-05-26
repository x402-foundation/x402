#!/bin/bash
set -e

echo "Installing Go dependencies for MCP client..."
go mod tidy
echo "✅ Dependencies installed"
