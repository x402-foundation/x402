import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Locate e2e/config (harness-injected or walk up from this file). */
function catalogDir(): string {
  const injected = process.env.E2E_MECHANISMS_CATALOG;
  if (injected && existsSync(join(injected, "mechanisms_global.json"))) {
    return injected;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "config");
    if (existsSync(join(candidate, "mechanisms_global.json"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate e2e/config/mechanisms_global.json");
    }
    dir = parent;
  }
}

/** Prefer `${ID}_NETWORK`, else catalog testnet CAIP-2. */
export function resolveNetworkCaip2(networkId: string): string {
  const fromEnv = process.env[`${networkId.toUpperCase()}_NETWORK`];
  if (fromEnv) return fromEnv;
  const path = join(catalogDir(), `mechanisms_${networkId}.json`);
  const data = JSON.parse(readFileSync(path, "utf-8")) as {
    testnet: { caip2: string };
  };
  return data.testnet.caip2;
}

/** Derive a CAIP-2 namespace wildcard (`eip155:*`) from a concrete CAIP-2 id. */
export function caip2Pattern(caip2: string): `${string}:*` {
  const ns = caip2.split(":")[0];
  if (!ns) {
    throw new Error(`invalid caip2: ${caip2}`);
  }
  return `${ns}:*`;
}

/** Client/resource-server registration pattern for a catalog network id. */
export function networkCaip2Pattern(networkId: string): `${string}:*` {
  return caip2Pattern(resolveNetworkCaip2(networkId));
}

/** Network ids present as `mechanisms_<id>.json` (excludes global). */
export function catalogNetworkIds(): string[] {
  return readdirSync(catalogDir())
    .filter(name => /^mechanisms_.+\.json$/.test(name) && name !== "mechanisms_global.json")
    .map(name => name.replace(/^mechanisms_/, "").replace(/\.json$/, ""))
    .sort();
}
