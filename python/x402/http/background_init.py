"""Fatal vs retryable handling for HTTP adapter initialize() failures."""

from __future__ import annotations

import os
import sys

from ..schemas.errors import FacilitatorCapabilityError
from .types import RouteConfigurationError

# os._exit, overridable in tests so fatal-init coverage does not kill the
# test process.
_process_exit = os._exit


def is_fatal_startup_init_error(error: BaseException | None) -> bool:
    """Report whether a resource-server initialize() failure is a permanent misconfiguration.

    Transient facilitator timeouts stay retryable on the next protected request.
    Capability and route mismatches will not become valid later and must not
    leave the process listening.
    """
    if error is None:
        return False
    return isinstance(error, (FacilitatorCapabilityError, RouteConfigurationError))


def handle_background_init_error(error: BaseException | None) -> None:
    """Handle an initialize() failure from HTTP adapters.

    Retryable failures are logged so they are not silent; the original error is
    still available to the caller. Fatal configuration errors exit the process
    so a misconfigured server does not stay up until the first paid request.
    """
    if error is None:
        return
    if not is_fatal_startup_init_error(error):
        print(f"Warning: failed to initialize x402 server: {error}")
        return
    print(error, file=sys.stderr)
    _process_exit(1)
