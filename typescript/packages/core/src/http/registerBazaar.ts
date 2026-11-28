import type { ResourceServerExtension } from "../types/extensions";
import type { RoutesConfig, x402HTTPResourceServer } from "./x402HTTPResourceServer";

/**
 * The parts of `@x402/extensions/bazaar` used at middleware startup.
 */
export interface BazaarStartupModule {
  bazaarResourceServerExtension: ResourceServerExtension;
  validateBazaarRouteExtensions: (routes: RoutesConfig) => void;
}

/**
 * Registers the bazaar extension unless one is already registered, then validates
 * the routes' bazaar declarations. Load failures are logged, not thrown.
 *
 * `loadBazaar` is passed by the caller so the `import("@x402/extensions/bazaar")`
 * stays in the middleware package that depends on `@x402/extensions`.
 *
 * @param httpServer - The HTTP resource server whose routes declare bazaar extensions
 * @param loadBazaar - Loads `@x402/extensions/bazaar`
 * @returns Resolves once registration and validation have finished
 */
export function registerBazaar(
  httpServer: x402HTTPResourceServer,
  loadBazaar: () => Promise<BazaarStartupModule>,
): Promise<void> {
  const registered = httpServer.server.hasExtension("bazaar")
    ? Promise.resolve()
    : loadBazaar().then(({ bazaarResourceServerExtension }) => {
        httpServer.server.registerExtension(bazaarResourceServerExtension);
      });

  return registered
    .then(loadBazaar)
    .then(({ validateBazaarRouteExtensions }) => {
      validateBazaarRouteExtensions(httpServer.routes);
    })
    .catch(err => {
      console.error("Failed to load bazaar extension:", err);
    });
}
