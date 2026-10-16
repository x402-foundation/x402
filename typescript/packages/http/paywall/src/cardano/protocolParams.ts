/**
 * Server-side protocol parameters for the Cardano paywall.
 *
 * Koios public (keyless) APIs are CORS-restricted, so a browser cannot read
 * them. The paywall handler fetches `epoch_params` on the server instead,
 * caches it, and injects it into the page. This module must not import
 * `@x402/cardano` or the Evolution SDK: it runs in the resource server's Node
 * process, where those packages are not runtime dependencies of the paywall.
 */

/** Koios public API base URLs per canonical network. */
export const KOIOS_PUBLIC_BASE_URLS: Readonly<Record<string, string>> = {
  "cardano:mainnet": "https://api.koios.rest/api/v1",
  "cardano:preprod": "https://preprod.koios.rest/api/v1",
  "cardano:preview": "https://preview.koios.rest/api/v1",
};

/** CIP-34 aliases accepted for the canonical networks (mirrors `@x402/cardano`). */
export const CARDANO_CIP34_ALIASES: Readonly<Record<string, string>> = {
  "cip34:1-764824073": "cardano:mainnet",
  "cip34:0-1": "cardano:preprod",
  "cip34:0-2": "cardano:preview",
};

/**
 * Bounds the server applies before injecting. They mirror
 * `CIP30_PROTOCOL_PARAMETER_BOUNDS` in `@x402/cardano` (a test keeps them in
 * sync); only the page's own check is authoritative.
 */
export const INJECTED_PARAMETER_BOUNDS = {
  minFeeA: { min: 22, max: 88 },
  minFeeB: { min: 77_690, max: 310_762 },
  coinsPerUtxoByte: { min: 2_155, max: 8_620 },
  maxTxSize: { min: 8_192, max: 65_536 },
  maxValSize: { min: 4_000, max: 20_000 },
  minFeeRefScriptCostPerByte: { min: 0, max: 1_000 },
  priceMem: { min: 0, max: 1 },
  priceStep: { min: 0, max: 1 },
} as const;

/**
 * JSON-safe protocol parameters injected into the page. Big integers travel as
 * decimal strings; the page converts them back.
 */
export interface InjectedProtocolParameters {
  epochNo: number;
  fetchedAtMs: number;
  minFeeA: number;
  minFeeB: number;
  maxTxSize: number;
  maxValSize: number;
  keyDeposit: string;
  poolDeposit: string;
  drepDeposit: string;
  govActionDeposit: string;
  priceMem: number;
  priceStep: number;
  maxTxExMem: string;
  maxTxExSteps: string;
  coinsPerUtxoByte: string;
  collateralPercentage: number;
  maxCollateralInputs: number;
  minFeeRefScriptCostPerByte: number;
  costModels: { PlutusV1: number[]; PlutusV2: number[]; PlutusV3: number[] };
}

/** Options for {@link KoiosProtocolParamsCache}. */
export interface KoiosProtocolParamsOptions {
  /** Override base URLs per canonical network (e.g. a self-hosted Koios). */
  koiosBaseUrls?: Partial<Record<string, string>>;
  /** Koios Free-tier token. Sent from the server only; never injected into a page. */
  koiosToken?: string;
  /** How long a fetched value is fresh. Default 15 minutes. */
  cacheTtlMs?: number;
  /** Oldest value still served while a refresh runs. Default 24 hours. */
  maxStaleMs?: number;
  /** Per-request timeout. Default 5 seconds. */
  requestTimeoutMs?: number;
  /** Fetch implementation (e.g. one that goes through a proxy). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Maps an x402 network id to its canonical `cardano:*` form.
 *
 * @param network - `cardano:*` or a CIP-34 alias.
 * @returns The canonical id, or undefined when unknown.
 */
export function canonicalCardanoNetwork(network: string): string | undefined {
  const lower = network.toLowerCase();
  if (KOIOS_PUBLIC_BASE_URLS[lower]) return lower;
  return CARDANO_CIP34_ALIASES[lower];
}

/**
 * Reads a non-negative integer that Koios may send as number or string.
 *
 * @param value - Raw field.
 * @returns The integer as a decimal string, or undefined.
 */
function intString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  return undefined;
}

/**
 * Reads a finite number that Koios may send as number or numeric string.
 *
 * @param value - Raw field.
 * @returns The number, or undefined.
 */
function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Reads a Koios cost model array.
 *
 * @param value - Raw field.
 * @returns The array, or undefined if it is not a list of finite integers.
 */
function costModel(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every(v => typeof v === "number" && Number.isInteger(v))
    ? (value as number[])
    : undefined;
}

/**
 * Maps one Koios `epoch_params` row to injected parameters, mirroring the
 * Evolution SDK's own Koios mapping. Returns undefined for a malformed row or
 * one outside {@link INJECTED_PARAMETER_BOUNDS}.
 *
 * @param row - One element of the Koios response array.
 * @param fetchedAtMs - When it was fetched.
 * @returns Injected parameters, or undefined.
 */
