package http

import (
	"errors"
	"fmt"
	"os"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// processExit is os.Exit, overridable in tests so fatal-init coverage does not
// kill the test process.
var processExit = os.Exit

// IsFatalStartupInitError reports whether a resource-server Initialize failure
// is a permanent misconfiguration.
//
// Transient facilitator timeouts stay retryable on the next protected request.
// Capability and route mismatches will not become valid later and must not
// leave the process listening.
func IsFatalStartupInitError(err error) bool {
	if err == nil {
		return false
	}
	var capErr *x402.FacilitatorCapabilityError
	if errors.As(err, &capErr) {
		return true
	}
	var routeErr *RouteConfigurationError
	return errors.As(err, &routeErr)
}

// HandleBackgroundInitError handles an Initialize() failure from HTTP adapters.
//
// Retryable failures are logged so they are not silent; the original error is
// still available to the caller. Fatal configuration errors exit the process
// so a misconfigured server does not stay up until the first paid request.
func HandleBackgroundInitError(err error) {
	if err == nil {
		return
	}
	if !IsFatalStartupInitError(err) {
		fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
		return
	}
	fmt.Fprintln(os.Stderr, err)
	processExit(1)
}
