/**
 * Mechanisms catalog loader — SSOT is e2e/config/mechanisms_global.json +
 * one e2e/config/mechanisms_<id>.json per network.
 *
 * `mechanisms_global.json` holds cross-cutting harness env only. Each
 * `mechanisms_<id>.json` holds one network's env keys, testnet/mainnet
 * identity, and the routes it serves. `routes` holds one canonical
 * definition per paid HTTP path, including `sdks` listing which SDKs
 * implement it. Resource servers resolve their middleware config and
 * handlers from the same data, so a new mechanism is a catalog entry rather
 * than an edit in every framework entrypoint.
 *
 * Executable scheme registration stays in clients|servers|facilitators
 * language modules. Legacy v1 components are not enriched from this catalog.
 */
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { PaymentFlowName } from '@x402/core/types';

/** Keep local types here to avoid circular imports with types.ts / networks.ts. */
export type SdkId = 'typescript' | 'python' | 'go';
export type ConfigRole = 'server' | 'client' | 'facilitator';
/** Network id, e.g. "evm" — one per `mechanisms_<id>.json` file. No fixed union: adding a network is a catalog-only edit. */
export type CatalogNetworkId = string;

type PaymentScheme = 'exact' | 'upto' | 'batch-settlement';
type AssetTransferMethod = 'eip3009' | 'permit2' | 'sequence' | 'ticketSequence';
/** Payment ordering on the accept; mirrors core {@link PaymentFlowName}. */
export type PaymentFlow = PaymentFlowName;
export type NetworkMode = 'testnet' | 'mainnet';

/** Per-key env declaration in mechanisms_*.json. */
export type EnvDeclaration = {
  required: boolean;
  roles: ConfigRole[];
};

/** Map of env key → declaration (catalog JSON `env` object). */
export type EnvMap = Record<string, EnvDeclaration>;

/** Flattened required/optional lists derived from {@link EnvMap}. */
type EnvList = { required: string[]; optional: string[] };

type NetworkEnv = {
  server: string[];
  client: string[];
  facilitator: string[];
};

type NetworkModeConfig = {
  name: string;
  caip2: string;
  rpcUrlDefault?: string;
  rpcUrlRequired?: boolean;
  permit2Asset?: string;
  /** EIP-712 domain name of `permit2Asset` on this network. */
  permit2AssetName?: string;
};

/** Env var whose presence adds one `extra` field, e.g. the XRPL IOU issuer. */
type ExtraEnvSpec = {
  env: string;
  /** Only apply when the asset was overridden away from its catalog default. */
  whenAssetOverridden?: boolean;
};

/**
 * Declarative price. Either a USD string (the SDK converts it against the
 * network's default asset) or an explicit amount/asset pair. Every route
 * declares its own price — there is no network-level default to fall back to.
 */
export type PriceSpec = {
  /** USD-denominated price, e.g. "$0.001". Mutually exclusive with `amount`. */
  usd?: string;
  /** Emit `extra.assetTransferMethod` alongside a USD price. */
  declareAssetTransferMethod?: boolean;
  amount?: string;
  amountEnv?: string;
  asset?: string;
  assetEnv?: string;
  /** Resolve the asset from the network's Permit2 token. */
  assetRef?: 'permit2';
  /** Add the Permit2 EIP-712 domain (`name`, `version`) to `extra`. */
  permit2Domain?: boolean;
  extraEnv?: Record<string, ExtraEnvSpec>;
};

/** One network's file contents (mechanisms_<id>.json). */
type NetworkFile = {
  env: EnvMap;
  testnet: NetworkModeConfig;
  mainnet: NetworkModeConfig;
  routes: Record<string, Omit<RouteDefinition, 'network'>>;
};

export type NetworkDefinition = {
  env: EnvMap;
  networks: Record<NetworkMode, NetworkModeConfig>;
};

/** Canonical definition of one paid HTTP route, shared by every SDK. */
export type RouteDefinition = {
  scheme: PaymentScheme;
  network: CatalogNetworkId;
  assetTransferMethod?: AssetTransferMethod;
  /** SDKs that implement this route. */
  sdks: SdkId[];
  schemeOptions?: Record<string, boolean>;
  /** Every route declares its own price. */
  price: PriceSpec;
  /** Extension ids the server declares on this route. */
  extensions?: string[];
  /** Settle less than the maximum (upto scheme). */
  settlementOverride?: { amount: string };
  /**
   * Payment flow for this route. Omitted or `"authorization"` is the default
   * (verify → resource → settle). Non-authorization values are merged into
   * route `extra.paymentFlow`, matching core wire rules.
   */
  paymentFlow?: PaymentFlow;
  /** Omit this route unless the named env var is set (optional add-on routes). */
  requiresEnv?: string;
};