export function mapKoiosEpochParams(
  row: unknown,
  fetchedAtMs: number,
): InjectedProtocolParameters | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const r = row as Record<string, unknown>;
  const models = (r.cost_models ?? {}) as Record<string, unknown>;
  const mapped = {
    epochNo: finiteNumber(r.epoch_no),
    fetchedAtMs,
    minFeeA: finiteNumber(r.min_fee_a),
    minFeeB: finiteNumber(r.min_fee_b),
    maxTxSize: finiteNumber(r.max_tx_size),
    maxValSize: finiteNumber(r.max_val_size),
    keyDeposit: intString(r.key_deposit),
    poolDeposit: intString(r.pool_deposit),
    drepDeposit: intString(r.drep_deposit),
    govActionDeposit: intString(r.gov_action_deposit),
    priceMem: finiteNumber(r.price_mem),
    priceStep: finiteNumber(r.price_step),
    maxTxExMem: intString(r.max_tx_ex_mem),
    maxTxExSteps: intString(r.max_tx_ex_steps),
    coinsPerUtxoByte: intString(r.coins_per_utxo_size),
    collateralPercentage: finiteNumber(r.collateral_percent),
    maxCollateralInputs: finiteNumber(r.max_collateral_inputs),
    minFeeRefScriptCostPerByte: finiteNumber(r.min_fee_ref_script_cost_per_byte),
    costModels: {
      PlutusV1: costModel(models.PlutusV1),
      PlutusV2: costModel(models.PlutusV2),
      PlutusV3: costModel(models.PlutusV3),
    },
  };
  for (const [key, value] of Object.entries(mapped)) {
    if (value === undefined) return undefined;
    if (key === "costModels" && Object.values(value as object).some(v => v === undefined)) {
      return undefined;
    }
  }
  const result = mapped as InjectedProtocolParameters;
  for (const [field, bound] of Object.entries(INJECTED_PARAMETER_BOUNDS)) {
    const value = Number((result as unknown as Record<string, number | string>)[field]);
    if (!(value >= bound.min && value <= bound.max)) return undefined;
  }
  return result;
}

/** One cached network entry. */
interface CacheEntry {
  value: InjectedProtocolParameters;
  fetchedAtMs: number;
}

/**
 * In-process cache of Koios protocol parameters with stale-while-revalidate,
 * de-duplicated refreshes and a hard maximum age.
 */
export class KoiosProtocolParamsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly lastErrorLoggedAt = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxStaleMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  /**
   * Creates a cache.
   *
   * @param options - URLs, token, timings and injectables.
   */
  constructor(private readonly options: KoiosProtocolParamsOptions = {}) {
    this.ttlMs = options.cacheTtlMs ?? 15 * 60_000;
    this.maxStaleMs = options.maxStaleMs ?? 24 * 60 * 60_000;
    this.timeoutMs = options.requestTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns the cached parameters for a network, starting a refresh when they
   * are missing or older than the TTL. Never blocks.
   *
   * @param network - `cardano:*` or CIP-34 alias.
   * @returns Parameters no older than `maxStaleMs`, or null.
   */
  get(network: string): InjectedProtocolParameters | null {
    const canonical = canonicalCardanoNetwork(network);
    if (!canonical) return null;
    const entry = this.entries.get(canonical);
    const age = entry ? this.now() - entry.fetchedAtMs : Infinity;
    if (age > this.ttlMs) void this.refresh(canonical);
    return entry && age <= this.maxStaleMs ? entry.value : null;
  }

  /**
   * Fetches parameters now (e.g. at server start) so the first visitor is not
   * served a cold page.
   *
   * @param networks - Networks to warm; defaults to all three.
   * @returns Resolves when every refresh settled (failures are logged).
   */
  async prefetch(networks: string[] = Object.keys(KOIOS_PUBLIC_BASE_URLS)): Promise<void> {
    await Promise.all(
      networks
        .map(canonicalCardanoNetwork)
        .filter((n): n is string => n !== undefined)
        .map(n => this.refresh(n)),
    );
  }

  /**
   * Refreshes one network, sharing an in-flight request.
   *
   * @param network - Canonical network id.
   * @returns Resolves when the refresh settled.
   */
  private refresh(network: string): Promise<void> {
    const running = this.inFlight.get(network);
    if (running) return running;
    const task = this.fetchOnce(network)
      .then(value => {
        this.entries.set(network, { value, fetchedAtMs: value.fetchedAtMs });
      })
      .catch(error => {
        const last = this.lastErrorLoggedAt.get(network) ?? -Infinity;
        if (this.now() - last >= this.ttlMs) {
          this.lastErrorLoggedAt.set(network, this.now());
          console.warn(
            `[x402 cardano paywall] Koios protocol parameters unavailable for ${network}:`,
            error,
          );
        }
      })
      .finally(() => {
        this.inFlight.delete(network);
      });
    this.inFlight.set(network, task);
    return task;
  }

  /**
   * Performs one Koios request.
   *
   * @param network - Canonical network id.
   * @returns Mapped, bounded parameters.
   */
  private async fetchOnce(network: string): Promise<InjectedProtocolParameters> {
    const base = this.options.koiosBaseUrls?.[network] ?? KOIOS_PUBLIC_BASE_URLS[network];
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.options.koiosToken) headers.Authorization = `Bearer ${this.options.koiosToken}`;
    const response = await fetchImpl(`${base}/epoch_params?limit=1&order=epoch_no.desc`, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Koios responded ${response.status}`);
    const body = (await response.json()) as unknown;
    const row = Array.isArray(body) ? body[0] : undefined;
    const mapped = mapKoiosEpochParams(row, this.now());
    if (!mapped) throw new Error("Koios epoch_params response was malformed or out of bounds");
    return mapped;
  }
}
