#!/bin/bash
# One-shot e2e client: prints one JSON result line on stdout (logs go to stderr).
cd "$(dirname "$0")"
exec java -cp "target/java-http.jar:target/lib/*" org.x402.e2e.client.Main
