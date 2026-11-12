import { PaywallProvider, x402HTTPResourceServer } from "./x402HTTPResourceServer";
import { attachBackgroundInitHandler } from "./backgroundInit";

/**
 * An HTTP resource server paired with its deferred facilitator initialization.
 */
export interface PreparedHttpServer {
  httpServer: x402HTTPResourceServer;

  /**
   * Initializes the facilitator once. A rejection leaves the next call free to retry.
   *
   * @returns Resolves after initialization succeeds
   */
  init: () => Promise<void>;
}

/**
 * Registers an optional paywall and wires facilitator initialization.
 *
 * A retryable failure is retried on the next `init()` call. A fatal error from
 * the startup `initialize()` call exits the process.
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

  let initPromise: Promise<void> | null = syncFacilitatorOnStart ? httpServer.initialize() : null;
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
