import type { Cip30WalletApi } from "@x402/cardano";

/** The CIP-30 API after `enable()`, including the read methods the page uses. */
export interface FullCip30Api extends Cip30WalletApi {
  getNetworkId(): Promise<number>;
  getBalance(): Promise<string>;
}

/** A wallet entry injected under `window.cardano`. */
export interface Cip30Provider {
  name?: string;
  icon?: string;
  apiVersion?: string;
  enable(): Promise<FullCip30Api>;
}

/** A wallet the page can offer. */
export interface DiscoveredWallet {
  key: string;
  name: string;
  icon?: string;
  provider: Cip30Provider;
}

/** Wallets shown first, in this order; everything else follows by name. */
export const PREFERRED_WALLET_KEYS = ["lace", "eternl", "vespr", "typhoncip30", "yoroi"];

/**
 * Lists the CIP-30 wallets injected under `window.cardano`, preferred ones
 * first, without duplicates (some wallets register under two keys).
 *
 * @param cardano - The `window.cardano` object.
 * @returns Wallets that expose `enable()`.
 */
export function discoverCip30Wallets(cardano: unknown): DiscoveredWallet[] {
  if (typeof cardano !== "object" || cardano === null) return [];
  const found: DiscoveredWallet[] = [];
  const seenNames = new Set<string>();
  for (const [key, value] of Object.entries(cardano as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const provider = value as Cip30Provider;
    if (typeof provider.enable !== "function") continue;
    const name =
      typeof provider.name === "string" && provider.name.trim() ? provider.name.trim() : key;
    const icon =
      typeof provider.icon === "string" && provider.icon.startsWith("data:image/")
        ? provider.icon
        : undefined;
    found.push({ key, name, icon, provider });
  }
  const rank = (key: string): number => {
    const index = PREFERRED_WALLET_KEYS.indexOf(key.toLowerCase());
    return index === -1 ? PREFERRED_WALLET_KEYS.length : index;
  };
  found.sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name));
  return found.filter(wallet => {
    const id = wallet.name.toLowerCase();
    if (seenNames.has(id)) return false;
    seenNames.add(id);
    return true;
  });
}

/**
 * Waits briefly for wallets to inject themselves (they often do so after the
 * page's load event).
 *
 * @param getCardano - Reads `window.cardano`.
 * @param options - Timeout, poll interval and sleep (tests).
 * @param options.timeoutMs - Total wait. Default 2000.
 * @param options.intervalMs - Poll interval. Default 200.
 * @param options.sleep - Sleep implementation.
 * @returns The wallets found (possibly none).
 */
export async function waitForCip30Wallets(
  getCardano: () => unknown,
  options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DiscoveredWallet[]> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 200;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let waited = 0; ; waited += intervalMs) {
    const wallets = discoverCip30Wallets(getCardano());
    if (wallets.length > 0 || waited >= timeoutMs) return wallets;
    await sleep(intervalMs);
  }
}
