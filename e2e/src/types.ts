import type { NetworkSet } from './networks/networks';

export type ProtocolFamily = 'evm' | 'svm' | 'avm' | 'aptos' | 'hedera' | 'stellar';
export type Transport = 'http' | 'mcp';
export type PaymentScheme = 'exact' | 'upto' | 'batch-settlement';
export type AssetTransferMethod = 'eip3009' | 'permit2';

/**
 * Resolved asset transfer for an EVM endpoint.
 */
export function endpointAssetTransferMethod(endpoint: TestEndpoint): AssetTransferMethod | undefined {
  const family = endpoint.protocolFamily ?? 'evm';
  if (family !== 'evm') {
    return undefined;
  }
  if (endpoint.assetTransferMethod != null) {
    return endpoint.assetTransferMethod;
  }
  const scheme = endpoint.scheme ?? 'exact';
  return scheme === 'upto' ? 'permit2' : 'eip3009';
}

/**
 * Resolved payment scheme for an EVM endpoint.
 * Defaults to `exact` when omitted (non-batch endpoints).
 */
export function endpointPaymentScheme(endpoint: TestEndpoint): PaymentScheme | undefined {
  const family = endpoint.protocolFamily ?? 'evm';
  if (family !== 'evm') {
    return undefined;
  }
  return endpoint.scheme ?? 'exact';
}

/** Harness knobs for exact / upto endpoints (Permit2 settle paths). */
export interface Permit2SchemeOptions {
  permit2Direct?: boolean;
  coldstart?: boolean;
}

/** Harness knobs for batch-settlement endpoints. */
export type BatchSettlementSchemeOptions = Permit2SchemeOptions;

export type SchemeOptions = Permit2SchemeOptions | BatchSettlementSchemeOptions;

export function endpointUsesBatchSettlement(endpoint: TestEndpoint): boolean {
  return endpoint.scheme === 'batch-settlement';
}

export interface ClientResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
}

/** Scheme-specific configs for a batch-settlement scenario. */
export type BatchSettlementPhase = 'initial' | 'recovery-refund' | 'full';

export interface BatchSettlementClientConfig {
  /** Per-scenario unique salt that derives the onchain channel id (avoids collisions across runs). */
  channelSalt: string;
  /** Fixed e2e phase to run for this one-shot client process. */
  phase: BatchSettlementPhase;
  /** Optional alternate EOA used to sign vouchers (deposits still use the main client signer). */
  voucherSignerPrivateKey?: string;
}

/** Scheme-specific knobs the harness forwards to a server for a batch-settlement scenario. */
export interface BatchSettlementServerConfig {
  /** Optional EOA private key the server uses as a self-managed receiver authorizer. */
  receiverAuthorizerPrivateKey: string;
}

export interface ClientConfig {
  evmPrivateKey: string;
  svmPrivateKey: string;
  avmPrivateKey: string;
  aptosPrivateKey: string;
  hederaAccountId: string;
  hederaPrivateKey: string;
  stellarPrivateKey: string;
  serverUrl: string;
  endpointPath: string;
  evmNetwork: string;
  evmRpcUrl: string;
  hederaNetwork: string;
  hederaNodeUrl: string;
  batchSettlement?: BatchSettlementClientConfig;
}

export interface ServerConfig {
  port: number;
  evmPayTo: string;
  svmPayTo: string;
  avmPayTo: string;
  aptosPayTo: string;
  hederaPayTo: string;
  hederaAsset?: string;
  hederaAmount?: string;
  stellarPayTo: string;
  networks: NetworkSet;
  facilitatorUrl?: string;
  mockFacilitatorUrl?: string;
  batchSettlement?: BatchSettlementServerConfig;
}

export interface ServerProxy {
  start(config: ServerConfig): Promise<void>;
  stop(): Promise<void>;
  getHealthUrl(): string;
  getProtectedPath(): string;
  getUrl(): string;
}

export interface ClientProxy {
  call(config: ClientConfig): Promise<ClientResult>;
}

export interface TestEndpoint {
  path: string;
  method: string;
  description: string;
  requiresPayment?: boolean;
  protocolFamily?: ProtocolFamily;
  scheme?: PaymentScheme;
  assetTransferMethod?: AssetTransferMethod;
  schemeOptions?: SchemeOptions;
  extensions?: string[];
  /** For MCP tools: the tool name used in tools/call. Defaults to path if not specified. */
  toolName?: string;
  /** For MCP tools: expected MCP wire transport for discovery metadata. */
  mcpTransport?: 'streamable-http' | 'sse';
  health?: boolean;
  close?: boolean;
}

export interface TestConfig {
  name: string;
  type: 'server' | 'client' | 'facilitator';
  transport?: Transport;
  language: string;
  protocolFamilies?: ProtocolFamily[];
  x402Version?: number;
  x402Versions?: number[];
  extensions?: string[];
  evm?: {
    assetTransferMethods?: AssetTransferMethod[];
  };
  endpoints?: TestEndpoint[];
  supportedMethods?: string[];
  capabilities?: {
    payment?: boolean;
    authentication?: boolean;
  };
  environment: {
    required: string[];
    optional: string[];
  };
}

export interface DiscoveredServer {
  name: string;
  directory: string;
  config: TestConfig;
  proxy: ServerProxy;
}

export interface DiscoveredClient {
  name: string;
  directory: string;
  config: TestConfig;
  proxy: ClientProxy;
}

export interface FacilitatorProxy {
  start(config: any): Promise<void>;
  stop(): Promise<void>;
  getUrl(): string;
}

export interface DiscoveredFacilitator {
  name: string;
  directory: string;
  config: TestConfig;
  proxy: FacilitatorProxy;
  isExternal?: boolean;
}

export interface TestScenario {
  client: DiscoveredClient;
  server: DiscoveredServer;
  facilitator?: DiscoveredFacilitator;
  endpoint: TestEndpoint;
  protocolFamily: ProtocolFamily;
}

export interface ScenarioResult {
  success: boolean;
  error?: string;
  data?: any;
  status_code?: number;
  payment_response?: any;
}
