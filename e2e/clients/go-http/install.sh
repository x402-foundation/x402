#!/bin/bash
set -e

echo "Installing Go dependencies for go-http client..."
go mod tidy
echo "✅ Dependencies installed"

