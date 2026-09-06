import {
  FAMILY_CREDENTIALS,
  FAMILY_NETWORK_ENV,
  PROTOCOL_FAMILIES,
  type ProtocolFamily,
  type Role,
} from './networks/networks';
import type { NetworkSet } from './networks/networks';

/** CAIP-2 → v1 network string for legacy EVM/SVM SDKs. */
const V1_NETWORK_MAP: Record<string, string> = {
  // Testnets
  'eip155:84532': 'base-sepolia',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet',
  // Mainnets
  'eip155:8453': 'base',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
};

/**
 * Translates v2 CAIP-2 network format to v1 simple format for legacy servers
 *
 * @param network - Network in CAIP-2 format (e.g., "eip155:84532")
 * @returns Network in v1 format (e.g., "base-sepolia")
 */
export function translateNetworkForV1(network: string): string {
  return V1_NETWORK_MAP[network] ?? network;
}

export type InjectNetworkOptions = {
  /** Translate EVM/SVM network values for legacy v1 components */
  legacyV1?: boolean;
};

/**
 * Build network env vars from a NetworkSet, iterating the family registry.
 */
export function injectNetworkEnv(
  networks: NetworkSet,
  options?: InjectNetworkOptions,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const family of PROTOCOL_FAMILIES) {
    const cfg = networks[family];
    const schema = FAMILY_NETWORK_ENV[family];
    let networkValue = cfg.caip2;

    if (options?.legacyV1 && (family === 'evm' || family === 'svm')) {
      networkValue = translateNetworkForV1(cfg.caip2) as `${string}:${string}`;
    }

    env[schema.networkKey] = networkValue;
    if (cfg.rpcUrl) {
      env[schema.rpcUrlKey] = cfg.rpcUrl;
    }
  }

  return env;
}

/**
 * Forward role-prefixed credential env vars from the root process.
 * When enabledFamilies is set, only forward server addresses for those families
 * (other server keys are omitted so components don't register unsupported schemes).
 */
export function forwardRoleCredentials(
  role: Role,
  enabledFamilies?: ProtocolFamily[],
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const family of PROTOCOL_FAMILIES) {
    const keys = FAMILY_CREDENTIALS[family][role];
    for (const key of keys) {
      if (
        role === 'server' &&
        enabledFamilies &&
        key.startsWith('SERVER_') &&
        !enabledFamilies.includes(family)
      ) {
        continue;
      }
      const value = process.env[key];
      if (value !== undefined && value !== '') {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * SERVER_* credential keys that must be actively stripped from a spawned
 * component's env, because they belong to families excluded by enabledFamilies.
 *
 * Spawned processes inherit the full parent env (see proxy-base.ts's
 * `{ ...process.env, ...config.env }`), so forwardRoleCredentials simply
 * omitting a key from its returned env object is not enough on its own — the
 * value can still leak in from the parent process (e.g. loaded from e2e/.env)
 * unless it is explicitly unset in the child env.
 */
export function excludedServerCredentialKeys(enabledFamilies?: ProtocolFamily[]): string[] {
  if (!enabledFamilies) return [];
  const keys: string[] = [];
  for (const family of PROTOCOL_FAMILIES) {
    if (enabledFamilies.includes(family)) continue;
    keys.push(...FAMILY_CREDENTIALS[family].server);
  }
  return keys;
}

function protocolFamilyForServerEnvKey(key: string): ProtocolFamily | undefined {
  for (const family of PROTOCOL_FAMILIES) {
    if (FAMILY_CREDENTIALS[family].server.includes(key)) {
      return family;
    }
  }
  return undefined;
}

/** Merge env from test.config.json required/optional lists (pass-through from root). */
export function forwardConfigEnv(
  config: { environment?: { required?: string[]; optional?: string[] } } | null,
  baseEnv: Record<string, string>,
  enabledFamilies?: ProtocolFamily[],
): Record<string, string> {
  const env = { ...baseEnv };
  if (!config?.environment) return env;

  for (const key of [...(config.environment.required ?? []), ...(config.environment.optional ?? [])]) {
    if (process.env[key] && !env[key]) {
      if (enabledFamilies && key.startsWith('SERVER_')) {
        const family = protocolFamilyForServerEnvKey(key);
        if (family && !enabledFamilies.includes(family)) {
          continue;
        }
      }
      env[key] = process.env[key]!;
    }
  }
  return env;
}
