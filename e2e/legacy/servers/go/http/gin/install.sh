#!/bin/bash
set -e

echo "Installing Go dependencies for Gin server (legacy)..."
go mod tidy
echo "✅ Dependencies installed"

