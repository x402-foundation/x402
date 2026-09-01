import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import {
  SETTLEMENT_OVERRIDES_HEADER,
  x402ResourceServer,
  type RouteConfig,
} from "@x402/core/server";

import { PROTECTED_ROUTE_MESSAGE, nextWithX402HttpPath } from "../../../../../src/mechanisms";
import {
  buildUnconfiguredFamilyError,
  loadServerEnv,
  type ServerEnvConfig,
} from "../../../../../src/server-env";
import { catalogRoutes, resolvedRoutes } from "../../../catalog";
import {
  buildResolvedRouteConfig,
  configureResourceServer,
  createFacilitatorClients,
} from "../../../config";

export async function createResourceServer(cfg: ServerEnvConfig): Promise<x402ResourceServer> {
  const server = new x402ResourceServer(createFacilitatorClients(cfg.facilitatorUrl));
  await configureResourceServer(server, cfg);
  return server;
}

export function buildWithX402RouteConfig(
  catalogPath: string,
  cfg: ServerEnvConfig,
): RouteConfig | null {
  const route = resolvedRoutes(cfg).find(entry => entry.path === catalogPath);
  if (!route) {
    return null;
  }
  return buildResolvedRouteConfig(route) as unknown as RouteConfig;
}

function buildWithX402Handler(catalogPath: string, cfg: ServerEnvConfig) {
  return async (_req: NextRequest) => {
    const route = resolvedRoutes(cfg).find(entry => entry.path === catalogPath);
    const response = NextResponse.json({
      message: PROTECTED_ROUTE_MESSAGE,
      timestamp: new Date().toISOString(),
      wrapper: "withX402",
    });
    if (route?.settlementOverride) {
      response.headers.set(
        SETTLEMENT_OVERRIDES_HEADER,
        JSON.stringify(route.settlementOverride),
      );
    }
    return response;
  };
}

/** App Router GET handler for any catalog route's withX402 variant. */
export function createWithX402GetHandler(catalogPath: string, server: x402ResourceServer) {
  if (!catalogRoutes().some(route => route.path === catalogPath)) {
    throw new Error(`Unknown catalog path for withX402 route: ${catalogPath}`);
  }

  let wrapped: ((req: NextRequest) => Promise<Response>) | undefined;

  return async (req: NextRequest) => {
    const cfg = loadServerEnv();
    const routeConfig = buildWithX402RouteConfig(catalogPath, cfg);
    if (!routeConfig) {
      const catalogRoute = catalogRoutes().find(entry => entry.path === catalogPath);
      return NextResponse.json(
        catalogRoute
          ? buildUnconfiguredFamilyError(catalogRoute.network)
          : { error: "Not configured", message: "Route is not configured" },
        { status: 501 },
      );
    }

    if (!wrapped) {
      wrapped = withX402(
        buildWithX402Handler(catalogPath, cfg),
        { [nextWithX402HttpPath(catalogPath)]: routeConfig },
        server,
      );
    }
    return wrapped(req);
  };
}

export function isKnownCatalogPath(catalogPath: string): boolean {
  return catalogRoutes().some(route => route.path === catalogPath);
}
