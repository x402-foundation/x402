#!/bin/bash
set -e

dotnet --version >/dev/null
dotnet restore ../../../examples/dotnet/servers/minimal-api-example/minimal-api-example.csproj