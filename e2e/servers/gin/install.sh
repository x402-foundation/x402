#!/bin/bash
set -e

echo "Installing Go dependencies for Gin server..."
go mod tidy
echo "✅ Dependencies installed"

