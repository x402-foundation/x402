#!/bin/bash
set -e

echo "Building Gin server (legacy)..."
go build -o gin .
echo "✅ Build completed: gin"

