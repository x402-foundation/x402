import { PaywallProvider, x402HTTPResourceServer } from "./x402HTTPResourceServer";
import { attachBackgroundInitHandler } from "./backgroundInit";

/**
 * An HTTP resource server paired with its deferred facilitator initialization.
 */
export interface PreparedHttpServer {
  httpServer: x402HTTPResourceServer;

  /**
   * Initializes the facilitator once, retrying after a failure.
   *
   * @returns Resolves once the server has initialized
   */
  init: () => Promise<void>;
}

/**
 * Registers the paywall provider and wires up facilitator initialization.
 *
 * The first protected request initializes the server. A retryable failure (for example a
 * facilitator timeout) is retried on the next protected request; a fatal capability or
 * route mismatch exits the process instead of leaving a misconfigured server listening.
 *
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywall - Optional paywall provider for custom payment UI
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on start (defaults to true)
 * @returns The HTTP server instance with its initialization function
 */
export function prepareHttpServer(
  httpServer: x402HTTPResourceServer,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart: boolean = true,
): PreparedHttpServer {
  if (paywall) {
    httpServer.registerPaywallProvider(paywall);
  }

  // Store the promise rather than its result: initialize() fetches facilitator support and
  // validates routes, and every protected request must observe a retryable failure.
  let initPromise: Promise<void> | null = syncFacilitatorOnStart ? httpServer.initialize() : null;
  // Retryable failures (e.g. a facilitator timeout) must not become unhandled rejections;
  // the original promise is still awaited on the first protected request.
  attachBackgroundInitHandler(initPromise);
  let isInitialized = false;

  return {
    httpServer,
    async init() {
      if (!syncFacilitatorOnStart || isInitialized) {
        return;
      }

      if (!initPromise) {
        initPromise = httpServer.initialize();
      }

      try {
        await initPromise;
        isInitialized = true;
      } catch (error) {
        initPromise = null;
        throw error;
      }
    },
  };
}
