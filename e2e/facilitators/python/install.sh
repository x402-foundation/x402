#!/bin/bash
set -e

echo "Installing Python dependencies for facilitator..."
uv sync
echo "✅ Dependencies installed"

