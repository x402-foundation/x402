import { catalogRoutes, servedNetworks } from "./catalog";
import { FAMILY_DISPLAY_NAME, type ProtocolFamily } from "../../src/networks/networks";
import {
  buildUnconfiguredFamilyError,
  isFamilyConfigured,
  type ServerEnvConfig,
} from "../../src/server-env";
import { CLOSE_PATH, HEALTH_PATH, PROTECTED_ROUTE_MESSAGE } from "../../src/mechanisms";

export { CLOSE_PATH, HEALTH_PATH } from "../../src/mechanisms";

export type E2eRouteDef = {
  path: string;
  network: ProtocolFamily;
  response: () => Record<string, unknown>;
  settlementOverride?: { amount: string };
};

/** GET handlers to mount, derived from config/mechanisms.json. */
export const E2E_GET_ROUTES: E2eRouteDef[] = catalogRoutes().map(route => ({
  path: route.path,
  network: route.network,
  response: () => ({
    message: PROTECTED_ROUTE_MESSAGE,
    timestamp: new Date().toISOString(),
  }),
  ...(route.settlementOverride ? { settlementOverride: route.settlementOverride } : {}),
}));

const E2E_GET_ROUTE_BY_PATH = new Map(E2E_GET_ROUTES.map(route => [route.path, route]));

/** Returns a 501 payload when `path` is a protected route whose network is not configured. */
export function getUnconfiguredResponseForPath(
  path: string,
  cfg: ServerEnvConfig,
): { error: string; message: string } | null {
  const route = E2E_GET_ROUTE_BY_PATH.get(path);
  if (!route) {
    return null;
  }
  if (isFamilyConfigured(cfg, route.network)) {
    return null;
  }
  return buildUnconfiguredFamilyError(route.network);
}

export function buildHealthResponse(cfg: ServerEnvConfig): Record<string, unknown> {
  return {
    status: "ok",
    version: "2.0.0",
    networks: Object.fromEntries(
      servedNetworks(cfg).map(served => [served.id, { network: served.network, payee: served.payTo }]),
    ),
  };
}

export function buildCloseResponse(): Record<string, unknown> {
  return { message: "Server shutting down gracefully" };
}

export function formatStartupBanner(
  cfg: ServerEnvConfig,
  options: { title: string; address: string },
): string {
  const body: string[] = [`Server:  ${options.address}`];

  for (const served of servedNetworks(cfg)) {
    body.push(
      `${FAMILY_DISPLAY_NAME[served.id as ProtocolFamily]}: ${served.network} → ${served.payTo}`,
    );
  }

  body.push("", "Endpoints:");
  for (const route of E2E_GET_ROUTES) {
    body.push(`  • GET  ${route.path}  (${FAMILY_DISPLAY_NAME[route.network]})`);
  }
  body.push(`  • GET  ${HEALTH_PATH}  (no payment required)`);
  body.push(`  • POST ${CLOSE_PATH}  (shutdown server)`);

  const width = Math.max(options.title.length, ...body.map(entry => entry.length)) + 4;
  const pad = (content: string) => `║ ${content.padEnd(width - 2)} ║`;
  const rule = (left: string, right: string) => `${left}${"═".repeat(width)}${right}`;

  return [
    "",
    rule("╔", "╗"),
    pad(options.title),
    rule("╠", "╣"),
    ...body.map(pad),
    rule("╚", "╝"),
    // The harness waits for this line before it starts polling /health.
    `Server listening on ${options.address}`,
    "",
  ].join("\n");
}
