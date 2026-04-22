import { BaseProxy, RunConfig } from '../proxy-base';
import { ServerProxy, ServerConfig } from '../types';
import { verboseLog, errorLog } from '../logger';

export interface ProtectedResponse {
  message: string;
  timestamp: string;
}

export interface HealthResponse {
  status: string;
}

export interface CloseResponse {
  message: string;
}

export interface ServerResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export class GenericServerProxy extends BaseProxy implements ServerProxy {
  private port: number = 4021;
  private healthEndpoint: string = '/health';
  private closeEndpoint: string = '/close';

  constructor(directory: string) {
    // Use different ready logs for different server types
    const readyLog = directory.includes('next') ? 'Ready' : 'Server listening';
    super(directory, readyLog);

    // Load endpoints from test config
    this.loadEndpoints();
  }

  private loadEndpoints(): void {
    try {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const configPath = join(this.directory, 'test.config.json');

      if (existsSync(configPath)) {
        const configContent = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);

        // Load health endpoint
        const healthEndpoint = config.endpoints?.find((endpoint: any) => endpoint.health);
        if (healthEndpoint) {
          this.healthEndpoint = healthEndpoint.path;
        }

        // Load close endpoint
        const closeEndpoint = config.endpoints?.find((endpoint: any) => endpoint.close);
        if (closeEndpoint) {
          this.closeEndpoint = closeEndpoint.path;
        }
      }
    } catch (error) {
      // Fallback to defaults if config loading fails
      errorLog(`Failed to load endpoints from config for ${this.directory}, using defaults`);
    }
  }

  async start(config: ServerConfig): Promise<void> {
    this.port = config.port;

    // Check if this is a v1 (legacy) server based on directory name
    const isV1Server = this.directory.includes('legacy/');

    verboseLog(`  📂 Server directory: ${this.directory}, isV1: ${isV1Server}`);

    // For legacy servers, translate CAIP-2 to v1 network names
    let evmNetwork = config.networks.evm.caip2;
    let svmNetwork = config.networks.svm.caip2;

    if (isV1Server) {
      evmNetwork = translateNetworkForV1(config.networks.evm.caip2);
      svmNetwork = translateNetworkForV1(config.networks.svm.caip2);

      verboseLog(`  🔄 Translating networks for v1 server: ${config.networks.evm.caip2} → ${evmNetwork}, ${config.networks.svm.caip2} → ${svmNetwork}`);
    }

    const runConfig: RunConfig = {
      port: config.port,
      env: {
        PORT: config.port.toString(),

        // EVM network config
        EVM_NETWORK: evmNetwork,
        EVM_RPC_URL: config.networks.evm.rpcUrl,
        EVM_PAYEE_ADDRESS: config.evmPayTo,
        EVM_PERMIT2_ASSET: config.networks.evm.permit2Asset || '',

        // SVM network config
        SVM_NETWORK: svmNetwork,
        SVM_RPC_URL: config.networks.svm.rpcUrl,
        SVM_PAYEE_ADDRESS: config.svmPayTo,

        // AVM network config
        AVM_NETWORK: config.networks.avm.caip2,
        AVM_RPC_URL: config.networks.avm.rpcUrl,
        AVM_PAYEE_ADDRESS: config.avmPayTo,

        // Aptos network config
        APTOS_NETWORK: config.networks.aptos.caip2,
        APTOS_RPC_URL: config.networks.aptos.rpcUrl,
        APTOS_PAYEE_ADDRESS: config.aptosPayTo,

        // Stellar network config
        STELLAR_NETWORK: config.networks.stellar.caip2,
        STELLAR_RPC_URL: config.networks.stellar.rpcUrl,
        STELLAR_PAYEE_ADDRESS: config.stellarPayTo,

        // Facilitator
        FACILITATOR_URL: config.facilitatorUrl || '',
        MOCK_FACILITATOR_URL: config.mockFacilitatorUrl || '',
      }
    };

    await this.startProcess(runConfig);
  }

  async protected(): Promise<ServerResult<ProtectedResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}/protected`);

      if (!response.ok) {
        return {
          success: false,
          error: `Protected endpoint failed: ${response.status} ${response.statusText}`,
          statusCode: response.status
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as ProtectedResponse,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async health(): Promise<ServerResult<HealthResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}${this.healthEndpoint}`);

      if (!response.ok) {
        return {
          success: false,
          error: `Health check failed: ${response.status} ${response.statusText}`,
          statusCode: response.status
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as HealthResponse,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async close(): Promise<ServerResult<CloseResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}${this.closeEndpoint}`, {
        method: 'POST'
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Close failed: ${response.status} ${response.statusText}`,
          statusCode: response.status
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as CloseResponse,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      try {
        // Try graceful shutdown via POST /close
        const closeResult = await this.close();
        if (closeResult.success) {
          // Wait a bit for graceful shutdown
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          verboseLog('Graceful shutdown failed, using force kill');
        }
      } catch (error) {
        verboseLog('Graceful shutdown failed, using force kill');
      }
    }

    await this.stopProcess();
  }

  getHealthUrl(): string {
    return `http://localhost:${this.port}${this.healthEndpoint}`;
  }

  getProtectedPath(): string {
    return `/protected`;
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }
}

/**
 * Translates v2 CAIP-2 network format to v1 simple format for legacy servers
 * 
 * @param network - Network in CAIP-2 format (e.g., "eip155:84532")
 * @returns Network in v1 format (e.g., "base-sepolia")
 */
function translateNetworkForV1(network: string): string {
  const networkMap: Record<string, string> = {
    // Testnets
    'eip155:84532': 'base-sepolia',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana-devnet',
    // Mainnets
    'eip155:8453': 'base',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana',
  };

  return networkMap[network] || network;
}