/** Fixed success body for every paid route (`timestamp` is added by the server). */
export const PROTECTED_ROUTE_MESSAGE = 'Protected endpoint accessed successfully';

export type SdkRoute = RouteDefinition & { path: string };

type MechanismsCatalog = {
  globalEnv: EnvMap;
  networks: Record<string, NetworkDefinition>;
  routes: Record<string, RouteDefinition>;
};

/** Split an env map into required / optional key lists. */
function envMapToLists(env: EnvMap): EnvList {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, decl] of Object.entries(env)) {
    if (decl.required) required.push(key);
    else optional.push(key);
  }
  return { required, optional };
}

/** Index of env key → roles across global + all network env maps. */
function buildRolesIndex(catalog: MechanismsCatalog): Map<string, ConfigRole[]> {
  const index = new Map<string, ConfigRole[]>();
  const ingest = (env: EnvMap) => {
    for (const [key, decl] of Object.entries(env)) {
      index.set(key, decl.roles);
    }
  };
  ingest(catalog.globalEnv);
  for (const def of Object.values(catalog.networks)) {
    ingest(def.env);
  }
  return index;
}

type EndpointLike = {
  path: string;
  method: string;
  description: string;
  requiresPayment?: boolean;
  protocolFamily?: CatalogNetworkId;
  scheme?: PaymentScheme;
  assetTransferMethod?: AssetTransferMethod;
  paymentFlow?: PaymentFlow;
  schemeOptions?: Record<string, boolean>;
  extensions?: string[];
  health?: boolean;
  close?: boolean;
  /** MCP tool name, equal to `path` for MCP endpoints (`method: 'tool'`). */
  toolName?: string;
  /** MCP transport the tool is served over, e.g. `'sse'`. */
  mcpTransport?: string;
};

/** Surface an SDK route is exposed over. */
export type RouteTransport = 'http' | 'mcp';

/** e2e/ root — resolve from this file at src/mechanisms.ts */
function e2eRoot(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return join(process.cwd());
  }
}

/** Catalog directory: harness-injected when set, else `e2e/config`. */
export const CATALOG_DIR: string =
  process.env.E2E_MECHANISMS_CATALOG || join(e2eRoot(), 'config');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

/** `mechanisms_<id>.json` file names in the catalog dir, `global` excluded. */
function networkCatalogFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => /^mechanisms_.+\.json$/.test(name) && name !== 'mechanisms_global.json')
    .sort();
}

function assertEnvMap(env: EnvMap, source: string): void {
  for (const [key, decl] of Object.entries(env)) {
    if (!decl || typeof decl.required !== 'boolean' || !Array.isArray(decl.roles)) {
      throw new Error(`${source}: env.${key} must be { required: boolean, roles: ConfigRole[] }`);
    }
    if (decl.roles.length === 0) {
      throw new Error(`${source}: env.${key}.roles must be non-empty`);
    }
  }
}

function loadCatalog(): MechanismsCatalog {
  const globalFile = readJson<{ env: EnvMap }>(join(CATALOG_DIR, 'mechanisms_global.json'));
  assertEnvMap(globalFile.env, 'mechanisms_global.json');
  const networks: Record<string, NetworkDefinition> = {};
  const routes: Record<string, RouteDefinition> = {};

  for (const fileName of networkCatalogFiles(CATALOG_DIR)) {
    const id = fileName.replace(/^mechanisms_/, '').replace(/\.json$/, '');
    const file = readJson<NetworkFile>(join(CATALOG_DIR, fileName));
    assertEnvMap(file.env, fileName);

    networks[id] = {
      env: file.env,
      networks: { testnet: file.testnet, mainnet: file.mainnet },
    };

    for (const [path, def] of Object.entries(file.routes ?? {})) {
      if (routes[path]) {
        throw new Error(`Duplicate route path across mechanisms catalog files: ${path}`);
      }
      routes[path] = { ...def, network: id };
    }
  }

  return { globalEnv: globalFile.env, networks, routes };
}

const catalog: MechanismsCatalog = loadCatalog();
const envRolesIndex = buildRolesIndex(catalog);

