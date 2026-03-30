#!/bin/bash
set -e

echo "Installing Go dependencies for net/http server..."
go mod tidy
echo "✅ Dependencies installed"
