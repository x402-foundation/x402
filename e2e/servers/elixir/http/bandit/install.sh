#!/bin/bash
set -e
mix local.hex --force --if-missing
mix local.rebar --force --if-missing
mix deps.get
