import { x402ResourceServer } from "@x402/core/server";

import { loadServerEnv } from "../../config";
import { createResourceServer } from "./lib/setup";

let resourceServerPromise: Promise<x402ResourceServer> | undefined;

/** Shared resource server for withX402 route modules (initialized on first use). */
export function getServer(): Promise<x402ResourceServer> {
  if (!resourceServerPromise) {
    resourceServerPromise = (async () => {
      const cfg = loadServerEnv();
      const server = await createResourceServer(cfg);
      console.log(`Using remote facilitator at: ${cfg.facilitatorUrl}`);
      return server;
    })();
  }
  return resourceServerPromise;
}
