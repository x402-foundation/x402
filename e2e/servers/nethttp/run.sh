#!/bin/bash
# `go run .` compiles the whole package (main.go + batched_authorizer.go),
# whereas `go run main.go` would only compile main.go and miss helper files
# in the same package, causing `undefined: newBatchedAuthorizerSigner` errors.
go run .
