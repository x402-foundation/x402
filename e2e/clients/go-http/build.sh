#!/bin/bash
set -e

echo "Building go-http client..."
go build -o main .
echo "✅ Build completed: main"

