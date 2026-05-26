#!/bin/bash
set -e

echo "Building MCP Go server..."
go build -o mcp-server .
echo "✅ Build completed: mcp-server"
