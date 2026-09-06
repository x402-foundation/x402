import {
  FAMILY_CREDENTIALS,
  FAMILY_DISPLAY_NAME,
  FAMILY_NETWORK_ENV,
  PROTOCOL_FAMILIES,
  getNetworkSet,
  type ProtocolFamily,
} from './networks/networks';

export type { ProtocolFamily } from './networks/networks';

export type Caip2Network = `${string}:${string}`;

type NetworkEnvValues = {
  [F in ProtocolFamily as (typeof FAMILY_NETWORK_ENV)[F]['networkKey']]: Caip2Network;
};

type ServerAddressEnvKey = (typeof FAMILY_CREDENTIALS)[ProtocolFamily]['server'][0];
type ServerAddressValues = Partial<Record<ServerAddressEnvKey, string>>;

/** Env loaded by TS e2e resource servers (express/hono/fastify). */
export type ServerEnvConfig = {
  PORT: string;
  facilitatorUrl: string;
  CCD_WEATHER_PRICE_MICRO_CCD: string;
  EVM_PERMIT2_ASSET: `0x${string}` | undefined;
  HEDERA_ASSET: string;
  HEDERA_AMOUNT: string;
  SERVER_NEAR_ASSET: string | undefined;
  SERVER_NEAR_AMOUNT: string | undefined;
  SERVER_XRPL_ASSET: string | undefined;
  SERVER_XRPL_AMOUNT: string | undefined;
  SERVER_XRPL_ISSUER: string | undefined;
} & NetworkEnvValues &
  ServerAddressValues;

export function getFamilyNetwork(cfg: ServerEnvConfig, family: ProtocolFamily): Caip2Network {
  const key = FAMILY_NETWORK_ENV[family].networkKey;
  return cfg[key as keyof ServerEnvConfig] as Caip2Network;
}

export function getServerAddress(
  cfg: ServerEnvConfig,
  family: ProtocolFamily,
): string | undefined {
  const key = FAMILY_CREDENTIALS[family].server[0];
  return cfg[key as keyof ServerEnvConfig] as string | undefined;
}

export function isFamilyConfigured(cfg: ServerEnvConfig, family: ProtocolFamily): boolean {
  return Boolean(getServerAddress(cfg, family));
}

export function buildUnconfiguredFamilyError(family: ProtocolFamily): {
  error: string;
  message: string;
} {
  const envVar = FAMILY_CREDENTIALS[family].server[0];
  return {
    error: `${FAMILY_DISPLAY_NAME[family]} payments not configured`,
    message: `${envVar} environment variable is not set`,
  };
}

/**
 * Loads env for TS e2e resource servers from process.env.
 * Network defaults come from {@link getNetworkSet} testnet config.
 */
export function loadServerEnv(): ServerEnvConfig {
  const facilitatorUrl = process.env.FACILITATOR_URL;
  if (!facilitatorUrl) {
    console.error('❌ FACILITATOR_URL environment variable is required');
    process.exit(1);
  }

  const defaults = getNetworkSet('testnet');
  const cfg = {
    PORT: process.env.PORT || '4021',
    facilitatorUrl,
    CCD_WEATHER_PRICE_MICRO_CCD: '1000',
    EVM_PERMIT2_ASSET: process.env.EVM_PERMIT2_ASSET as `0x${string}` | undefined,
    HEDERA_ASSET: process.env.HEDERA_ASSET ?? '0.0.0',
    HEDERA_AMOUNT: process.env.HEDERA_AMOUNT ?? '100000',
    SERVER_NEAR_ASSET: process.env.SERVER_NEAR_ASSET,
    SERVER_NEAR_AMOUNT: process.env.SERVER_NEAR_AMOUNT,
    SERVER_XRPL_ASSET: process.env.SERVER_XRPL_ASSET,
    SERVER_XRPL_AMOUNT: process.env.SERVER_XRPL_AMOUNT,
    SERVER_XRPL_ISSUER: process.env.SERVER_XRPL_ISSUER,
  } as ServerEnvConfig;

  for (const family of PROTOCOL_FAMILIES) {
    const { networkKey } = FAMILY_NETWORK_ENV[family];
    (cfg as Record<string, string | undefined>)[networkKey] =
      process.env[networkKey] || defaults[family].caip2;

    const addressKey = FAMILY_CREDENTIALS[family].server[0];
    const address = process.env[addressKey];
    if (address) {
      (cfg as Record<string, string | undefined>)[addressKey] = address;
    }
  }

  return cfg;
}
