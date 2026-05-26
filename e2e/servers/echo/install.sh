#!/bin/bash
set -e

echo "Installing Go dependencies for Echo server..."
go mod tidy
echo "✅ Dependencies installed"
