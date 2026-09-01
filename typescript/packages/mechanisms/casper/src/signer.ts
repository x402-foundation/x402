import { HttpHandler, KeyAlgorithm, PrivateKey, RpcClient, SpeculativeClient } from "./casper-sdk";
import type { Network } from "@x402/core/types";
import { NetworkConfigs, type NetworkConfig } from "./constants";
import type {
  ClientCasperSigner,
  FacilitatorCasperSigner,
  FacilitatorCasperSignerOptions,
  CasperSpeculativeTransferParams,
  RpcUrlConfig,
  ToFacilitatorCasperSignerOptions,
} from "./types";
import { chainNameFromNetwork } from "./utils";

const ACCOUNT_HASH_PREFIX = "00";

/**
 * Pause execution for the given number of milliseconds.
 *
 * @param ms - Milliseconds to sleep.
 * @returns Promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve an RPC URL for a network.
 *
 * @param network - CAIP-2 network identifier.
 * @param config - Optional RPC URL config.
 * @returns RPC URL.
 */
function resolveRpcUrl(network: Network, config?: RpcUrlConfig): string {
  return config?.[network] ?? NetworkConfigs[network]?.rpcUrl ?? "";
}

/**
 * Create a client signer from a Casper private key.
 *
 * @param privateKey - Casper private key.
 * @returns Client signer.
 */
export function toClientCasperSigner(privateKey: PrivateKey): ClientCasperSigner {
  const accountAddress = `${ACCOUNT_HASH_PREFIX}${privateKey.publicKey.accountHash().toHex()}`;
  const publicKey = privateKey.publicKey.toHex();

  return {
    accountAddress: () => accountAddress,
    publicKey: () => publicKey,
    signEIP712: async digest => privateKey.signAndAddAlgorithmBytes(digest),
  };
}

/**
 * Create a client signer from a hex-encoded private key.
 *
 * @param privateKey - Hex-encoded private key.
 * @param algorithm - Key algorithm.
 * @returns Client signer.
 */
export async function createClientCasperSigner(
  privateKey: string,
  algorithm: KeyAlgorithm = KeyAlgorithm.ED25519,
): Promise<ClientCasperSigner> {
  return toClientCasperSigner(PrivateKey.fromHex(privateKey, algorithm));
}

/**
 * Create a facilitator signer from a Casper private key.
 *
 * @param privateKey - Casper private key.
 * @param options - RPC URL config and optional live preflight hooks.
 * @returns Facilitator signer.
 */
