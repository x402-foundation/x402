import { x402Client, SelectPaymentRequirements, PaymentPolicy } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { ClientSvmSigner } from "../../signer";
import { ExactSvmScheme } from "./scheme";
import { ExactSvmSchemeV1 } from "../v1/client/scheme";
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

  // Register all V1 networks
  NETWORKS.forEach(network => {
    client.registerV1(network as Network, new ExactSvmSchemeV1(config.signer));
  });

  if (config.policies) {
    config.policies.forEach(policy => {
      client.registerPolicy(policy);
    });
  }

  return client;
}
