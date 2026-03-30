#!/bin/bash
set -e

echo "Building Echo server..."
go build -o echo .
echo "✅ Build completed: echo"
