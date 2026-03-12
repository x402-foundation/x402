import { x402Client, SelectPaymentRequirements, PaymentPolicy } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { ClientTvmSigner } from "../../signer";
import { ExactTvmScheme } from "./scheme";
import { TVM_MAINNET, TVM_TESTNET } from "../../constants";

/**
 * Configuration options for registering TVM schemes to an x402Client
 */
export interface TvmClientConfig {
  /**
   * The TVM signer to use for creating payment payloads
   */
  signer: ClientTvmSigner;

  /**
   * Optional payment requirements selector function
   */
  paymentRequirementsSelector?: SelectPaymentRequirements;

  /**
   * Optional policies to apply to the client
   */
  policies?: PaymentPolicy[];

  /**
   * Optional specific networks to register.
   * If not provided, registers both tvm:-239 (mainnet) and tvm:-3 (testnet).
   */
  networks?: Network[];
}

/**
 * Registers TVM exact payment schemes to an x402Client instance.
 *
 * @param client - The x402Client instance to register schemes to
 * @param config - Configuration for TVM client registration
 * @returns The client instance for chaining
 *
 * @example
 * ```typescript
 * import { registerExactTvmScheme } from "@x402/tvm/exact/client";
 * import { x402Client } from "@x402/core/client";
 * import { mnemonicToPrivateKey } from "@ton/crypto";
 * import { toClientTvmSigner } from "@x402/tvm";
 *
 * const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
 * const signer = toClientTvmSigner(keyPair, tonapiKey);
 * const client = new x402Client();
 * registerExactTvmScheme(client, { signer });
 * ```
 */
export function registerExactTvmScheme(
  client: x402Client,
  config: TvmClientConfig,
): x402Client {
  const tvmScheme = new ExactTvmScheme(config.signer);

  if (config.networks && config.networks.length > 0) {
    config.networks.forEach((network) => {
      client.register(network, tvmScheme);
    });
  } else {
    client.register(TVM_MAINNET as Network, tvmScheme);
    client.register(TVM_TESTNET as Network, tvmScheme);
  }

  if (config.policies) {
    config.policies.forEach((policy) => {
      client.registerPolicy(policy);
    });
  }

  return client;
}

/**
 * Convenience function to create an x402Client pre-configured for TVM.
 *
 * @param config - Configuration for TVM client
 * @returns A configured x402Client instance
 */
export function createTvmClient(config: TvmClientConfig): x402Client {
  const client = new x402Client(config.paymentRequirementsSelector);
  return registerExactTvmScheme(client, config);
}
