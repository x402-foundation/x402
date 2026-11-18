/**
 * Scan / registry reads for the exact-scheme client and merchant setup — the
 * subset that resolves a transfer factory (client prepare), reads a merchant's
 * TransferPreapproval and its expiry, and reads the AmuletRules and mining rounds
 * a preapproval is created or renewed against (merchant onboarding).
 *
 * Amulet (Canton Coin) reads route to the SV Scan; a non-Amulet CIP-56 token
 * whose `instrumentId.admin` maps to a DA Registry Utility base URL routes there
 * instead (per-registrar path). Ported from the production
 * `@ftptech/x402-canton-ledger` Scan client; trimmed to the signer's surface.
 */
import { CantonError, type TokenProvider, type DisclosedContract } from "./client.js";

/** SV public Scan vs a validator's scan-proxy — they differ by URL prefix. */
export type ScanFlavor = "validator" | "sv";

/** Constructor options for {@link ScanClient}. */
export interface ScanClientOptions {
  scanUrl: string;
  /** SV bearer for authenticated reads; omitted for open reads. */
  token?: string | TokenProvider;
  /** Defaults to `validator`. `sv` unlocks the registry resolve endpoints. */
  flavor?: ScanFlavor;
  /** Additional SV bases to fail over to on transient errors. */
  fallbackUrls?: string[];
  /** Request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
  /** Override the fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** A merchant's live TransferPreapproval, carrying the `expiresAt` the settle
 *  gate acts on. */
export interface TransferPreapprovalRecord {
  contractId: string;
  dso: string;
  receiver: string;
  provider: string;
  expiresAt: string;
  validFrom?: string;
  lastRenewedAt?: string;
}

/** A DSO contract as Scan serves it, ready to disclose. */
export interface ScanContract<P> {
  contract_id: string;
  template_id: string;
  created_event_blob: string;
  payload: P;
}

/** The DSO's AmuletRules and the synchronizer it lives on. */
export interface AmuletRulesView {
  contract: ScanContract<{ dso: string }>;
  synchronizerId: string;
}

/** A mining round as Scan serves it. */
export type MiningRoundContract = ScanContract<{ round: { number: string }; opensAt?: string }>;

/** A resolved transfer factory plus the disclosed contracts/context needed to
 *  exercise `TransferFactory_Transfer`. */
export interface ResolvedTransferFactory {
  factoryId: string;
  transferKind: string;
  transferFactoryTemplateId: string;
  instrumentId: { admin: string; id: string };
  choiceContextData: unknown;
  disclosedContracts: DisclosedContract[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

const TRANSFER_FACTORY_TEMPLATE_ID =
  "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory";

/** True when a Scan error is transient (429 burst, 5xx, timeout, transport) and
 *  an idempotent read is safe to retry / fail over. */
function isTransientScanError(err: unknown): boolean {
  if (!(err instanceof CantonError)) return false;
  if (err.code === "TIMEOUT" || err.code === "TRANSPORT_ERROR") return true;
  return err.status === 429 || (typeof err.status === "number" && err.status >= 500);
}

/** Scan / registry client — the signer subset. */
export class ScanClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly prefix: string;
  private readonly token: string | TokenProvider | undefined;
  private readonly scanUrl: string;
  private readonly fallbackUrls: string[];
  private readonly isSv: boolean;

  /**
   * Construct a Scan / registry client.
   *
   * @param opts - Scan URL, token, flavor, and optional fallbacks/timeout/fetch.
   */
  constructor(opts: ScanClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.scanUrl = opts.scanUrl;
    this.fallbackUrls = (opts.fallbackUrls ?? []).filter(u => u && u !== opts.scanUrl);
    this.token = opts.token;
    this.isSv = (opts.flavor ?? "validator") === "sv";
    this.prefix = this.isSv ? "/api/scan/v0" : "/api/validator/v0/scan-proxy";
  }

  /**
   * Resolve a transfer factory plus its disclosed contracts and choice context,
   * for the client to exercise `TransferFactory_Transfer`. Amulet resolves on the
   * SV Scan registry root; a non-Amulet token resolves on its DA Registry Utility
   * (per-registrar path) when `registryBaseUrl` is supplied.
   *
   * @param args - sender, receiver, amount, instrument {admin,id}, the input
   *   holding cids to fund from, an optional memo, and an optional registry base.
   * @returns The resolved factory id, template id, instrument, and choice context.
   */
  async resolveTransferFactory(args: {
    sender: string;
    receiver: string;
    amount: string;
    admin: string;
    id: string;
    inputHoldingCids: string[];
    meta?: Record<string, string>;
    registryBaseUrl?: string;
  }): Promise<ResolvedTransferFactory> {
    const now = Date.now();
    const reqBody = {
      choiceArguments: {
        expectedAdmin: args.admin,
        transfer: {
          sender: args.sender,
          receiver: args.receiver,
          amount: args.amount,
          instrumentId: { admin: args.admin, id: args.id },
          requestedAt: new Date(now).toISOString(),
          executeBefore: new Date(now + 3_600_000).toISOString(),
          // FORWARD the caller's holdings — a DA Registry Utility answers 400 "No
          // holdings provided" to an empty list (the SV Scan ignores them).
          inputHoldingCids: args.inputHoldingCids,
          meta: { values: args.meta ?? {} },
        },
        extraArgs: { context: { values: {} }, meta: { values: {} } },
      },
      excludeDebugFields: true,
    };
    const path = args.registryBaseUrl
      ? `/api/token-standard/v0/registrars/${encodeURIComponent(
          args.admin,
        )}/registry/transfer-instruction/v1/transfer-factory`
      : "/registry/transfer-instruction/v1/transfer-factory";
    if (!args.registryBaseUrl && !this.isSv) {
      throw new CantonError(
        "resolveTransferFactory needs the sv Scan flavor (or a registryBaseUrl for a Registry-Utility token)",
        "UNSUPPORTED",
      );
    }
    const bases = args.registryBaseUrl
      ? [args.registryBaseUrl]
      : [this.scanUrl, ...this.fallbackUrls];
    const j = await this.requestBases<{
      factoryId: string;
      transferKind: string;
      choiceContext: { choiceContextData: unknown; disclosedContracts: DisclosedContract[] };
    }>("POST", path, reqBody, bases);
    return {
      factoryId: j.factoryId,
      transferKind: j.transferKind,
      transferFactoryTemplateId: TRANSFER_FACTORY_TEMPLATE_ID,
      instrumentId: { admin: args.admin, id: args.id },
      choiceContextData: j.choiceContext.choiceContextData,
      disclosedContracts: j.choiceContext.disclosedContracts,
    };
  }

  /**
   * Read a merchant's TransferPreapproval, or null when the party has none. The
   * contract is hosted on the MERCHANT's validator, so the participant ACS is not
   * readable to us — Scan is the network-wide public read that is. A payload
   * without `expiresAt` returns null (callers must fail closed, never assume
   * validity).
   *
   * @param party - The merchant party to read a preapproval for.
   * @returns The preapproval record, or null.
   */
  async getTransferPreapprovalByParty(party: string): Promise<TransferPreapprovalRecord | null> {
    const data = await this.get<{
      transfer_preapproval?: {
        contract?: {
          contract_id?: string;
          payload?: {
            dso?: string;
            receiver?: string;
            provider?: string;
            validFrom?: string;
            lastRenewedAt?: string;
            expiresAt?: string;
          };
        };
      } | null;
    }>(`${this.prefix}/transfer-preapprovals/by-party/${encodeURIComponent(party)}`);
    const contract = data.transfer_preapproval?.contract;
    const payload = contract?.payload;
    if (!contract?.contract_id || !payload?.expiresAt) return null;
    return {
      contractId: contract.contract_id,
      dso: payload.dso ?? "",
      receiver: payload.receiver ?? "",
      provider: payload.provider ?? "",
      expiresAt: payload.expiresAt,
      ...(payload.validFrom !== undefined ? { validFrom: payload.validFrom } : {}),
      ...(payload.lastRenewedAt !== undefined ? { lastRenewedAt: payload.lastRenewedAt } : {}),
    };
  }

  /**
   * The DSO's current AmuletRules contract, with its synchronizer. SV Scan serves
   * it on POST wrapped as `amulet_rules_update`; a validator's scan-proxy on GET.
   *
   * @returns The AmuletRules contract and synchronizer id.
   */
  async getAmuletRules(): Promise<AmuletRulesView> {
    type Rules = { contract: ScanContract<{ dso: string }>; domain_id: string };
    const rules = this.isSv
      ? (
          await this.requestBases<{ amulet_rules_update: Rules }>(
            "POST",
            `${this.prefix}/amulet-rules`,
            {},
            [this.scanUrl, ...this.fallbackUrls],
          )
        ).amulet_rules_update
      : (await this.get<{ amulet_rules: Rules }>(`${this.prefix}/amulet-rules`)).amulet_rules;
    if (!rules?.contract?.contract_id || !rules.domain_id) {
      throw new CantonError("scan: amulet-rules returned no contract", "INVALID_RESPONSE");
    }
    return { contract: rules.contract, synchronizerId: rules.domain_id };
  }

  /**
   * The open and issuing mining rounds. SV Scan answers a POST with keyed maps;
   * a validator's scan-proxy answers a GET with arrays. Both come back as arrays.
   *
   * @returns The open and issuing rounds.
   */
  async getOpenAndIssuingMiningRounds(): Promise<{
    open: MiningRoundContract[];
    issuing: MiningRoundContract[];
  }> {
    type Entry = { contract: MiningRoundContract };
    type Rounds<C> = { open_mining_rounds?: C; issuing_mining_rounds?: C };
    if (this.isSv) {
      const raw = await this.requestBases<Rounds<Record<string, Entry>>>(
        "POST",
        `${this.prefix}/open-and-issuing-mining-rounds`,
        { cached_open_mining_round_contract_ids: [], cached_issuing_round_contract_ids: [] },
        [this.scanUrl, ...this.fallbackUrls],
      );
      return {
        open: Object.values(raw.open_mining_rounds ?? {}).map(e => e.contract),
        issuing: Object.values(raw.issuing_mining_rounds ?? {}).map(e => e.contract),
      };
    }
    const raw = await this.get<Rounds<Entry[]>>(`${this.prefix}/open-and-issuing-mining-rounds`);
    return {
      open: (raw.open_mining_rounds ?? []).map(e => e.contract),
      issuing: (raw.issuing_mining_rounds ?? []).map(e => e.contract),
    };
  }

  private get<T>(path: string): Promise<T> {
    return this.requestBases<T>("GET", path, undefined, [this.scanUrl, ...this.fallbackUrls]);
  }

  private async requestBases<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    bases: string[],
  ): Promise<T> {
    const MAX_TRANSIENT_RETRIES = 3;
    let lastErr: unknown;
    for (const base of bases) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.requestOnce<T>(method, path, body, base);
        } catch (err) {
          lastErr = err;
          if (!isTransientScanError(err)) throw err;
          if (attempt < MAX_TRANSIENT_RETRIES) {
            await new Promise(r =>
              setTimeout(r, 400 * 2 ** attempt + Math.floor(Math.random() * 150)),
            );
            continue;
          }
          break; // exhausted on this base → try the next fallback (if any)
        }
      }
    }
    throw lastErr;
  }

  private async requestOnce<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    base: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (method === "POST") headers["Content-Type"] = "application/json";
      // Attach the SV bearer ONLY to an SV base — a registry base is a different
      // origin and must not receive the Scan credential.
      const isSvBase = base === this.scanUrl || this.fallbackUrls.includes(base);
      if (this.token && isSvBase) {
        const tok = typeof this.token === "string" ? this.token : await this.token();
        headers.Authorization = `Bearer ${tok}`;
      }
      const res = await this.fetchFn(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CantonError(
          `${method} ${path} returned HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          text.slice(0, 1024),
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof CantonError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new CantonError(`${method} ${path} aborted after ${this.timeoutMs}ms`, "TIMEOUT");
      }
      throw new CantonError(
        `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        "TRANSPORT_ERROR",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
