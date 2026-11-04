#!/bin/bash
cd "$(dirname "$0")"
exec "${JAVA_HOME:+$JAVA_HOME/bin/}java" -jar target/jetty.jar
