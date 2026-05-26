#!/bin/bash
set -e

echo "Building Gin server..."
go build -o gin .
echo "✅ Build completed: gin"

