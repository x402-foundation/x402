import { x402Version } from "..";
import { SettleResponse, VerifyResponse } from "../types/facilitator";
import { FacilitatorExtension } from "../types/extensions";
import { SchemeNetworkFacilitator, FacilitatorContext } from "../types/mechanisms";
import { PaymentPayload, PaymentRequirements } from "../types/payments";
import { Network } from "../types";
import { type SchemeData } from "../utils";

/**
 * Facilitator Hook Context Interfaces
 */

export interface FacilitatorVerifyContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface FacilitatorVerifyResultContext extends FacilitatorVerifyContext {
  result: VerifyResponse;
}

export interface FacilitatorVerifyFailureContext extends FacilitatorVerifyContext {
  error: Error;
}

export interface FacilitatorSettleContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface FacilitatorSettleResultContext extends FacilitatorSettleContext {
  result: SettleResponse;
}

export interface FacilitatorSettleFailureContext extends FacilitatorSettleContext {
  error: Error;
}

/**
 * Facilitator Hook Type Definitions
 */

export type FacilitatorBeforeVerifyHook = (
  context: FacilitatorVerifyContext,
) => Promise<void | { abort: true; reason: string }>;

export type FacilitatorAfterVerifyHook = (context: FacilitatorVerifyResultContext) => Promise<void>;

export type FacilitatorOnVerifyFailureHook = (
  context: FacilitatorVerifyFailureContext,
) => Promise<void | { recovered: true; result: VerifyResponse }>;

export type FacilitatorBeforeSettleHook = (
  context: FacilitatorSettleContext,
) => Promise<void | { abort: true; reason: string }>;

export type FacilitatorAfterSettleHook = (context: FacilitatorSettleResultContext) => Promise<void>;

export type FacilitatorOnSettleFailureHook = (
  context: FacilitatorSettleFailureContext,
) => Promise<void | { recovered: true; result: SettleResponse }>;

/**
 * Facilitator client for the x402 payment protocol.
 * Manages payment scheme registration, verification, and settlement.
 */
export class x402Facilitator {
  private readonly registeredFacilitatorSchemes: Map<
    number,
    SchemeData<SchemeNetworkFacilitator>[] // Array to support multiple facilitators per version
  > = new Map();
  private readonly extensions: Map<string, FacilitatorExtension> = new Map();

  private beforeVerifyHooks: FacilitatorBeforeVerifyHook[] = [];
  private afterVerifyHooks: FacilitatorAfterVerifyHook[] = [];
  private onVerifyFailureHooks: FacilitatorOnVerifyFailureHook[] = [];
  private beforeSettleHooks: FacilitatorBeforeSettleHook[] = [];
  private afterSettleHooks: FacilitatorAfterSettleHook[] = [];
  private onSettleFailureHooks: FacilitatorOnSettleFailureHook[] = [];

  /**
   * Registers a scheme facilitator for the current x402 version.
   * Networks are stored and used for getSupported() - no need to specify them later.
   *
   * @param networks - Single network or array of networks this facilitator supports
   * @param facilitator - The scheme network facilitator to register
   * @returns The x402Facilitator instance for chaining
   */
  register(networks: Network | Network[], facilitator: SchemeNetworkFacilitator): x402Facilitator {
    const networksArray = Array.isArray(networks) ? networks : [networks];
    return this._registerScheme(x402Version, networksArray, facilitator);
  }

  /**
   * Registers a scheme facilitator for x402 version 1.
   * Networks are stored and used for getSupported() - no need to specify them later.
   *
   * @param networks - Single network or array of networks this facilitator supports
   * @param facilitator - The scheme network facilitator to register
   * @returns The x402Facilitator instance for chaining
   */
  registerV1(
    networks: Network | Network[],
    facilitator: SchemeNetworkFacilitator,
  ): x402Facilitator {
    const networksArray = Array.isArray(networks) ? networks : [networks];
    return this._registerScheme(1, networksArray, facilitator);
  }

  /**
   * Registers a protocol extension.
   *
   * @param extension - The extension object to register
   * @returns The x402Facilitator instance for chaining
   */
  registerExtension(extension: FacilitatorExtension): x402Facilitator {
    this.extensions.set(extension.key, extension);
    return this;
  }

