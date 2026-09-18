import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  PaymentOption,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { NextRequest, NextResponse } from "next/server";

/**
 * Shared configuration and resource servers for the `/protected/{evm,svm}/{exact,upto}...`
 * testnet demo endpoints. Deliberately separate from proxy.ts's `/protected` config so
 * that route stays functionally unchanged.
 */

export const EVM_NETWORK = "eip155:84532" as const; // Base Sepolia
export const SVM_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const; // Solana Devnet

export const evmPayeeAddress = process.env.RESOURCE_EVM_ADDRESS as `0x${string}`;
export const svmPayeeAddress = process.env.RESOURCE_SVM_ADDRESS as string;

const facilitatorUrl = process.env.FACILITATOR_URL as string;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

/** Base price for the `exact` testnet endpoints. */
export const EXACT_PRICE = "$0.01";
/** `upto` testnet endpoints authorize 2x the exact price. */
export const UPTO_PRICE = "$0.02";
/** `upto` testnet endpoints settle 50% of the authorized amount (i.e. the exact price). */
export const UPTO_SETTLEMENT_OVERRIDE = "50%";

/** Route-level extension declaration enabling gasless EIP-2612 Permit2 approval. */
export const EIP2612_EXTENSION = declareEip2612GasSponsoringExtension();

/**
 * `withX402`/`paymentProxyFromConfig` default to eagerly (backgrounded,
 * fire-and-forget) calling the facilitator's `/supported` on construction, so a real
 * first request doesn't pay that latency. That construction — and thus the eager call
 * — also happens when Next.js evaluates each route module during `next build` to
 * bundle/trace it, not just at real runtime. Locally that's harmless (an unreachable
 * dev facilitator URL fails instantly), but against a deploy target where
 * `FACILITATOR_URL` is slow or doesn't fail fast, every resource-server-bearing route
 * module independently starting this call at build time is a plausible source of a
 * hung/timed-out build with no code change involved. `NEXT_PHASE` is set to
 * `"phase-production-build"` by Next.js only during that build step, never at real
 * runtime, so gating on it disables the eager sync during the build only —
 * `withX402`/`paymentProxyFromConfig` still default to `true` at real runtime.
 */
export const SYNC_FACILITATOR_ON_START = process.env.NEXT_PHASE !== "phase-production-build";

/**
 * Shared EVM resource server for the new testnet endpoints. Registers both the `exact`
 * and `upto` schemes for Base Sepolia — safe to share since scheme registration is keyed
 * by (network, scheme name), the same way app/facilitator/index.ts already registers both
 * `ExactEvmScheme` and `UptoEvmScheme` on `eip155:84532`.
 */
export const evmResourceServer = new x402ResourceServer(facilitatorClient)
  .register(EVM_NETWORK, new ExactEvmScheme())
  .register(EVM_NETWORK, new UptoEvmScheme());

/**
 * Shared SVM resource server for the new testnet endpoints. `exact` is registered
 * immediately; `upto` requires an async receiver-authorizer signer (see
 * {@link ensureSvmUptoRegistered}) so it is registered lazily on first use.
 */
export const svmResourceServer = new x402ResourceServer(facilitatorClient).register(
  SVM_NETWORK,
  new ExactSvmScheme(),
);

let svmUptoReadyPromise: Promise<void> | null = null;

/**
 * Lazily registers the `upto` scheme on {@link svmResourceServer}.
 *
 * `UptoSvmScheme` (resource-server side) requires a `receiverAuthorizerSigner` — a hot
 * key that signs settlement-channel claim vouchers — unless the facilitator advertises
 * its own delegated `receiverAuthorizer`. The testnet facilitator (app/facilitator/index.ts)
 * registers `UptoSvmScheme` without an `authorizerSigner`, so it advertises none; this
 * reuses the same `FACILITATOR_SVM_PRIVATE_KEY` already required for the facilitator's own
 * SVM signer as the resource server's receiver-authorizer key. This demo site operates both
 * the facilitator and the resource server, so reusing that key for a lesser-privileged role
 * here is acceptable. Deriving the signer from a base58 private key is async
 * (`createKeyPairSignerFromBytes`), so registration is deferred until first use instead of
 * at module load.
 *
 * @returns A promise that resolves once the `upto` scheme is registered (or the missing
 *   env var has been logged)
 */
export function ensureSvmUptoRegistered(): Promise<void> {
  if (!svmUptoReadyPromise) {
    svmUptoReadyPromise = (async () => {
      const privateKey = process.env.FACILITATOR_SVM_PRIVATE_KEY;
      if (!privateKey) {
        console.error(
          "❌ FACILITATOR_SVM_PRIVATE_KEY environment variable is required for /protected/svm/upto",
        );
        return;
      }
      const receiverAuthorizerSigner = await createKeyPairSignerFromBytes(
        base58.decode(privateKey),
      );
      svmResourceServer.register(SVM_NETWORK, new UptoSvmScheme({ receiverAuthorizerSigner }));
    })();
  }
  return svmUptoReadyPromise;
}

