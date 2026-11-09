import { x402Client, SelectPaymentRequirements, PaymentPolicy } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { networkMatchesPattern } from "@x402/core/utils";
import { ClientSvmSigner } from "../../signer";
import { ExactSvmScheme } from "./scheme";
import { ExactSvmSchemeV1 } from "../v1/client/scheme";
import { V1_TO_V2_NETWORK_MAP } from "../../constants";
import { NETWORKS } from "../../v1";

/**
 * Configuration options for registering SVM schemes to an x402Client
 */
export interface SvmClientConfig {
  /**
   * The SVM signer to use for creating payment payloads
   */
  signer: ClientSvmSigner;

  /**
   * Optional payment requirements selector function
   */
  paymentRequirementsSelector?: SelectPaymentRequirements;

  /**
   * Optional policies to apply to the client
   */
  policies?: PaymentPolicy[];

  /**
   * Optional specific networks to register
   */
  networks?: Network[];
}

/**
 * Registers SVM payment schemes to an existing x402Client instance.
 *
 * @param client - The x402Client instance to register schemes to
 * @param config - Configuration for SVM client registration
 * @returns The client instance for chaining
 */
export function registerExactSvmScheme(client: x402Client, config: SvmClientConfig): x402Client {
  // Register V2 scheme
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      client.register(network, new ExactSvmScheme(config.signer));
    });
  } else {
    client.register("solana:*", new ExactSvmScheme(config.signer));
  }

  const v1Networks =
    config.networks && config.networks.length > 0
      ? NETWORKS.filter(name => {
          const v2Network = V1_TO_V2_NETWORK_MAP[name];
          if (!v2Network) return false;
          return config.networks!.some(pattern =>
            networkMatchesPattern(pattern, v2Network as Network),
          );
        })
      : NETWORKS;

  v1Networks.forEach(network => {
    client.registerV1(network as Network, new ExactSvmSchemeV1(config.signer));
  });

  if (config.policies) {
    config.policies.forEach(policy => {
      client.registerPolicy(policy);
    });
  }

  return client;
}
