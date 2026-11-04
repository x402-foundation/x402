#!/bin/bash
# Installs the Java SDK and the shared e2e client module, then packages this component as a fat jar.
set -euo pipefail
cd "$(dirname "$0")"

mvn=(mvn -B -q -Dcheckstyle.skip)
"${mvn[@]}" -f ../../../../../java/pom.xml install -DskipTests
"${mvn[@]}" -f ../../pom.xml install
"${mvn[@]}" package
