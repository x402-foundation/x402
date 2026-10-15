#!/bin/bash
# Starts the packaged facilitator; prints "Facilitator listening" when ready.
cd "$(dirname "$0")"
exec java -jar target/app.jar
