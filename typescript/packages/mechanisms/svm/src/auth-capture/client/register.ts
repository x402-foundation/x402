import { x402Client, SelectPaymentRequirements, PaymentPolicy } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { networkMatchesPattern } from "@x402/core/utils";
import { ClientSvmSigner } from "../../signer";
import { AuthCaptureSvmScheme } from "./scheme";

/**
 * Configuration options for registering SVM auth-capture schemes to an x402Client
 */
export interface SvmAuthCaptureClientConfig {
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
 * Registers SVM auth-capture payment schemes to an existing x402Client instance.
 *
 * @param client - The x402Client instance to register schemes to
 * @param config - Configuration for SVM auth-capture client registration
 * @returns The client instance for chaining
 */
export function registerAuthCaptureSvmScheme(
  client: x402Client,
  config: SvmAuthCaptureClientConfig,
): x402Client {
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      client.register(network, new AuthCaptureSvmScheme(config.signer));
    });
  } else {
    client.register("solana:*", new AuthCaptureSvmScheme(config.signer));
  }

  if (config.policies) {
    config.policies.forEach(policy => {
      client.registerPolicy(policy);
    });
  }

  return client;
}
