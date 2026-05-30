/**
 * Network configuration for E2E tests
 *
 * This is the single source of truth for all network configs.
 * Use getNetworkSet() to get configs for testnet or mainnet mode (Base-only shortcut).
 * Use getEvmNetworkConfig() for any EVM chain in DEFAULT_STABLECOINS by CAIP-2 id.
 */

import { DEFAULT_STABLECOINS } from '@x402/evm';
import { type Chain, defineChain } from 'viem';
import * as allChains from 'viem/chains';

export type NetworkMode = 'testnet' | 'mainnet';
export type ProtocolFamily = 'evm' | 'svm' | 'avm' | 'aptos' | 'hedera' | 'stellar' | 'tvm';

export type NetworkConfig = {
  name: string;
  caip2: `${string}:${string}`;
  rpcUrl: string;
  permit2Asset?: string;
};

export type NetworkSet = {
  evm: NetworkConfig;
  svm: NetworkConfig;
  avm: NetworkConfig;
  aptos: NetworkConfig;
  hedera: NetworkConfig;
  stellar: NetworkConfig;
  tvm: NetworkConfig;
};

/**
 * Resolve the EVM RPC URL for a chain. Single-knob configuration:
 *   1. `EVM_RPC_URL` override (matches the harness-wide convention used by
 *      e2e/test.ts, e2e/facilitators/*, and e2e/clients/*).
 *   2. viem's chain default (covers public chains shipped by viem).
 *   3. Empty string when neither applies — preserves the prior
 *      `process.env.X || ''` semantics so module load never throws.
 */
function evmRpcUrl(caip2: string): string {
  const override = process.env.EVM_RPC_URL?.trim();
  if (override) return override;
  return resolveViemChain(caip2).rpcUrls.default?.http?.[0] ?? '';
}

/**
 * All supported networks, organized by mode and protocol family
 */
