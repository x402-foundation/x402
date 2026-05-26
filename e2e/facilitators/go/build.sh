#!/bin/bash
set -e

echo "Building Go facilitator..."
go build -o go .
echo "✅ Build completed: go"

