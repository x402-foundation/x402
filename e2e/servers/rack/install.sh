#!/bin/bash
set -e

echo "Installing Ruby dependencies for Rack server..."
bundle install
echo "✅ Dependencies installed"
