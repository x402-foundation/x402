#!/bin/bash
set -e

echo "Installing Python dependencies for Flask server..."
uv sync
echo "✅ Dependencies installed"

