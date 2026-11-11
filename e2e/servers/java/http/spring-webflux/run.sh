#!/bin/bash
# Starts the packaged server; prints "Server listening" when ready.
cd "$(dirname "$0")"
exec java -jar target/app.jar