/** Ordered network ids from the catalog (alphabetical by file name). */
export const NETWORK_IDS = Object.keys(catalog.networks) as CatalogNetworkId[];

export function getNetworkDefinition(network: CatalogNetworkId): NetworkDefinition {
  const def = catalog.networks[network];
  if (!def) {
    throw new Error(`Unknown network in catalog: ${network}`);
  }
  return def;
}

export function getRouteDefinition(path: string): RouteDefinition {
  const def = catalog.routes[path];
  if (!def) {
    throw new Error(`Unknown route in catalog: ${path}`);
  }
  return def;
}

export function sdkRoutesFor(sdk: string): SdkRoute[] {
  return Object.entries(catalog.routes)
    .filter(([, def]) => def.sdks.includes(sdk as SdkId))
    .map(([path, def]) => ({ path, ...def }));
}

/** Networks referenced by an SDK's explicit route list. */
export function networksForSdk(sdk: string): CatalogNetworkId[] {
  const ids = new Set<CatalogNetworkId>();
  for (const route of sdkRoutesFor(sdk)) {
    ids.add(route.network);
  }
  return NETWORK_IDS.filter(id => ids.has(id));
}

/** Union of schemes across an SDK's route list. */
export function schemesForSdk(sdk: string): PaymentScheme[] {
  const schemes = new Set<PaymentScheme>();
  for (const route of sdkRoutesFor(sdk)) {
    schemes.add(route.scheme);
  }
  return Array.from(schemes);
}

/** Schemes an SDK implements for one catalog network (from route `sdks`). */
export function schemesForSdkNetwork(sdk: string, network: CatalogNetworkId): PaymentScheme[] {
  const schemes = new Set<PaymentScheme>();
  for (const route of sdkRoutesFor(sdk)) {
    if (route.network === network) {
      schemes.add(route.scheme);
    }
  }
  return Array.from(schemes);
}

/**
 * Schemes a harness component supports on one network. When `declaredSchemes`
 * is set (client/facilitator test.config), intersect with the SDK catalog so
 * custom surfaces like svm-smart-wallet do not inherit every SDK route scheme.
 */
export function schemesForComponent(
  sdk: string,
  network: CatalogNetworkId,
  declaredSchemes: PaymentScheme[] | undefined,
): PaymentScheme[] {
  const sdkSchemes = schemesForSdkNetwork(sdk, network);
  if (!declaredSchemes?.length) {
    return sdkSchemes;
  }
  return declaredSchemes.filter(scheme => sdkSchemes.includes(scheme));
}

/** EVM asset transfer methods declared on an SDK's routes. */
export function evmAssetTransferMethodsForSdk(sdk: string): AssetTransferMethod[] | undefined {
  const methods = new Set<AssetTransferMethod>();
  for (const route of sdkRoutesFor(sdk)) {
    if (route.network === 'evm' && route.assetTransferMethod) {
      methods.add(route.assetTransferMethod);
    }
  }
  return methods.size > 0 ? Array.from(methods) : undefined;
}

/** Extensions that change how gas is paid, and so are worth naming in reports. */
const GAS_SPONSORING_LABELS: Record<string, string> = {
  eip2612GasSponsoring: 'EIP-2612 gas sponsoring',
  erc20ApprovalGasSponsoring: 'ERC-20 approval gas sponsoring',
};

/** Human-readable network label — the catalog file id, upper-cased. */
function networkLabel(network: CatalogNetworkId): string {
  return network.toUpperCase();
}

function routeDescription(route: SdkRoute): string {
  const label = networkLabel(route.network);
  const scheme = route.scheme === 'exact' ? '' : `${route.scheme} `;
  const transfer = route.assetTransferMethod ? `${route.assetTransferMethod} ` : '';
  const sponsoring = (route.extensions ?? [])
    .map(id => GAS_SPONSORING_LABELS[id])
    .filter(Boolean);
  const suffix = sponsoring.length > 0 ? ` with ${sponsoring.join(' and ')}` : '';
  const flow =
    route.paymentFlow && route.paymentFlow !== 'authorization' ? ` ${route.paymentFlow}` : '';
  return `Protected ${scheme}${transfer}endpoint on ${label}${flow}${suffix}`;
}

