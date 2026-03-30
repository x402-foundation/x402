#!/bin/bash
set -e

echo "Building net/http server..."
go build -o nethttp .
echo "✅ Build completed: nethttp"