export async function toFacilitatorCasperSigner(
  privateKey: PrivateKey,
  options: ToFacilitatorCasperSignerOptions = {},
): Promise<FacilitatorCasperSigner> {
  const { rpcUrlConfig, preflightHooks = {}, speculativeRpcUrlConfig } = options;
  const rpcClients = new Map<string, InstanceType<typeof RpcClient>>();
  const speculativeClients = new Map<
    string,
    ReturnType<typeof SpeculativeClient.newSpeculativeClient>
  >();
  const hasSpeculativeRpcUrl = Object.values(speculativeRpcUrlConfig ?? {}).some(
    speculativeRpcUrl => speculativeRpcUrl.trim().length > 0,
  );

  const getNetworkConfig = async (network: Network): Promise<NetworkConfig> => {
    const rpcUrl = resolveRpcUrl(network, rpcUrlConfig);
    if (!rpcUrl) {
      throw new Error(`unsupported Casper network: ${network}`);
    }
    return {
      chainName: NetworkConfigs[network]?.chainName ?? chainNameFromNetwork(network),
      rpcUrl,
    };
  };

  const getRpcClient = async (network: Network): Promise<InstanceType<typeof RpcClient>> => {
    const networkConfig = await getNetworkConfig(network);
    const existing = rpcClients.get(networkConfig.rpcUrl);
    if (existing) {
      return existing;
    }
    const client = new RpcClient(new HttpHandler(networkConfig.rpcUrl));
    rpcClients.set(networkConfig.rpcUrl, client);
    return client;
  };

  const getSpeculativeClient = (
    network: Network,
  ): ReturnType<typeof SpeculativeClient.newSpeculativeClient> | undefined => {
    const speculativeRpcUrl = speculativeRpcUrlConfig?.[network]?.trim();
    if (!speculativeRpcUrl) {
      return undefined;
    }
    const existing = speculativeClients.get(speculativeRpcUrl);
    if (existing) {
      return existing;
    }
    const client = SpeculativeClient.newSpeculativeClient(new HttpHandler(speculativeRpcUrl));
    speculativeClients.set(speculativeRpcUrl, client);
    return client;
  };

  const simulateTransferWithAuthorization = hasSpeculativeRpcUrl
    ? async ({ network, deploy }: CasperSpeculativeTransferParams): Promise<void> => {
      const speculativeClient = getSpeculativeClient(network);
      if (!speculativeClient) {
        return;
      }

      const result = await speculativeClient.speculativeExec("1", deploy);
      const v2ErrorMessage = result.executionResult?.errorMessage;
      if (v2ErrorMessage) {
        throw new Error(`speculative execution failed: ${v2ErrorMessage}`);
      }
      if (result.executionResult) {
        return;
      }

      const rawJSON = result.rawJSON === undefined ? "" : `: ${JSON.stringify(result.rawJSON)}`;
      throw new Error(`speculative execution returned an unrecognized response${rawJSON}`);
    }
    : undefined;

  return {
    getNetworkConfig,

    getAddresses: () => [privateKey.publicKey.accountHash().toHex()],

    getPublicKeyHex: () => privateKey.publicKey.toHex(),

    ...(preflightHooks?.getBalance ? { getBalance: preflightHooks.getBalance } : {}),

    ...(preflightHooks?.getAuthorizationState ? { getAuthorizationState: preflightHooks.getAuthorizationState } : {}),

    ...(preflightHooks?.assertTransferWithAuthorizationSupported ? { assertTransferWithAuthorizationSupported: preflightHooks.assertTransferWithAuthorizationSupported } : {}),

    ...(simulateTransferWithAuthorization ? { simulateTransferWithAuthorization } : {}),

    signTransaction: async transaction => {
      transaction.sign(privateKey);
    },

    putTransaction: async (network, transaction) => {
      const rpcClient = await getRpcClient(network);
      try {
        const result = await rpcClient.putTransaction(transaction);
        return result.transactionHash.toHex();
      } catch (error: unknown) {
        const sourceErr =
          typeof error === "object" && error !== null && "sourceErr" in error
            ? ` - ${JSON.stringify(error.sourceErr)}`
            : "";
        const message = error instanceof Error ? `${error.message}${sourceErr}` : String(error);
        throw new Error(`transaction submission failed: ${message}`);
      }
    },

    waitForTransaction: async (network, transactionHash) => {
      const rpcClient = await getRpcClient(network);
      const start = Date.now();
      const timeoutMs = 60_000;
      const pollIntervalMs = 3_000;

      while (Date.now() - start < timeoutMs) {
        const info = await rpcClient.getTransactionByTransactionHash(transactionHash);
        const execInfo = info.executionInfo;
        if (execInfo && execInfo.blockHeight !== 0 && execInfo.executionResult) {
          const errorMessage = execInfo.executionResult.errorMessage;
          if (errorMessage) {
            throw new Error(`transaction execution failed: ${errorMessage}`);
          }
          return;
        }

        await sleep(pollIntervalMs);
      }

      throw new Error(`Timed out waiting for transaction ${transactionHash}`);
    },
  };
}

/**
 * Create a facilitator signer from a hex-encoded private key.
 *
 * @param privateKey - Hex-encoded private key.
 * @param algorithm - Key algorithm.
 * @param options - RPC URL config and optional live preflight hooks.
 * @returns Facilitator signer.
 */
export async function createFacilitatorCasperSigner(
  privateKey: string,
  algorithm: KeyAlgorithm = KeyAlgorithm.ED25519,
  options: FacilitatorCasperSignerOptions = {},
): Promise<FacilitatorCasperSigner> {
  return toFacilitatorCasperSigner(PrivateKey.fromHex(privateKey, algorithm), options);
}
