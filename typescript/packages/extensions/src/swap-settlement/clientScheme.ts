/**
 * Client-side scheme wrapper that makes swap settlement automatic.
 *
 * Wrap any registered scheme client (typically the exact EVM scheme) and the payer pays
 * from a configured input asset whenever the server's 402 advertises the swap-settlement
 * extension: the wrapper requests a quote, validates the requirements hash, signs the
 * witness-bound Permit2 transfer and attaches the extension payload - no manual EIP-712
 * or header handling in application code.
 *
 * When the server does not advertise the extension (or the input asset already equals
 * the required asset), payload creation delegates to the wrapped scheme unchanged.
 */

import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { Address, Hex } from "viem";
import {
  assertRequirementsHashMatches,
  buildPermit2WitnessTypedData,
  buildQuoteRequest,
  buildSwapSettlementExtension,
  buildSwapWitness,
  extractSwapSettlementServerInfo,
} from "./client";
import type { SwapQuoteResponse } from "./types";

/**
 * The typed data produced for the Permit2 witness signature.
 */
type Permit2WitnessTypedData = ReturnType<typeof buildPermit2WitnessTypedData>;

/**
 * Minimal signer surface the wrapper needs. Structurally compatible with viem accounts
 * and with the EVM mechanism package's client signer.
 */
export interface SwapSettlementSigner {
  address: string;
  signTypedData(typedData: Permit2WitnessTypedData): Promise<Hex>;
}

/**
 * Configuration for {@link withSwapSettlement}.
 */
export interface WithSwapSettlementOptions {
  /**
   * The asset the payer holds and wants to pay with (e.g. WETH). Swap settlement is
   * used whenever the server advertises the extension and this differs from the
   * required asset; otherwise the wrapped scheme handles the payment directly.
   */
  inputAsset: Address;
  /**
   * Fetch implementation used for the quote request (defaults to the global fetch).
   */
  fetch?: typeof fetch;
}

/**
 * Wraps a scheme client with automatic swap-settlement support.
 *
 * @param inner - The scheme client that handles regular payments (e.g. exact EVM)
 * @param signer - Signs the Permit2 witness transfer; usually the same signer as `inner`
 * @param options - Input-asset selection and transport configuration
 * @returns A scheme client that swaps when the server offers it and delegates otherwise
 *
 * @example
 * ```typescript
 * const client = new x402Client();
 * client.register(
 *   "eip155:*",
 *   withSwapSettlement(new ExactEvmScheme(signer), signer, { inputAsset: WETH }),
 * );
 * const fetchWithPayment = wrapFetchWithPayment(fetch, new x402HTTPClient(client));
 * // paying a USDC endpoint from a WETH balance now happens automatically
 * ```
 */
export function withSwapSettlement(
  inner: SchemeNetworkClient,
  signer: SwapSettlementSigner,
  options: WithSwapSettlementOptions,
): SchemeNetworkClient {
  const fetchFn = options.fetch ?? fetch;

  return {
    scheme: inner.scheme,
    schemeHooks: inner.schemeHooks,

    async createPaymentPayload(
      x402Version: number,
      paymentRequirements: PaymentRequirements,
      context?: PaymentPayloadContext,
    ): Promise<PaymentPayloadResult> {
      const info = extractSwapSettlementServerInfo({ extensions: context?.extensions });
      const applies =
        info !== null &&
        paymentRequirements.network.startsWith("eip155:") &&
        info.networks.includes(paymentRequirements.network) &&
        options.inputAsset.toLowerCase() !== paymentRequirements.asset.toLowerCase();
      if (!applies) {
        return inner.createPaymentPayload(x402Version, paymentRequirements, context);
      }

      // Quote: how much input asset the settler may pull for the exact required output
      const quoteRes = await fetchFn(info.quoteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildQuoteRequest(paymentRequirements, signer.address, options.inputAsset, x402Version),
        ),
      });
      if (!quoteRes.ok) {
        throw new Error(
          `swap-settlement quote failed (${quoteRes.status}): ${await quoteRes.text()}`,
        );
      }
      const quote = (await quoteRes.json()) as SwapQuoteResponse;

      // Never sign against requirements the quote does not exactly commit to (spec MUST)
      assertRequirementsHashMatches(paymentRequirements, quote);

      const permit2 = quote.authorizationMethods.find(m => m.method === "permit2");
      if (!permit2?.ready) {
        throw new Error(
          `swap-settlement: permit2 not ready for ${options.inputAsset} - ` +
            `approve the canonical Permit2 contract once, then retry`,
        );
      }

      // Sign the witness-bound Permit2 transfer: valid only for this exact quote,
      // recipient, output asset and amount
      const chainId = Number(paymentRequirements.network.split(":")[1]);
      const witness = buildSwapWitness(quote, paymentRequirements);
      const nonceBytes = new Uint8Array(24);
      globalThis.crypto.getRandomValues(nonceBytes);
      const nonce = BigInt(
        `0x${Array.from(nonceBytes, b => b.toString(16).padStart(2, "0")).join("")}`,
      );
      // +30s clock-skew buffer past the quote expiry
      const deadline = BigInt(Math.floor(new Date(quote.expiresAt).getTime() / 1000) + 30);
      const typedData = buildPermit2WitnessTypedData({
        chainId,
        settler: quote.settler as Address,
        inputAsset: options.inputAsset,
        maxAmountIn: BigInt(quote.maxAmountIn),
        nonce,
        deadline,
        witness,
      });
      const signature = await signer.signTypedData(typedData);

      return {
        x402Version,
        payload: {},
        extensions: buildSwapSettlementExtension({
          version: "1",
          quoteId: quote.quoteId,
          inputAsset: options.inputAsset,
          method: "permit2",
          permit2Authorization: {
            permitted: { token: options.inputAsset, amount: quote.maxAmountIn },
            from: signer.address,
            spender: quote.settler,
            nonce: nonce.toString(),
            deadline: deadline.toString(),
            witness,
            signature,
          },
        }),
      };
    },
  };
}