/**
 * Builds the EIP-3009 `exact` accept option — `ExactEvmScheme`'s default asset transfer
 * method, so no `extra` override is needed.
 *
 * @returns The EIP-3009 payment option
 */
export function buildExactErc3009Accept(): PaymentOption {
  return {
    scheme: "exact",
    network: EVM_NETWORK,
    payTo: evmPayeeAddress,
    price: EXACT_PRICE,
  };
}

/**
 * Builds the Permit2 `exact` accept option. Whether the client attempts a gasless
 * EIP-2612 permit depends solely on whether the route advertises
 * {@link EIP2612_EXTENSION} in `extensions` — not on this option's shape — so this same
 * option is reused for both the "no extension" and "/eip2612" routes.
 *
 * @returns The Permit2 payment option
 */
export function buildExactPermit2Accept(): PaymentOption {
  return {
    scheme: "exact",
    network: EVM_NETWORK,
    payTo: evmPayeeAddress,
    price: EXACT_PRICE,
    extra: { assetTransferMethod: "permit2" },
  };
}

/**
 * Builds the `upto` accept option (Permit2 is `UptoEvmScheme`'s only asset transfer
 * method), priced at 2x {@link EXACT_PRICE}.
 *
 * @returns The upto payment option
 */
export function buildUptoAccept(): PaymentOption {
  return {
    scheme: "upto",
    network: EVM_NETWORK,
    payTo: evmPayeeAddress,
    price: UPTO_PRICE,
  };
}

/**
 * Builds the SVM `exact` accept option (SVM exact has a single default asset transfer
 * method, so no subshapes are needed).
 *
 * @returns The SVM exact payment option
 */
export function buildSvmExactAccept(): PaymentOption {
  return {
    scheme: "exact",
    network: SVM_NETWORK,
    payTo: svmPayeeAddress,
    price: EXACT_PRICE,
  };
}

/**
 * Builds the SVM `upto` accept option, priced at 2x {@link EXACT_PRICE}.
 *
 * @returns The SVM upto payment option
 */
export function buildSvmUptoAccept(): PaymentOption {
  return {
    scheme: "upto",
    network: SVM_NETWORK,
    payTo: svmPayeeAddress,
    price: UPTO_PRICE,
  };
}

/**
 * Builds the JSON body returned instead of the SDK's default paywall HTML / empty JSON
 * for an unpaid or failed request: short, human-readable advice on what's required to
 * pay, plus whatever failure detail the SDK already produced. Deliberately does not
 * repeat `accepts`/`extensions` — that's already in the `PAYMENT-REQUIRED` header real
 * x402 clients read, and duplicating it here would just drift out of sync over time.
 *
 * @param response - The withX402-produced response being replaced
 * @param advice - Route-specific advice on what mechanism/capability is required
 * @returns A JSON-serializable body combining the advice with the available error detail
 */
function buildFailureBody(response: NextResponse, advice: string): Record<string, unknown> {
  // A settlement failure (payment was submitted but didn't settle) carries a
  // PAYMENT-RESPONSE header with errorReason/errorMessage instead of PAYMENT-REQUIRED.
  const settleHeader = response.headers.get("PAYMENT-RESPONSE");
  if (settleHeader) {
    const settleResponse = decodePaymentResponseHeader(settleHeader);
    return {
      advice,
      error: settleResponse.errorReason ?? "settlement_failed",
      ...(settleResponse.errorMessage && { errorMessage: settleResponse.errorMessage }),
    };
  }

  const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
  if (requiredHeader) {
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
    return {
      advice,
      ...(paymentRequired.error && { error: paymentRequired.error }),
    };
  }

  return { advice };
}

/**
 * Wraps a `withX402`-produced handler so that unpaid (402) and Permit2-allowance (412)
 * responses always return the {@link buildFailureBody} JSON advice instead of the SDK's
 * default browser paywall HTML or empty JSON body — these testnet endpoints are meant
 * for programmatic/API clients, not the in-browser paywall UI. The real
 * `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` headers (and all other headers) are preserved
 * unchanged, so x402 client SDKs that read the header rather than the body are
 * unaffected. Successful (settled) responses pass through untouched.
 *
 * @param wrapped - The `withX402`-wrapped GET handler to hijack the unpaid response of
 * @param advice - Route-specific advice on what mechanism/capability is required
 * @returns A GET handler that returns JSON advice instead of a paywall on 402/412
 */
export function withJsonPaymentRequired(
  wrapped: (request: NextRequest) => Promise<NextResponse>,
  advice: string,
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> => {
    const response = await wrapped(request);
    if (response.status !== 402 && response.status !== 412) {
      return response;
    }

    const explained = NextResponse.json(buildFailureBody(response, advice), {
      status: response.status,
    });
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-type") return;
      explained.headers.set(key, value);
    });
    return explained;
  };
}
