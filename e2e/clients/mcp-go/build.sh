#!/bin/bash
set -e

echo "Building MCP Go client..."
go build -o mcp-client .
echo "✅ Build completed: mcp-client"