  /**
   * Gets the list of registered extension keys.
   *
   * @returns Array of extension key strings
   */
  getExtensions(): string[] {
    return Array.from(this.extensions.keys());
  }

  /**
   * Gets a registered extension by key.
   *
   * @param key - The extension key to look up
   * @returns The extension object, or undefined if not registered
   */
  getExtension<T extends FacilitatorExtension = FacilitatorExtension>(key: string): T | undefined {
    return this.extensions.get(key) as T | undefined;
  }

  /**
   * Register a hook to execute before facilitator payment verification.
   * Can abort verification by returning { abort: true, reason: string }
   *
   * @param hook - The hook function to register
   * @returns The x402Facilitator instance for chaining
   */
  onBeforeVerify(hook: FacilitatorBeforeVerifyHook): x402Facilitator {
    this.beforeVerifyHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute after successful facilitator payment verification (isValid: true).
   * This hook is NOT called when verification fails (isValid: false) - use onVerifyFailure for that.
   *
   * @param hook - The hook function to register
   * @returns The x402Facilitator instance for chaining
   */
  onAfterVerify(hook: FacilitatorAfterVerifyHook): x402Facilitator {
    this.afterVerifyHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute when facilitator payment verification fails.
   * Called when: verification returns isValid: false, or an exception is thrown during verification.
   * Can recover from failure by returning { recovered: true, result: VerifyResponse }
   *
   * @param hook - The hook function to register
   * @returns The x402Facilitator instance for chaining
   */
  onVerifyFailure(hook: FacilitatorOnVerifyFailureHook): x402Facilitator {
    this.onVerifyFailureHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute before facilitator payment settlement.
   * Can abort settlement by returning { abort: true, reason: string }
   *
   * @param hook - The hook function to register
   * @returns The x402Facilitator instance for chaining
   */
  onBeforeSettle(hook: FacilitatorBeforeSettleHook): x402Facilitator {
    this.beforeSettleHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute after successful facilitator payment settlement.
   *
   * @param hook - The hook function to register
   * @returns The x402Facilitator instance for chaining
   */
  onAfterSettle(hook: FacilitatorAfterSettleHook): x402Facilitator {
    this.afterSettleHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute when facilitator payment settlement fails.
   * Can recover from failure by returning { recovered: true, result: SettleResponse }
   *
   * @param hook - The hook function to register
   * @returns The x402Facilitator instance for chaining
   */
  onSettleFailure(hook: FacilitatorOnSettleFailureHook): x402Facilitator {
    this.onSettleFailureHooks.push(hook);
    return this;
  }

  /**
   * Gets supported payment kinds, extensions, and signers.
   * Uses networks registered during register() calls - no parameters needed.
   * Returns flat array format for backward compatibility with V1 clients.
   *
   * @returns Supported response with kinds as array (with version in each element), extensions, and signers
   */
  getSupported(): {
    kinds: Array<{
      x402Version: number;
      scheme: string;
      network: string;
      extra?: Record<string, unknown>;
    }>;
    extensions: string[];
    signers: Record<string, string[]>;
  } {
    const kinds: Array<{
      x402Version: number;
      scheme: string;
      network: string;
      extra?: Record<string, unknown>;
    }> = [];
    const signersByFamily: Record<string, Set<string>> = {};

    // Iterate over registered scheme data (array supports multiple facilitators per version)
    for (const [version, schemeDataArray] of this.registeredFacilitatorSchemes) {
      for (const schemeData of schemeDataArray) {
        const { facilitator, networks } = schemeData;
        const scheme = facilitator.scheme;

        // Iterate over stored concrete networks
        for (const network of networks) {
          const extra = facilitator.getExtra(network);
          kinds.push({
            x402Version: version,
            scheme,
            network,
            ...(extra && { extra }),
          });

          // Collect signers by CAIP family for this network
          const family = facilitator.caipFamily;
          if (!signersByFamily[family]) {
            signersByFamily[family] = new Set();
          }
          facilitator.getSigners(network).forEach(signer => signersByFamily[family].add(signer));
        }
      }
    }

    // Convert signer sets to arrays
    const signers: Record<string, string[]> = {};
    for (const [family, signerSet] of Object.entries(signersByFamily)) {
      signers[family] = Array.from(signerSet);
    }

    return {
      kinds,
      extensions: this.getExtensions(),
      signers,
    };
  }

  /**
   * Verifies a payment payload against requirements.
   *
   * @param paymentPayload - The payment payload to verify
   * @param paymentRequirements - The payment requirements to verify against
   * @returns Promise resolving to the verification response
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const context: FacilitatorVerifyContext = {
      paymentPayload,
      requirements: paymentRequirements,
    };

    // Execute beforeVerify hooks
    for (const hook of this.beforeVerifyHooks) {
      const result = await hook(context);
      if (result && "abort" in result && result.abort) {
        return {
          isValid: false,
          invalidReason: result.reason,
        };
      }
    }

    try {
      const schemeDataArray = this.registeredFacilitatorSchemes.get(paymentPayload.x402Version);
      if (!schemeDataArray) {
        throw new Error(
          `No facilitator registered for x402 version: ${paymentPayload.x402Version}`,
        );
      }

      // Find matching facilitator from array
      let schemeNetworkFacilitator: SchemeNetworkFacilitator | undefined;
      for (const schemeData of schemeDataArray) {
        if (schemeData.facilitator.scheme === paymentRequirements.scheme) {
          // Check if network matches
          if (schemeData.networks.has(paymentRequirements.network)) {
            schemeNetworkFacilitator = schemeData.facilitator;
            break;
          }
          // Try pattern matching
          const patternRegex = new RegExp("^" + schemeData.pattern.replace("*", ".*") + "$");
          if (patternRegex.test(paymentRequirements.network)) {
            schemeNetworkFacilitator = schemeData.facilitator;
            break;
          }
        }
      }

      if (!schemeNetworkFacilitator) {
        throw new Error(
          `No facilitator registered for scheme: ${paymentRequirements.scheme} and network: ${paymentRequirements.network}`,
        );
      }

      const facilitatorContext = this.buildFacilitatorContext();
      const verifyResult = await schemeNetworkFacilitator.verify(
        paymentPayload,
        paymentRequirements,
        facilitatorContext,
      );

      // Check if verification failed (isValid: false)
      if (!verifyResult.isValid) {
        const failureContext: FacilitatorVerifyFailureContext = {
          ...context,
          error: new Error(verifyResult.invalidReason || "Verification failed"),
        };

        // Execute onVerifyFailure hooks
        for (const hook of this.onVerifyFailureHooks) {
          const result = await hook(failureContext);
          if (result && "recovered" in result && result.recovered) {
            // If recovered, execute afterVerify hooks with recovered result
            const recoveredContext: FacilitatorVerifyResultContext = {
              ...context,
              result: result.result,
            };
            for (const hook of this.afterVerifyHooks) {
              await hook(recoveredContext);
            }
            return result.result;
          }
        }

        return verifyResult;
      }

      // Execute afterVerify hooks only for successful verification
      const resultContext: FacilitatorVerifyResultContext = {
        ...context,
        result: verifyResult,
      };

      for (const hook of this.afterVerifyHooks) {
        await hook(resultContext);
      }

      return verifyResult;
    } catch (error) {
      const failureContext: FacilitatorVerifyFailureContext = {
        ...context,
        error: error as Error,
      };

      // Execute onVerifyFailure hooks
      for (const hook of this.onVerifyFailureHooks) {
        const result = await hook(failureContext);
        if (result && "recovered" in result && result.recovered) {
          return result.result;
        }
      }

      throw error;
    }
  }

  /**
   * Settles a payment based on the payload and requirements.
   *
   * @param paymentPayload - The payment payload to settle
   * @param paymentRequirements - The payment requirements for settlement
   * @returns Promise resolving to the settlement response
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const context: FacilitatorSettleContext = {
      paymentPayload,
      requirements: paymentRequirements,
    };

    // Execute beforeSettle hooks
    for (const hook of this.beforeSettleHooks) {
      const result = await hook(context);
      if (result && "abort" in result && result.abort) {
        throw new Error(`Settlement aborted: ${result.reason}`);
      }
    }

    try {
      const schemeDataArray = this.registeredFacilitatorSchemes.get(paymentPayload.x402Version);
      if (!schemeDataArray) {
        throw new Error(
          `No facilitator registered for x402 version: ${paymentPayload.x402Version}`,
        );
      }

      // Find matching facilitator from array
      let schemeNetworkFacilitator: SchemeNetworkFacilitator | undefined;
      for (const schemeData of schemeDataArray) {
        if (schemeData.facilitator.scheme === paymentRequirements.scheme) {
          // Check if network matches
          if (schemeData.networks.has(paymentRequirements.network)) {
            schemeNetworkFacilitator = schemeData.facilitator;
            break;
          }
          // Try pattern matching
          const patternRegex = new RegExp("^" + schemeData.pattern.replace("*", ".*") + "$");
          if (patternRegex.test(paymentRequirements.network)) {
            schemeNetworkFacilitator = schemeData.facilitator;
            break;
          }
        }
      }

      if (!schemeNetworkFacilitator) {
        throw new Error(
          `No facilitator registered for scheme: ${paymentRequirements.scheme} and network: ${paymentRequirements.network}`,
        );
      }

      const facilitatorContext = this.buildFacilitatorContext();
      const settleResult = await schemeNetworkFacilitator.settle(
        paymentPayload,
        paymentRequirements,
        facilitatorContext,
      );

      // Execute afterSettle hooks
      const resultContext: FacilitatorSettleResultContext = {
        ...context,
        result: settleResult,
      };

      for (const hook of this.afterSettleHooks) {
        await hook(resultContext);
      }

      return settleResult;
    } catch (error) {
      const failureContext: FacilitatorSettleFailureContext = {
        ...context,
        error: error as Error,
      };

      // Execute onSettleFailure hooks
      for (const hook of this.onSettleFailureHooks) {
        const result = await hook(failureContext);
        if (result && "recovered" in result && result.recovered) {
          return result.result;
        }
      }

      throw error;
    }
  }

  /**
   * Builds a FacilitatorContext from the registered extensions map.
   * Passed to mechanism verify/settle so they can access extension capabilities.
   *
   * @returns A FacilitatorContext backed by this facilitator's registered extensions
   */
  private buildFacilitatorContext(): FacilitatorContext {
    const extensionsMap = this.extensions;
    return {
      getExtension<T extends FacilitatorExtension = FacilitatorExtension>(
        key: string,
      ): T | undefined {
        return extensionsMap.get(key) as T | undefined;
      },
    };
  }

  /**
   * Internal method to register a scheme facilitator.
   *
   * @param x402Version - The x402 protocol version
   * @param networks - Array of concrete networks this facilitator supports
   * @param facilitator - The scheme network facilitator to register
   * @returns The x402Facilitator instance for chaining
   */
  private _registerScheme(
    x402Version: number,
    networks: Network[],
    facilitator: SchemeNetworkFacilitator,
  ): x402Facilitator {
    if (!this.registeredFacilitatorSchemes.has(x402Version)) {
      this.registeredFacilitatorSchemes.set(x402Version, []);
    }
    const schemeDataArray = this.registeredFacilitatorSchemes.get(x402Version)!;

    // Add new scheme data (supports multiple facilitators with same scheme name)
    schemeDataArray.push({
      facilitator,
      networks: new Set(networks),
      pattern: this.derivePattern(networks),
    });

    return this;
  }

  /**
   * Derives a wildcard pattern from an array of networks.
   * If all networks share the same namespace, returns wildcard pattern.
   * Otherwise returns the first network for exact matching.
   *
   * @param networks - Array of networks
   * @returns Derived pattern for matching
   */
  private derivePattern(networks: Network[]): Network {
    if (networks.length === 0) return "" as Network;
    if (networks.length === 1) return networks[0];

    // Extract namespaces (e.g., "eip155" from "eip155:84532")
    const namespaces = networks.map(n => n.split(":")[0]);
    const uniqueNamespaces = new Set(namespaces);

    // If all same namespace, use wildcard
    if (uniqueNamespaces.size === 1) {
      return `${namespaces[0]}:*` as Network;
    }

    // Mixed namespaces - use first network for exact matching
    return networks[0];
  }
}
