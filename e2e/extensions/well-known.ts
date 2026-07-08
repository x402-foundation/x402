/**
 * Well-Known Discovery (/.well-known/x402.json) Validation for E2E Tests
 *
 * Validates that a running server which uses the x402 HTTP middleware auto-serves
 * a per-origin discovery manifest with the optimized shape:
 *   { x402Version, lastUpdated?, items: [{ resource:{url,…}, type, accepts, input, output?, requires? }] }
 *
 * Servers that don't implement the route (e.g. non-TS stacks, or adapters that
 * haven't wired it yet) return 404 and are SKIPPED — not failed. A served-but-
 * malformed manifest is a failure.
 *
 * Unlike bazaar discovery (validated against the persistent facilitator catalog),
 * this route lives on the server itself, so it must be checked while the server
 * is running — `validateServerWellKnown` is called right after a server becomes
 * healthy in the test loop.
 */

import { log, verboseLog, errorLog } from "../src/logger";

const WELL_KNOWN_PATH = "/.well-known/x402.json";

type WellKnownStatus = "pass" | "skip" | "fail";

interface WellKnownResult {
  serverName: string;
  port: number;
  status: WellKnownStatus;
  itemCount?: number;
  error?: string;
}

// Dedup by serverName: each server implementation is checked once even though
// it runs across many concurrent server+facilitator combos.
const results = new Map<string, WellKnownResult>();
const inProgress = new Set<string>();

/**
 * Narrow an unknown value to a plain object.
 *
 * @param value - The value to test.
 * @returns True if `value` is a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a single manifest item against the optimized shape.
 *
 * @param item - The item to validate.
 * @param index - The item's index (for error messages).
 * @returns An error string, or null when valid.
 */
function validateItem(item: unknown, index: number): string | null {
  if (!isObject(item)) return `items[${index}] is not an object`;
  if (!isObject(item.resource) || typeof item.resource.url !== "string") {
    return `items[${index}].resource must be an object with a string url`;
  }
  if (typeof item.type !== "string") return `items[${index}].type must be a string`;
  if (!Array.isArray(item.accepts)) return `items[${index}].accepts must be an array`;
  if (!isObject(item.input)) return `items[${index}].input must be an object`;
  if (item.input.method !== undefined && typeof item.input.method !== "string") {
    return `items[${index}].input.method must be a string when present`;
  }
  // Optimized-shape invariants: no per-item version, no full extension payloads.
  if ("x402Version" in item) return `items[${index}] must not carry a per-item x402Version`;
  if ("extensions" in item) return `items[${index}] must not carry full extension payloads`;
  if (item.output !== undefined && !isObject(item.output)) {
    return `items[${index}].output must be an object when present`;
  }
  if (item.requires !== undefined && !Array.isArray(item.requires)) {
    return `items[${index}].requires must be an array when present`;
  }
  return null;
}

/**
 * Validate the manifest envelope and all items.
 *
 * @param data - The parsed manifest body.
 * @returns An error string, or null when valid.
 */
function validateManifest(data: unknown): string | null {
  if (!isObject(data)) return "manifest is not an object";
  if (data.x402Version !== 2) return "manifest.x402Version must be 2";
  if (data.lastUpdated !== undefined && typeof data.lastUpdated !== "number") {
    return "manifest.lastUpdated must be a number when present";
  }
  if (!Array.isArray(data.items)) return "manifest.items must be an array";
  for (let i = 0; i < data.items.length; i++) {
    const err = validateItem(data.items[i], i);
    if (err) return err;
  }
  return null;
}

/**
 * Fetch and validate a running server's `/.well-known/x402.json`. Dedups so each
 * server implementation is checked once. A 404 is treated as "not implemented"
 * (skip); a served-but-malformed manifest is a failure.
 *
 * @param serverName - The server implementation name (e.g. "express").
 * @param port - The port the running server is listening on.
 */
export async function validateServerWellKnown(serverName: string, port: number): Promise<void> {
  if (results.has(serverName) || inProgress.has(serverName)) return;
  inProgress.add(serverName);

  const url = `http://localhost:${port}${WELL_KNOWN_PATH}`;
  verboseLog(`  🔎 Checking well-known manifest: ${url}`);
  try {
    const response = await fetch(url);

    if (response.status === 404) {
      verboseLog(`  ⏭️  ${serverName}: no ${WELL_KNOWN_PATH} (not implemented), skipping`);
      results.set(serverName, { serverName, port, status: "skip" });
      return;
    }
    if (!response.ok) {
      results.set(serverName, {
        serverName,
        port,
        status: "fail",
        error: `${response.status} ${response.statusText}`,
      });
      return;
    }

    const data: unknown = await response.json();
    const err = validateManifest(data);
    if (err) {
      errorLog(`  ❌ ${serverName}: invalid manifest — ${err}`);
      results.set(serverName, { serverName, port, status: "fail", error: err });
      return;
    }

    const itemCount = isObject(data) && Array.isArray(data.items) ? data.items.length : 0;
    verboseLog(`  ✅ ${serverName}: valid well-known manifest (${itemCount} item(s))`);
    results.set(serverName, { serverName, port, status: "pass", itemCount });
  } catch (error) {
    results.set(serverName, {
      serverName,
      port,
      status: "fail",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inProgress.delete(serverName);
  }
}

/**
 * Whether any server produced a well-known result (so a summary is worth printing).
 *
 * @returns True if at least one server was checked.
 */
export function hasWellKnownResults(): boolean {
  return results.size > 0;
}

/**
 * Print a summary of well-known validation results.
 *
 * @returns True if no server served an invalid manifest (passes/skips are OK).
 */
export function summarizeWellKnown(): boolean {
  const all = Array.from(results.values());
  const passed = all.filter(r => r.status === "pass");
  const skipped = all.filter(r => r.status === "skip");
  const failed = all.filter(r => r.status === "fail");

  log("\n═══════════════════════════════════════════════════════");
  log("        Well-Known Discovery (/.well-known/x402.json)");
  log("═══════════════════════════════════════════════════════");
  log(
    `Servers checked: ${all.length}  ·  passed: ${passed.length}  ·  skipped: ${skipped.length}  ·  failed: ${failed.length}`,
  );
  for (const r of passed) log(`  ✅ ${r.serverName}: ${r.itemCount ?? 0} item(s)`);
  for (const r of skipped) verboseLog(`  ⏭️  ${r.serverName}: not implemented`);
  for (const r of failed) errorLog(`  ❌ ${r.serverName}: ${r.error}`);

  const success = failed.length === 0;
  log(success ? "✅ Well-Known Validation: PASSED" : "❌ Well-Known Validation: FAILED");
  log("═══════════════════════════════════════════════════════\n");
  return success;
}
