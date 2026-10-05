import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { FacilitatorCantonSigner, CantonSchemeConfig } from "../../signer.js";
import { ExactCantonScheme, CantonFacilitatorOptions } from "./scheme.js";

/** Configuration for registering the Canton facilitator scheme. */
export interface CantonFacilitatorConfig extends CantonSchemeConfig {
  /** Ledger access + facilitator key(s). */
  signer: FacilitatorCantonSigner;
  /** The exact Canton networks to register (e.g. `canton:mainnet`). Required:
   *  a `canton:*` wildcard would be advertised verbatim in `/supported`. */
  networks: Network | Network[];
  /** Global Synchronizer id advertised in the 402 `extra`. */
  synchronizerId?: string;
}

/**
 * Registers the Canton `exact` scheme on an x402Facilitator instance.
 *
 * @param facilitator - The facilitator to register the scheme on.
 * @param config - The Canton facilitator configuration (signer + options).
 * @returns The same facilitator, for chaining.
 */
export function registerExactCantonScheme(
  facilitator: x402Facilitator,
  config: CantonFacilitatorConfig,
): x402Facilitator {
  const { signer, networks, ...options } = config;
  const list = Array.isArray(networks) ? networks : [networks];
  const scheme = new ExactCantonScheme(signer, {
    ...(options as CantonFacilitatorOptions),
    networks: list,
  });
  facilitator.register(list, scheme);
  return facilitator;
}
