#!/bin/bash
set -e

dotnet --version >/dev/null
dotnet restore ../../../examples/dotnet/servers/mvc-example/mvc-example.csproj