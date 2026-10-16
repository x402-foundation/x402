#!/bin/bash
set -e

dotnet --version >/dev/null
dotnet restore ../../../examples/dotnet/servers/middleware-example/middleware-example.csproj