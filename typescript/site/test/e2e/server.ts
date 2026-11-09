import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://localhost:${PORT}`;

const READY_PATH = "/protected";
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;

// `next dev` rewrites this file in place (reformatting it and appending a dev-server
// type-check include entry) as a side effect of starting up — completely unrelated to
// the route handlers under test. Snapshot and restore it so `pnpm test:e2e` never
// leaves a stray tsconfig.json diff behind.
const TSCONFIG_PATH = join(process.cwd(), "tsconfig.json");

let serverProcess: ChildProcess | undefined;
let tsconfigSnapshot: string | undefined;

/**
 * Starts the site's own Next.js dev server on a dedicated port (distinct from the
 * default 3000, so this doesn't collide with a developer's own `pnpm dev`) and waits
 * for it to respond, so the e2e suite is self-contained — no need to have the site
 * already running. Uses `next dev`, not a production build: a real production build
 * isn't needed to exercise the route handlers under test, and Turbopack's
 * compile-on-first-request cost is paid once, during the readiness poll below.
 *
 * @returns The server's base URL
 */
export async function startTestServer(): Promise<string> {
  tsconfigSnapshot = readFileSync(TSCONFIG_PATH, "utf-8");

  const nextBin = join(process.cwd(), "node_modules/.bin/next");
  const facilitatorUrl = `${E2E_BASE_URL}/facilitator`;
  serverProcess = spawn(nextBin, ["dev", "-p", String(PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // The route handlers call this app's own /facilitator route to verify/settle
      // payments; .env's default points at port 3000, which isn't this dedicated
      // test port, so override it to match wherever this server actually listens.
      FACILITATOR_URL: facilitatorUrl,
      NEXT_PUBLIC_FACILITATOR_URL: facilitatorUrl,
    },
  });

  // Surface server-side errors (e.g. a missing required env var) instead of letting
  // the readiness poll below time out with no explanation.
  let startupOutput = "";
  serverProcess.stdout?.on("data", chunk => (startupOutput += String(chunk)));
  serverProcess.stderr?.on("data", chunk => (startupOutput += String(chunk)));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${E2E_BASE_URL}${READY_PATH}`);
      return E2E_BASE_URL;
    } catch {
      await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
  }

  await stopTestServer();
  throw new Error(
    `Site did not become ready on ${E2E_BASE_URL} within ${READY_TIMEOUT_MS}ms. ` +
      `Server output:\n${startupOutput}`,
  );
}

/**
 * Stops the server started by {@link startTestServer}, if any.
 *
 * @returns A promise that resolves once the process has exited
 */
export async function stopTestServer(): Promise<void> {
  if (tsconfigSnapshot !== undefined) {
    writeFileSync(TSCONFIG_PATH, tsconfigSnapshot);
    tsconfigSnapshot = undefined;
  }

  const proc = serverProcess;
  if (!proc) return;
  serverProcess = undefined;

  await new Promise<void>(resolve => {
    proc.once("exit", () => resolve());
    proc.kill();
  });
}