const NETWORK_SETS: Record<NetworkMode, NetworkSet> = {
  testnet: {
    evm: {
      name: 'Base Sepolia',
      caip2: 'eip155:84532',
      rpcUrl: evmRpcUrl('eip155:84532'),
      permit2Asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    svm: {
      name: 'Solana Devnet',
      caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      rpcUrl: process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com',
    },
    avm: {
      name: 'Algorand Testnet',
      caip2: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
      rpcUrl: process.env.AVM_TESTNET_RPC_URL || 'https://testnet-api.4160.nodely.dev',
    },
    aptos: {
      name: 'Aptos Testnet',
      caip2: 'aptos:2',
      rpcUrl: process.env.APTOS_TESTNET_RPC_URL || 'https://fullnode.testnet.aptoslabs.com/v1',
    },
    hedera: {
      name: 'Hedera Testnet',
      caip2: 'hedera:testnet',
      rpcUrl: process.env.HEDERA_TESTNET_NODE_URL || '',
    },
    stellar: {
      name: 'Stellar Testnet',
      caip2: 'stellar:testnet',
      rpcUrl: process.env.STELLAR_TESTNET_RPC_URL || 'https://soroban-testnet.stellar.org',
    },
    tvm: {
      name: 'TON Testnet',
      caip2: 'tvm:-3',
      rpcUrl: process.env.TONCENTER_TESTNET_BASE_URL || 'https://testnet.toncenter.com',
    },
  },
  mainnet: {
    evm: {
      name: 'Base',
      caip2: 'eip155:8453',
      rpcUrl: evmRpcUrl('eip155:8453'),
      permit2Asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    svm: {
      name: 'Solana',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    },
    avm: {
      name: 'Algorand Mainnet',
      caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
      rpcUrl: process.env.AVM_RPC_URL || 'https://mainnet-api.4160.nodely.dev',
    },
    aptos: {
      name: 'Aptos',
      caip2: 'aptos:1',
      rpcUrl: process.env.APTOS_RPC_URL || 'https://fullnode.mainnet.aptoslabs.com/v1',
    },
    hedera: {
      name: 'Hedera Mainnet',
      caip2: 'hedera:mainnet',
      rpcUrl: process.env.HEDERA_NODE_URL || '',
    },
    stellar: {
      name: 'Stellar Pubnet',
      caip2: 'stellar:pubnet',
      rpcUrl: process.env.STELLAR_RPC_URL || 'https://mainnet.sorobanrpc.com',
    },
    tvm: {
      name: 'TON Mainnet',
      caip2: 'tvm:-239',
      rpcUrl: process.env.TONCENTER_MAINNET_BASE_URL || 'https://toncenter.com',
    },
  },
};

/**
 * Get the network set for a given mode, optionally overriding the EVM slot.
 *
 * @param mode - 'testnet' or 'mainnet'
 * @param evmCaip2 - Optional CAIP-2 EVM identifier; when provided the `evm`
 *   slot is overlaid from {@link EVM_NETWORK_CONFIGS} so the harness can
 *   target chains beyond the mode's default (e.g. Mezo Testnet on a `--testnet` run).
 * @returns NetworkSet containing configured protocol network configs
 */
export function getNetworkSet(mode: NetworkMode, evmCaip2?: string): NetworkSet {
  const base = NETWORK_SETS[mode];
  if (!evmCaip2 || evmCaip2 === base.evm.caip2) {
    return base;
  }
  return { ...base, evm: getEvmNetworkConfig(evmCaip2) };
}

/**
 * Permit2-priced routes read `process.env.EVM_PERMIT2_ASSET` in server processes.
 * Use the same resolution here and when spawning resource servers (`generic-server`)
 * so cold-start revoke/approve targets the token those routes bill.
 *
 * Precedence: non-empty `EVM_PERMIT2_ASSET`, then `networks.evm.permit2Asset`.
 * When the env var is unset, defaults are Base Sepolia USDC (`eip155:84532`) and
 * Base mainnet USDC (`eip155:8453`) from {@link NETWORK_SETS}.
 */
export function resolveEvmPermit2Asset(networks: NetworkSet): string {
  const fromEnv = process.env.EVM_PERMIT2_ASSET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return (networks.evm.permit2Asset ?? '').trim();
}

/**
 * Get network config for a protocol family in a given mode
 * 
 * @param mode - 'testnet' or 'mainnet'
 * @param protocolFamily - 'evm', 'svm', 'avm', 'aptos', 'hedera', 'stellar', or 'tvm'
 * @returns NetworkConfig for the specified protocol
 */
export function getNetworkForProtocol(
  mode: NetworkMode,
  protocolFamily: ProtocolFamily
): NetworkConfig {
  return NETWORK_SETS[mode][protocolFamily];
}

/**
 * Get display string for a network mode
 *
 * @param mode - 'testnet' or 'mainnet'
 * @returns Human-readable description of the networks
 */
export function getNetworkModeDescription(mode: NetworkMode): string {
  const set = NETWORK_SETS[mode];
  const networks = [set.evm.name, set.svm.name, set.avm.name, set.aptos.name, set.hedera.name, set.stellar.name, set.tvm.name];
  return networks.join(' + ');
}

/**
 * Per-chain EVM network configurations indexed by CAIP-2 identifier.
 * Derived at module load from {@link DEFAULT_STABLECOINS} (the SDK's
 * canonical chain catalog) so adding a chain there propagates here
 * automatically — no parallel hand-curated table to keep in sync.
 *
 * Display name comes from viem's chain database, falling back to
 * `EVM ${chainId}` for chains viem hasn't shipped.
 *
 * RPC URLs resolve via {@link evmRpcUrl}: `EVM_RPC_URL` overrides everything,
 * otherwise viem's chain default is used (empty string when viem ships no
 * default).
 * `permit2Asset` is the chain's default stablecoin (also the Permit2 target for
 * tests that exercise the permit2 / EIP-2612 path).
 */
export const EVM_NETWORK_CONFIGS: Record<string, NetworkConfig> = Object.fromEntries(
  Object.keys(DEFAULT_STABLECOINS).map(caip2 => [
    caip2,
    {
      name: resolveViemChain(caip2).name,
      caip2: caip2 as `${string}:${string}`,
      rpcUrl: evmRpcUrl(caip2),
      permit2Asset: DEFAULT_STABLECOINS[caip2].address,
    },
  ]),
);

/**
 * Get NetworkConfig for an EVM chain by CAIP-2 identifier.
 *
 * @param caip2 - CAIP-2 EVM identifier (e.g. "eip155:84532")
 * @returns NetworkConfig for the chain
 * @throws If the network is not in the configured list
 */
export function getEvmNetworkConfig(caip2: string): NetworkConfig {
  const config = EVM_NETWORK_CONFIGS[caip2];
  if (!config) {
    throw new Error(
      `No EVM network config for ${caip2}. Supported: ${Object.keys(EVM_NETWORK_CONFIGS).join(', ')}`,
    );
  }
  return config;
}

/**
 * Map a CAIP-2 EVM identifier to a viem `Chain`.
 *
 * Looks up viem's chain database; falls back to a minimal `defineChain` so
 * that EVM networks viem hasn't yet packaged still work for callers supplying
 * their own `EVM_RPC_URL`.
 *
 * @param caip2 - CAIP-2 EVM identifier (e.g. "eip155:84532")
 * @returns viem Chain object suitable for createPublicClient/createWalletClient
 */
export function resolveViemChain(caip2: string): Chain {
  const [namespace, ref] = caip2.split(':');
  if (namespace !== 'eip155') {
    throw new Error(`resolveViemChain: not an EVM network: ${caip2}`);
  }
  const chainId = Number(ref);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`resolveViemChain: invalid EVM chain id in ${caip2}`);
  }
  const known = (Object.values(allChains) as Chain[]).find(c => c.id === chainId);
  if (known) return known;
  return defineChain({
    id: chainId,
    name: `EVM ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}