/** MCP tool name for a catalog path: `/exact/evm/eip3009` → `exact_evm_eip3009`. */
export function mcpToolName(path: string): string {
  return path.replace(/^\//, '').replace(/[/-]/g, '_');
}

export function sdkRouteToEndpoint(route: SdkRoute, transport: RouteTransport = 'http'): EndpointLike {
  if (transport === 'mcp') {
    const toolName = mcpToolName(route.path);
    return {
      path: toolName,
      method: 'tool',
      toolName,
      mcpTransport: 'sse',
      description: routeDescription(route),
      requiresPayment: true,
      protocolFamily: route.network,
      scheme: route.scheme,
      assetTransferMethod: route.assetTransferMethod,
      paymentFlow: route.paymentFlow,
      schemeOptions: route.schemeOptions,
      extensions: route.extensions,
    };
  }

  return {
    path: route.path,
    method: 'GET',
    description: routeDescription(route),
    requiresPayment: true,
    protocolFamily: route.network,
    scheme: route.scheme,
    assetTransferMethod: route.assetTransferMethod,
    paymentFlow: route.paymentFlow,
    schemeOptions: route.schemeOptions,
    extensions: route.extensions,
  };
}

/** True for the Next.js App Router e2e server (custom /api path layout). */
export function isNextHttpServer(
  options: { nameOverride?: string; componentDir?: string },
  config: Record<string, unknown>,
): boolean {
  if (config.name === 'next') {
    return true;
  }
  const dir = (options.componentDir ?? '').replace(/\\/g, '/');
  return dir.endsWith('/typescript/http/next') || dir.endsWith('/http/next');
}

/** Next withX402 App Router URL for a catalog route. */
export function nextWithX402HttpPath(catalogPath: string): string {
  return `/api${catalogPath}/withx402`;
}

function nextRouteToWithX402Endpoint(route: SdkRoute): EndpointLike {
  return {
    ...sdkRouteToEndpoint(route),
    path: nextWithX402HttpPath(route.path),
    description: `${routeDescription(route)} (withX402 wrapper)`,
  };
}

/** Paid + infra endpoints for the Next e2e server, derived from the catalog. */
export function nextServerEndpoints(routes: SdkRoute[]): EndpointLike[] {
  return [
    ...routes.map(nextRouteToWithX402Endpoint),
    {
      path: '/api/health',
      method: 'GET',
      description: 'Health check endpoint',
      health: true,
    },
    {
      path: '/api/close',
      method: 'POST',
      description: 'Graceful shutdown endpoint',
      close: true,
    },
  ];
}

export const HEALTH_PATH = '/health';
export const CLOSE_PATH = '/close';

const HEALTH_CLOSE: EndpointLike[] = [
  {
    path: HEALTH_PATH,
    method: 'GET',
    description: 'Health check endpoint',
    health: true,
  },
  {
    path: CLOSE_PATH,
    method: 'POST',
    description: 'Graceful shutdown endpoint',
    close: true,
  },
];

/** Narrows an SDK's route list, for surfaces that expose less than the catalog. */
export type RouteFilter = {
  excludeSchemes?: string[];
  excludeNetworks?: string[];
};

export function routeEnvSatisfied(route: SdkRoute, env: EnvLookup): boolean {
  if (!route.requiresEnv) {
    return true;
  }
  return Boolean(env(route.requiresEnv)?.trim());
}

export function filterRoutes(routes: SdkRoute[], filter?: RouteFilter): SdkRoute[] {
  if (!filter?.excludeSchemes?.length && !filter?.excludeNetworks?.length) {
    return routes;
  }
  const schemes = new Set(filter.excludeSchemes ?? []);
  const networks = new Set(filter.excludeNetworks ?? []);
  return routes.filter(route => !schemes.has(route.scheme) && !networks.has(route.network));
}

export function availableRoutes(
  routes: SdkRoute[],
  env: EnvLookup,
  filter?: RouteFilter,
): SdkRoute[] {
  return filterRoutes(routes, filter).filter(route => routeEnvSatisfied(route, env));
}

export function sdkRoutesToEndpoints(
  sdk: string,
  env: EnvLookup = key => process.env[key],
  filter?: RouteFilter,
): EndpointLike[] {
  return availableRoutes(sdkRoutesFor(sdk), env, filter).map(route => sdkRouteToEndpoint(route));
}

/**
 * Derive component extension ids from catalog route `extensions` only.
 *
 * Declaration (per-route, in mechanisms JSON) is the source of truth for what
 * servers put on payment requirements. Process registration
 * (`registerExtension` on servers/facilitators) is separate and may stay
 * always-on so handlers can honor those declarations.
 *
 * Clients never list `bazaar` — they consume discovery declarations; they do
 * not implement the discovery catalog.
 */
export function extensionsForSdk(sdk: string, role: ConfigRole): string[] {
  const extensions = new Set<string>();
  for (const route of sdkRoutesFor(sdk)) {
    for (const ext of route.extensions ?? []) {
      if (role === 'client' && ext === 'bazaar') continue;
      extensions.add(ext);
    }
  }
  return Array.from(extensions).sort();
}

/**
 * Env keys the harness assigns per run (not operator-supplied), so the
 * facilitator/client env preflight check must never flag them as "missing".
 * - `PORT`: allocated by {@link createPortAllocator}, injected at facilitator start.
 * - `RESOURCE_SERVER_URL` / `ENDPOINT_PATH`: set per scenario by {@link GenericClientProxy}.
 */
export const FACILITATOR_ENV_PREFLIGHT_ALLOWLIST: ReadonlySet<string> = new Set([
  'PORT',
  'RESOURCE_SERVER_URL',
  'ENDPOINT_PATH',
]);

/**
 * Which roles read an env key: catalog declaration, else SERVER_/CLIENT_/
 * FACILITATOR_ prefix as a fallback for undeclared keys.
 */
function rolesForKey(key: string): ConfigRole[] {
  const declared = envRolesIndex.get(key);
  if (declared) return declared;
  if (key.startsWith('SERVER_')) return ['server'];
  if (key.startsWith('CLIENT_')) return ['client'];
  if (key.startsWith('FACILITATOR_')) return ['facilitator'];
  return ['server', 'client', 'facilitator'];
}

/** Derived network env key: `${ID}_NETWORK`. */
function derivedNetworkKey(network: CatalogNetworkId): string {
  return `${network.toUpperCase()}_NETWORK`;
}

/** Derived RPC output env key injected into every spawned component: `${ID}_RPC_URL`. */
function derivedRpcUrlKey(network: CatalogNetworkId): string {
  return `${network.toUpperCase()}_RPC_URL`;
}

/** Derived RPC input env key an operator sets: `${ID}_{TESTNET,MAINNET}_RPC_URL`. */
function derivedRpcUrlInputKey(network: CatalogNetworkId, mode: NetworkMode): string {
  return `${network.toUpperCase()}_${mode.toUpperCase()}_RPC_URL`;
}

/**
 * Build environment required/optional lists for a role from the catalog
 * (harness keys + per-network keys assigned to this role). Overlay extras are
 * merged by the caller.
 */
export function buildEnvironmentForRole(
  role: ConfigRole,
  networks: CatalogNetworkId[],
): { required: string[]; optional: string[] } {
  const required = new Set<string>();
  const optional = new Set<string>();

  const addFromMap = (env: EnvMap) => {
    for (const [key, decl] of Object.entries(env)) {
      if (!decl.roles.includes(role)) continue;
      if (decl.required) required.add(key);
      else optional.add(key);
    }
  };

  addFromMap(catalog.globalEnv);

  for (const network of networks) {
    const def = getNetworkDefinition(network);
    addFromMap(def.env);
    optional.add(derivedNetworkKey(network));
    optional.add(derivedRpcUrlKey(network));
  }

  for (const key of required) {
    optional.delete(key);
  }

  return { required: Array.from(required), optional: Array.from(optional) };
}

function mergeEnvironment(
  base: { required: string[]; optional: string[] },
  overlay?: { required?: string[]; optional?: string[] },
): { required: string[]; optional: string[] } {
  const required = new Set([...base.required, ...(overlay?.required ?? [])]);
  const optional = new Set([...base.optional, ...(overlay?.optional ?? [])]);
  for (const key of required) {
    optional.delete(key);
  }
  return { required: Array.from(required), optional: Array.from(optional) };
}

export function isLegacyComponent(nameOverride?: string, componentDir?: string): boolean {
  if (nameOverride?.startsWith('legacy/') || nameOverride?.startsWith('legacy-')) {
    return true;
  }
  const normalized = (componentDir ?? '').replace(/\\/g, '/');
  return /(^|\/)legacy\//.test(normalized);
}

/**
 * Enrich a loaded test.config with mechanisms catalog defaults.
 * Skips legacy. When `endpoints` is already set, treats it as a full override
 * (custom surfaces: echo, MCP, svm-smart-wallet). The Next server always
 * derives endpoints from the catalog (proxy + withX402 per route).
 */
export function enrichConfigFromMechanisms(
  config: Record<string, unknown>,
  options: { nameOverride?: string; componentDir?: string },
): Record<string, unknown> {
  if (isLegacyComponent(options.nameOverride, options.componentDir)) {
    return config;
  }

  const sdk = String(config.language ?? '');
  if (!sdk || !['typescript', 'python', 'go'].includes(sdk)) {
    return config;
  }

  const type = config.type as ConfigRole | undefined;
  if (!type || !['server', 'client', 'facilitator'].includes(type)) {
    return config;
  }

  const filter: RouteFilter = {
    excludeSchemes: config.excludeSchemes as string[] | undefined,
    excludeNetworks: config.excludeNetworks as string[] | undefined,
  };
  const routes = availableRoutes(sdkRoutesFor(sdk), key => process.env[key], filter);

  const fromCatalog = NETWORK_IDS.filter(id => routes.some(route => route.network === id));
  const protocolFamilies =
    (config.protocolFamilies as CatalogNetworkId[] | undefined) ?? fromCatalog;
  const schemes =
    (config.schemes as PaymentScheme[] | undefined) ??
    Array.from(new Set(routes.map(route => route.scheme)));

  const enriched: Record<string, unknown> = {
    ...config,
    protocolFamilies,
    schemes,
  };

  if (protocolFamilies.includes('evm')) {
    const declared = new Set<AssetTransferMethod>();
    for (const route of routes) {
      if (route.network === 'evm' && route.assetTransferMethod) {
        declared.add(route.assetTransferMethod);
      }
    }
    const methods =
      (config.evm as { assetTransferMethods?: AssetTransferMethod[] } | undefined)
        ?.assetTransferMethods ?? (declared.size > 0 ? Array.from(declared) : undefined);
    if (methods) {
      enriched.evm = {
        ...((config.evm as object) ?? {}),
        assetTransferMethods: methods,
      };
    }
  }

  if (config.extensions == null) {
    enriched.extensions = extensionsForSdk(sdk, type);
  }

  const baseEnv = buildEnvironmentForRole(type, protocolFamilies);
  enriched.environment = mergeEnvironment(
    baseEnv,
    config.environment as { required?: string[]; optional?: string[] } | undefined,
  );

  const isNext = isNextHttpServer(options, config);
  const isMcp = config.transport === 'mcp';

  if (type === 'server' && (config.endpoints == null || isNext)) {
    enriched.endpoints = isNext
      ? nextServerEndpoints(routes)
      : [...routes.map(route => sdkRouteToEndpoint(route, isMcp ? 'mcp' : 'http')), ...HEALTH_CLOSE];
  }

  return enriched;
}

/**
 * Credential env keys per network and role, derived from the catalog `env` map.
 * Includes both required and optional keys (e.g. batch-settlement, gas-sponsoring
 * add-ons) — components need every role-relevant key for env forwarding, regardless of
 * whether the catalog treats it as baseline-mandatory. Use {@link catalogRequiredEnv}
 * for the "must be set before running this family at all" gate.
 */
function credentialKeysForRole(def: NetworkDefinition, role: ConfigRole): string[] {
  return Object.entries(def.env)
    .filter(([, decl]) => decl.roles.includes(role))
    .map(([key]) => key);
}

/** Credential map derived from the network catalog (for networks.ts). */
export function catalogCredentials(): Record<CatalogNetworkId, NetworkEnv> {
  const out = {} as Record<CatalogNetworkId, NetworkEnv>;
  for (const id of NETWORK_IDS) {
    const def = getNetworkDefinition(id);
    out[id] = {
      server: credentialKeysForRole(def, 'server'),
      client: credentialKeysForRole(def, 'client'),
      facilitator: credentialKeysForRole(def, 'facilitator'),
    };
  }
  return out;
}

/**
 * Per-network required env keys — must be set before a family can be exercised at
 * all (as opposed to optional add-ons like batch-settlement or gas-sponsoring
 * extras). Used for the CLI's upfront "missing required env" gate and CI family
 * selection.
 */
export function catalogRequiredEnv(): Record<CatalogNetworkId, string[]> {
  const out = {} as Record<CatalogNetworkId, string[]>;
  for (const id of NETWORK_IDS) {
    out[id] = envMapToLists(getNetworkDefinition(id).env).required;
  }
  return out;
}

/** Network env schema derived from the catalog. */
export function catalogNetworkEnv(): Record<
  CatalogNetworkId,
  { networkKey: string; rpcUrlKey: string }
> {
  const out = {} as Record<CatalogNetworkId, { networkKey: string; rpcUrlKey: string }>;
  for (const id of NETWORK_IDS) {
    out[id] = { networkKey: derivedNetworkKey(id), rpcUrlKey: derivedRpcUrlKey(id) };
  }
  return out;
}

/** Display names from the catalog (the file id, upper-cased). */
export function catalogDisplayNames(): Record<CatalogNetworkId, string> {
  const out = {} as Record<CatalogNetworkId, string>;
  for (const id of NETWORK_IDS) {
    out[id] = networkLabel(id);
  }
  return out;
}

/** Resolve rpc URL for a network/mode from catalog + process.env. */
export function resolveNetworkRpcUrl(network: CatalogNetworkId, mode: NetworkMode): string {
  const net = getNetworkDefinition(network).networks[mode];
  const fromEnv = process.env[derivedRpcUrlInputKey(network, mode)];
  if (fromEnv) return fromEnv;
  return net.rpcUrlDefault ?? '';
}

export function getCatalogNetwork(
  network: CatalogNetworkId,
  mode: NetworkMode,
): NetworkModeConfig {
  return getNetworkDefinition(network).networks[mode];
}

export type EnvLookup = (key: string) => string | undefined;

/**
 * Resolve `${ID}_NETWORK` from env, falling back to the catalog testnet CAIP-2.
 * Prefer this over hardcoding Base Sepolia / Solana Devnet / etc. string defaults.
 */
export function resolveNetworkCaip2(
  network: CatalogNetworkId,
  env: EnvLookup = key => process.env[key],
): string {
  return env(derivedNetworkKey(network)) || getCatalogNetwork(network, 'testnet').caip2;
}

/** Derive a CAIP-2 namespace wildcard (`eip155:*`) from a concrete CAIP-2 id. */
export function caip2Pattern(caip2: string): `${string}:*` {
  const ns = caip2.split(':')[0];
  if (!ns) {
    throw new Error(`invalid caip2: ${caip2}`);
  }
  return `${ns}:*`;
}

/**
 * Client/resource-server registration pattern for a catalog network id —
 * `${namespace}:*` derived from catalog (or env-overridden) CAIP-2.
 */
export function networkCaip2Pattern(
  network: CatalogNetworkId,
  env: EnvLookup = key => process.env[key],
): `${string}:*` {
  return caip2Pattern(resolveNetworkCaip2(network, env));
}

/**
 * The RPC input env key the operator must set for this network/mode, or
 * `undefined` when unset RPC is fine (has a usable default, or the mode
 * doesn't mark `rpcUrlRequired`). Used to promote that key into the
 * harness's startup preflight instead of failing deep inside a scenario run.
 */
export function requiredRpcUrlInputKey(
  network: CatalogNetworkId,
  mode: NetworkMode,
): string | undefined {
  const net = getNetworkDefinition(network).networks[mode];
  return net.rpcUrlRequired ? derivedRpcUrlInputKey(network, mode) : undefined;
}

/** Which catalog mode a CAIP-2 identifier belongs to. Defaults to testnet. */
export function networkModeForCaip2(network: CatalogNetworkId, caip2: string): NetworkMode {
  const def = getNetworkDefinition(network);
  return def.networks.mainnet.caip2 === caip2 ? 'mainnet' : 'testnet';
}

export type ResolvedPrice = string | { amount: string; asset: string; extra?: Record<string, string> };

/** A catalog route with all env-dependent values resolved for one server process. */
export type ResolvedRoute = {
  path: string;
  networkId: CatalogNetworkId;
  scheme: PaymentScheme;
  /** CAIP-2 identifier the route bills on. */
  network: string;
  payTo: string;
  price: ResolvedPrice;
  /** PaymentOption-level `extra`, used when `price` is a USD string. */
  extra?: Record<string, string>;
  extensions: string[];
  settlementOverride?: { amount: string };
};

/** Server payee address env key for a network, by fixed naming convention. */
function serverAddressEnvKey(network: CatalogNetworkId): string {
  return `SERVER_${network.toUpperCase()}_ADDRESS`;
}

/** Merge price-derived `extra` with catalog `paymentFlow` (authorization omitted on wire). */
function mergeRouteExtra(
  priceExtra: Record<string, string> | undefined,
  paymentFlow?: PaymentFlow,
): Record<string, string> | undefined {
  const wireFlow = paymentFlow && paymentFlow !== 'authorization' ? paymentFlow : undefined;
  if (!wireFlow && !priceExtra) {
    return undefined;
  }
  return {
    ...priceExtra,
    ...(wireFlow ? { paymentFlow: wireFlow } : {}),
  };
}

function resolvePrice(
  route: SdkRoute,
  caip2: string,
  env: EnvLookup,
): { price: ResolvedPrice; extra?: Record<string, string> } {
  const def = getNetworkDefinition(route.network);
  const spec = route.price;

  if (spec.usd) {
    const extra =
      spec.declareAssetTransferMethod && route.assetTransferMethod
        ? { assetTransferMethod: route.assetTransferMethod }
        : undefined;
    return { price: spec.usd, ...(extra ? { extra } : {}) };
  }

  const mode = networkModeForCaip2(route.network, caip2);
  const modeConfig = def.networks[mode];

  const amount = (spec.amountEnv ? env(spec.amountEnv) : undefined) ?? spec.amount;
  if (!amount) {
    throw new Error(`Route ${route.path}: price has no amount (env ${spec.amountEnv ?? 'n/a'})`);
  }

  const assetDefault =
    spec.assetRef === 'permit2' ? modeConfig.permit2Asset : spec.asset;
  const asset = (spec.assetEnv ? env(spec.assetEnv) : undefined) ?? assetDefault;
  if (!asset) {
    throw new Error(`Route ${route.path}: price has no asset (env ${spec.assetEnv ?? 'n/a'})`);
  }
  const assetOverridden = Boolean(assetDefault) && asset !== assetDefault;

  const extra: Record<string, string> = {};
  if (route.assetTransferMethod) {
    extra.assetTransferMethod = route.assetTransferMethod;
  }
  if (spec.permit2Domain && modeConfig.permit2AssetName) {
    extra.name = modeConfig.permit2AssetName;
    extra.version = '2';
  }
  for (const [key, envSpec] of Object.entries(spec.extraEnv ?? {})) {
    if (envSpec.whenAssetOverridden && !assetOverridden) continue;
    const value = env(envSpec.env);
    if (value) {
      extra[key] = value;
    }
  }

  return {
    price: { amount, asset, ...(Object.keys(extra).length > 0 ? { extra } : {}) },
  };
}

/**
 * Resolve every route an SDK implements against a server process environment.
 * Routes whose network has no configured payee address are dropped, so a server
 * only advertises what it can actually settle.
 */
export function resolvePaymentRoutes(
  sdk: string,
  env: EnvLookup,
  filter?: RouteFilter,
): ResolvedRoute[] {
  const resolved: ResolvedRoute[] = [];

  for (const route of availableRoutes(sdkRoutesFor(sdk), env, filter)) {
    const def = getNetworkDefinition(route.network);
    const payTo = env(serverAddressEnvKey(route.network));
    if (!payTo) continue;

    const caip2 = env(derivedNetworkKey(route.network)) ?? def.networks.testnet.caip2;
    const { price, extra: priceExtra } = resolvePrice(route, caip2, env);
    const extra = mergeRouteExtra(priceExtra, route.paymentFlow);

    resolved.push({
      path: route.path,
      networkId: route.network,
      scheme: route.scheme,
      network: caip2,
      payTo,
      price,
      ...(extra ? { extra } : {}),
      extensions: route.extensions ?? [],
      ...(route.settlementOverride ? { settlementOverride: route.settlementOverride } : {}),
    });
  }

  return resolved;
}

/** Bazaar discovery metadata matching the fixed paid-route success body. */
export function routeDiscoveryOutput(): {
  example: Record<string, string>;
  schema: { properties: Record<string, { type: string }>; required: string[] };
} {
  const example: Record<string, string> = {
    message: PROTECTED_ROUTE_MESSAGE,
    timestamp: '2024-01-01T00:00:00Z',
  };
  const properties: Record<string, { type: string }> = {};
  for (const key of Object.keys(example)) {
    properties[key] = { type: 'string' };
  }
  return { example, schema: { properties, required: Object.keys(example) } };
}

/** Route filter parsed from the exclude env vars the harness injects. */
export function routeFilterFromEnv(env: EnvLookup): RouteFilter {
  const split = (value: string | undefined) =>
    (value ?? '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
  return {
    excludeSchemes: split(env('E2E_EXCLUDE_SCHEMES')),
    excludeNetworks: split(env('E2E_EXCLUDE_NETWORKS')),
  };
}

export type { MechanismsCatalog, NetworkEnv as FamilyEnv, NetworkModeConfig as FamilyNetworkMode };
