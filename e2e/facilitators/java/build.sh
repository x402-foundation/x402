#!/bin/bash
# Installs the Java SDK, then packages the facilitator as a fat jar.
set -euo pipefail
cd "$(dirname "$0")"

mvn=(mvn -B -q -Dcheckstyle.skip)
"${mvn[@]}" -f ../../../java/pom.xml install -DskipTests
"${mvn[@]}" package
