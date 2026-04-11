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
      const runConfig: RunConfig = {
        env: {
          EVM_PRIVATE_KEY: config.evmPrivateKey,
          SVM_PRIVATE_KEY: config.svmPrivateKey,
          AVM_PRIVATE_KEY: config.avmPrivateKey,
          APTOS_PRIVATE_KEY: config.aptosPrivateKey,
          STELLAR_PRIVATE_KEY: config.stellarPrivateKey,
          RESOURCE_SERVER_URL: config.serverUrl,
          ENDPOINT_PATH: config.endpointPath,
          EVM_NETWORK: config.evmNetwork,
          EVM_RPC_URL: config.evmRpcUrl,
        }
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
} 