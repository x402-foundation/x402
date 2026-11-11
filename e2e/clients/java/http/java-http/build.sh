#!/bin/bash
# Installs the Java v2 reactor (so a clean checkout resolves org.x402:*:2.0.0-SNAPSHOT),
# then packages this client with its runtime dependencies in target/lib.
set -euo pipefail
cd "$(dirname "$0")"
# setup.sh installs the reactor once and sets X402_JAVA_REACTOR_READY; alone, install it here.
if [ -z "${X402_JAVA_REACTOR_READY:-}" ]; then
  mvn -q -f ../../../../../java/pom.xml install -DskipTests
fi
mvn -q clean package
