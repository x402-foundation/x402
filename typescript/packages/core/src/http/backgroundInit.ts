import { FacilitatorCapabilityError } from "../types/facilitator";
import { RouteConfigurationError } from "./x402HTTPResourceServer";

/**
 * Whether a resource-server initialize() failure is a permanent misconfiguration.
 *
 * Transient facilitator timeouts stay retryable on the next protected request.
 * Capability and route mismatches will not become valid later and must not
 * leave the process listening.
 *
 * @param error - The initialize() rejection reason
 * @returns True when the process should exit rather than retry
 */
export function isFatalStartupInitError(error: unknown): boolean {
  return error instanceof FacilitatorCapabilityError || error instanceof RouteConfigurationError;
}

/**
 * Attaches a handler to the eager initialize() promise started by HTTP adapters.
 *
 * Retryable failures are swallowed so they are not unhandled rejections; the
 * original promise is still awaited on the first protected request. Fatal
 * configuration errors exit the process immediately.
 *
 * @param initPromise - The in-flight initialize() promise, or null when unused
 */
export function attachBackgroundInitHandler(initPromise: Promise<void> | null): void {
  void initPromise?.catch(error => {
    if (!isFatalStartupInitError(error)) return;
    console.error(error);
    process.exit(1);
  });
}
