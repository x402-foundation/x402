#!/bin/bash
set -e

echo "Installing Go dependencies for facilitator..."
go mod tidy
echo "✅ Dependencies installed"

