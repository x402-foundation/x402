import { BaseProxy, RunConfig } from '../proxy-base';
import { loadComponentConfig } from '../component';
import { ServerProxy, ServerConfig } from '../types';
import { verboseLog, errorLog } from '../logger';
import { resolveEvmPermit2Asset } from '../networks/networks';
import { CATALOG_DIR } from '../mechanisms';
import {
  excludedServerCredentialKeys,
  forwardConfigEnv,
  forwardRoleCredentials,
  injectNetworkEnv,
} from '../env';

/** Mirror a component's declared narrowing into the env its server reads. */
function routeExclusionEnv(config: unknown): Record<string, string> {
  const { excludeSchemes, excludeNetworks } = (config ?? {}) as {
    excludeSchemes?: string[];
    excludeNetworks?: string[];
  };
  const env: Record<string, string> = {};
  if (excludeSchemes?.length) {
    env.E2E_EXCLUDE_SCHEMES = excludeSchemes.join(',');
  }
  if (excludeNetworks?.length) {
    env.E2E_EXCLUDE_NETWORKS = excludeNetworks.join(',');
  }
  return env;
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
    this.loadEndpoints();
  }

  private loadEndpoints(): void {
    try {
      const config = loadComponentConfig(this.directory) as {
        endpoints?: Array<{ path: string; health?: boolean; close?: boolean }>;
      } | null;
      if (!config?.endpoints) return;

      const healthEndpoint = config.endpoints.find(endpoint => endpoint.health);
      if (healthEndpoint) {
        this.healthEndpoint = healthEndpoint.path;
      }

      const closeEndpoint = config.endpoints.find(endpoint => endpoint.close);
      if (closeEndpoint) {
        this.closeEndpoint = closeEndpoint.path;
      }
    } catch {
      // Fallback to defaults if config loading fails
      errorLog(`Failed to load endpoints from config for ${this.directory}, using defaults`);
    }
  }

  private loadConfig(): any {
    return loadComponentConfig(this.directory);
  }

  async start(config: ServerConfig): Promise<void> {
    this.port = config.port;
    const componentConfig = this.loadConfig();

    // Check if this is a v1 (legacy) server based on directory name
    const isV1Server = this.directory.includes('legacy/');

    verboseLog(`  📂 Server directory: ${this.directory}, isV1: ${isV1Server}`);

    if (isV1Server) {
      verboseLog(
        `  🔄 Translating networks for v1 server: ${config.networks.evm.caip2} → legacy EVM/SVM values`,
      );
    }

    const baseEnv: Record<string, string> = {
      PORT: config.port.toString(),
      ...forwardRoleCredentials('server', config.enabledFamilies),
      ...injectNetworkEnv(config.networks, { legacyV1: isV1Server }),
      EVM_PERMIT2_ASSET: resolveEvmPermit2Asset(config.networks),
      FACILITATOR_URL: config.facilitatorUrl || '',
      MOCK_FACILITATOR_URL: config.mockFacilitatorUrl || '',
      // Servers resolve their own routes from the same catalog the harness uses,
      // including the exclusions that narrow a surface (e.g. echo, no batching).
      E2E_MECHANISMS_CATALOG: CATALOG_DIR,
      ...routeExclusionEnv(componentConfig),
    };

    const runConfig: RunConfig = {
      port: config.port,
      // Optional family-specific vars (HEDERA_ASSET, SERVER_NEAR_ASSET, etc.) are
      // forwarded from the root process via forwardConfigEnv + test.config.json.
      env: forwardConfigEnv(componentConfig, baseEnv, config.enabledFamilies),
      // Strip SERVER_*_ADDRESS for excluded families even if they're inherited
      // from the harness's own process.env (e.g. e2e/.env), so a component never
      // registers a scheme its paired facilitator doesn't support.
      unsetEnv: excludedServerCredentialKeys(config.enabledFamilies),
    };

    await this.startProcess(runConfig);
  }

  /**
   * Catch catalog drift: every paid route a component declares must be mounted,
   * so an unpaid GET reaches the payment middleware instead of falling through
   * to the router. Only a missing route (404/405) fails the check — any other
   * status means the middleware owns the path, and a payment-time error there is
   * the test suite's job to report, not a startup failure. Only families enabled
   * for this run are checked, since the server drops routes whose payee is unset.
   */
  async verifyPaidRoutes(enabledFamilies?: string[]): Promise<{ ok: boolean; problems: string[] }> {
    const config = this.loadConfig() as {
      endpoints?: Array<{
        path: string;
        method?: string;
        requiresPayment?: boolean;
        protocolFamily?: string;
      }>;
    } | null;

    const paths = (config?.endpoints ?? [])
      .filter(endpoint => endpoint.requiresPayment && (endpoint.method ?? 'GET') === 'GET')
      .filter(
        endpoint =>
          !enabledFamilies ||
          !endpoint.protocolFamily ||
          enabledFamilies.includes(endpoint.protocolFamily),
      )
      .map(endpoint => endpoint.path);

    const problems: string[] = [];
    for (const path of paths) {
      try {
        const response = await fetch(`http://localhost:${this.port}${path}`);
        if (response.status === 404 || response.status === 405) {
          problems.push(`${path} → ${response.status} (declared in the catalog but not mounted)`);
        } else if (response.status !== 402) {
          verboseLog(`  ⚠️  ${path} answered ${response.status} instead of 402 without payment`);
        }
      } catch (error) {
        problems.push(`${path} → ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { ok: problems.length === 0, problems };
  }

  async health(): Promise<ServerResult<HealthResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}${this.healthEndpoint}`);

      if (!response.ok) {
        return {
          success: false,
          error: `Health check failed: ${response.status} ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as HealthResponse,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<ServerResult<CloseResponse>> {
    try {
      const response = await fetch(`http://localhost:${this.port}${this.closeEndpoint}`, {
        method: 'POST',
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Close failed: ${response.status} ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as CloseResponse,
        statusCode: response.status,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
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
      } catch {
        verboseLog('Graceful shutdown failed, using force kill');
      }
    }

    await this.stopProcess();
  }

  getUrl(): string {
    return `http://localhost:${this.port}`;
  }
}
