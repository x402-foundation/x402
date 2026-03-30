import { BaseProxy, RunConfig } from '../proxy-base';
import { verboseLog, errorLog } from '../logger';
import type { NetworkSet } from '../networks/networks';

export interface VerifyRequest {
  x402Version: number;
  paymentPayload: any;
  paymentRequirements: any;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleRequest {
  x402Version: number;
  paymentPayload: any;
  paymentRequirements: any;
}

export interface SettleResponse {
  success: boolean;
  transaction?: string;
  errorReason?: string;
  network?: string;
  payer?: string;
}

export interface SupportedResponse {
  kinds: Array<{
    x402Version: number;
    scheme: string;
    network: string;
    extra?: Record<string, any>;
  }>;
  extensions: any[];
}

export interface HealthResponse {
  status: string;
}

export interface FacilitatorResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export interface FacilitatorConfig {
  port: number;
  evmPrivateKey?: string;
  svmPrivateKey?: string;
  aptosPrivateKey?: string;
  stellarPrivateKey?: string;
  networks: NetworkSet;
}

export interface FacilitatorProxy {
  start(config: FacilitatorConfig): Promise<void>;
  stop(): Promise<void>;
  verify(request: VerifyRequest): Promise<FacilitatorResult<VerifyResponse>>;
  settle(request: SettleRequest): Promise<FacilitatorResult<SettleResponse>>;
  getSupported(): Promise<FacilitatorResult<SupportedResponse>>;
  health(): Promise<FacilitatorResult<HealthResponse>>;
  getUrl(): string;
}

export class GenericFacilitatorProxy extends BaseProxy implements FacilitatorProxy {
  private port: number = 4022;
  private healthEndpoint: string = '/health';
  private closeEndpoint: string = '/close';

  constructor(directory: string) {
    // Facilitators should log when ready
    super(directory, 'Facilitator listening');
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

        // Load health endpoint if specified
        const healthEndpoint = config.endpoints?.find((endpoint: any) => endpoint.health);
        if (healthEndpoint) {
          this.healthEndpoint = healthEndpoint.path;
        }

        // Load close endpoint if specified
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

  async start(config: FacilitatorConfig): Promise<void> {
    this.port = config.port;

    const baseEnv: Record<string, string> = {
      PORT: config.port.toString(),
      EVM_PRIVATE_KEY: config.evmPrivateKey || '',
      SVM_PRIVATE_KEY: config.svmPrivateKey || '',
      APTOS_PRIVATE_KEY: config.aptosPrivateKey || '',
      STELLAR_PRIVATE_KEY: config.stellarPrivateKey || '',

      // Network configs from NetworkSet
      EVM_NETWORK: config.networks.evm.caip2,
      EVM_RPC_URL: config.networks.evm.rpcUrl,
      SVM_NETWORK: config.networks.svm.caip2,
      SVM_RPC_URL: config.networks.svm.rpcUrl,
      APTOS_NETWORK: config.networks.aptos.caip2,
      APTOS_RPC_URL: config.networks.aptos.rpcUrl,
      STELLAR_NETWORK: config.networks.stellar.caip2,
      STELLAR_RPC_URL: config.networks.stellar.rpcUrl,
    };

    // Pass through any additional environment variables required by the facilitator
    // This supports external facilitators that may need custom env vars (e.g., CDP_API_KEY_ID)
    const facilitatorConfig = this.loadConfig();
    if (facilitatorConfig?.environment?.required) {
      for (const envVar of facilitatorConfig.environment.required) {
        if (process.env[envVar] && !baseEnv[envVar]) {
          baseEnv[envVar] = process.env[envVar]!;
        }
      }
    }
    if (facilitatorConfig?.environment?.optional) {
      for (const envVar of facilitatorConfig.environment.optional) {
        if (process.env[envVar] && !baseEnv[envVar]) {
          baseEnv[envVar] = process.env[envVar]!;
        }
      }
    }

    const runConfig: RunConfig = {
      port: config.port,
      env: baseEnv
    };

    await this.startProcess(runConfig);
  }

  private loadConfig(): any {
    try {
      const { readFileSync, existsSync } = require('fs');
      const { join } = require('path');
      const configPath = join(this.directory, 'test.config.json');

      if (existsSync(configPath)) {
        const configContent = readFileSync(configPath, 'utf-8');
        return JSON.parse(configContent);
      }
    } catch (error) {
      errorLog(`Failed to load config from ${this.directory}: ${error}`);
    }
    return null;
  }

  async verify(request: VerifyRequest): Promise<FacilitatorResult<VerifyResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Verify failed: ${response.status} ${response.statusText}`,
          statusCode: response.status
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as VerifyResponse,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async settle(request: SettleRequest): Promise<FacilitatorResult<SettleResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Settle failed: ${response.status} ${response.statusText}`,
          statusCode: response.status
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as SettleResponse,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getSupported(): Promise<FacilitatorResult<SupportedResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}/supported`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Get supported failed: ${response.status} ${response.statusText}`,
          statusCode: response.status
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as SupportedResponse,
        statusCode: response.status
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async health(): Promise<FacilitatorResult<HealthResponse>> {
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

  async close(): Promise<FacilitatorResult<{ message: string }>> {
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
        data: data as { message: string },
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

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }
}
