/**
 * Bridges the mechanisms catalog to the TypeScript e2e resource servers.
 *
 * Everything the express/hono/fastify servers mount comes from here, so adding a
 * mechanism means adding a catalog entry rather than editing each framework.
 */
import {
  CLOSE_PATH,
  HEALTH_PATH,
  filterRoutes,
  resolvePaymentRoutes,
  routeFilterFromEnv,
  sdkRoutesFor,
  type ResolvedRoute,
  type SdkRoute,
} from "../../src/mechanisms";
import type { ServerEnvConfig } from "../../src/server-env";

export { CLOSE_PATH, HEALTH_PATH } from "../../src/mechanisms";
export type { ResolvedRoute, SdkRoute } from "../../src/mechanisms";

const SDK = "typescript";

const routeFilter = routeFilterFromEnv(key => process.env[key]);

/**
 * Routes this server mounts handlers for, including networks that have no payee
 * configured — those answer 501 via {@link getUnconfiguredResponseForPath}.
 */
export function catalogRoutes(): SdkRoute[] {
  return filterRoutes(sdkRoutesFor(SDK), routeFilter);
}

/** Catalog routes with env-dependent payment requirements resolved. */
export function resolvedRoutes(cfg: ServerEnvConfig): ResolvedRoute[] {
  const env = (key: string): string | undefined =>
    (cfg as unknown as Record<string, string | undefined>)[key] ?? process.env[key];
  return resolvePaymentRoutes(SDK, env, routeFilter);
}

export type ServedNetwork = {
  id: string;
  network: string;
  payTo: string;
};

/** Networks this server actually serves, in catalog order — for banners/health. */
export function servedNetworks(cfg: ServerEnvConfig): ServedNetwork[] {
  const served = new Map<string, ServedNetwork>();
  for (const route of resolvedRoutes(cfg)) {
    if (!served.has(route.networkId)) {
      served.set(route.networkId, {
        id: route.networkId,
        network: route.network,
        payTo: route.payTo,
      });
    }
  }
  return Array.from(served.values());
}
