import type { NetworkSet } from './networks/networks';

export type ProtocolFamily = 'evm' | 'svm' | 'aptos' | 'stellar';
export type Transport = 'http' | 'mcp';
export type TransferMethod = 'eip3009' | 'permit2' | 'upto';

export interface ClientResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
}

export interface ClientConfig {
  evmPrivateKey: string;
  svmPrivateKey: string;
  aptosPrivateKey: string;
  stellarPrivateKey: string;
  serverUrl: string;
  endpointPath: string;
  evmNetwork: string;
  evmRpcUrl: string;
}

export interface ServerConfig {
  port: number;
  evmPayTo: string;
  svmPayTo: string;
  aptosPayTo: string;
  stellarPayTo: string;
  networks: NetworkSet;
  facilitatorUrl?: string;
  mockFacilitatorUrl?: string;
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
  transferMethod?: TransferMethod;
  extensions?: string[];
  /** True for Permit2 standard/direct settle - requires pre-approval (approve before test, not revoke) */
  permit2Direct?: boolean;
  /** True for endpoints that require Permit2 revocation + fund/drain state setup before the first test (coldstart). */
  coldstart?: boolean;
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
    transferMethods: TransferMethod[];
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
