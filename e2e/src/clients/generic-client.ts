import { BaseProxy, RunConfig } from '../proxy-base';
import { ClientConfig, ClientProxy } from '../types';

export interface ClientCallResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
  exitCode?: number;
}

export class GenericClientProxy extends BaseProxy implements ClientProxy {
  constructor(directory: string) {
    // For clients, we don't wait for a ready log since they're one-shot processes
    super(directory, '');
  }

  async call(config: ClientConfig): Promise<ClientCallResult> {
    try {
      const baseEnv: Record<string, string> = {
        EVM_PRIVATE_KEY: config.evmPrivateKey,
        SVM_PRIVATE_KEY: config.svmPrivateKey,
        AVM_PRIVATE_KEY: config.avmPrivateKey,
        APTOS_PRIVATE_KEY: config.aptosPrivateKey,
        HEDERA_ACCOUNT_ID: config.hederaAccountId,
        HEDERA_PRIVATE_KEY: config.hederaPrivateKey,
        STELLAR_PRIVATE_KEY: config.stellarPrivateKey,
        TVM_PRIVATE_KEY: config.tvmPrivateKey,
        RESOURCE_SERVER_URL: config.serverUrl,
        ENDPOINT_PATH: config.endpointPath,
        EVM_NETWORK: config.evmNetwork,
        EVM_RPC_URL: config.evmRpcUrl,
        HEDERA_NETWORK: config.hederaNetwork,
        HEDERA_NODE_URL: config.hederaNodeUrl,
        TVM_NETWORK: config.tvmNetwork,
        TVM_PROVIDER: process.env.TVM_PROVIDER || '',
        TONCENTER_BASE_URL: process.env.TONCENTER_BASE_URL || config.tvmRpcUrl,
        TONAPI_API_KEY: process.env.TONAPI_API_KEY || '',
        TONAPI_BASE_URL: process.env.TONAPI_BASE_URL || '',
        ...(config.batchSettlement
          ? {
            CHANNEL_SALT: config.batchSettlement.channelSalt,
            BATCH_SETTLEMENT_PHASE: config.batchSettlement.phase,
            ...(config.batchSettlement.voucherSignerPrivateKey
              ? { EVM_VOUCHER_SIGNER_PRIVATE_KEY: config.batchSettlement.voucherSignerPrivateKey }
              : {}),
          }
          : {}),
      };

      const clientConfig = this.loadConfig();
      if (clientConfig?.environment?.required) {
        for (const envVar of clientConfig.environment.required) {
          if (process.env[envVar] && !baseEnv[envVar]) {
            baseEnv[envVar] = process.env[envVar]!;
          }
        }
      }
      if (clientConfig?.environment?.optional) {
        for (const envVar of clientConfig.environment.optional) {
          if (process.env[envVar] && !baseEnv[envVar]) {
            baseEnv[envVar] = process.env[envVar]!;
          }
        }
      }

      const runConfig: RunConfig = {
        env: baseEnv
      };

      // For clients, we run the process and wait for it to complete
      const result = await this.runOneShotProcess(runConfig);

      // Convert ProcessResult to ClientCallResult
      if (result.success && result.data) {
        return {
          success: true,
          data: result.data.data,
          status_code: result.data.status_code,
          payment_response: result.data.payment_response,
          exitCode: result.exitCode
        };
      } else {
        return {
          success: false,
          error: result.error,
          exitCode: result.exitCode
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Check if the client process is currently running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Force stop the client process if it's running
   */
  async forceStop(): Promise<void> {
    await this.stopProcess();
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
    } catch {
      // Fall back to the explicitly provided env set when config loading fails.
    }
    return null;
  }
}
