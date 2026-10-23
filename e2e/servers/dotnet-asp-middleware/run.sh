#!/bin/bash
set -e

if [ -z "$PORT" ]; then
  PORT=4023
fi

echo "Server listening on http://127.0.0.1:${PORT}"
export ASPNETCORE_URLS="http://127.0.0.1:${PORT}"

exec dotnet run -c Release --no-build --framework net10.0 --project ../../../examples/dotnet/servers/middleware-example/middleware-example.csproj