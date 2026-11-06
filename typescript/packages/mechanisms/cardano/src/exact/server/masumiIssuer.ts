import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "@x402/core/types";

import { ASSET_TRANSFER_METHOD_MASUMI } from "../../constants";
import type { MasumiDeployment } from "../../types";
import { masumiEscrowAddress, resolveMasumiDeployment } from "../masumi/blueprint";
import { MASUMI_MAX_DEADLINE_HORIZON_MS } from "../masumi/constants";
import {
  issueMasumiRequirements,
  type MasumiCommitmentInput,
  type MasumiTermsSigner,
} from "../masumi/issue";

/**
 * The selling wallet: its key-credential address and a CIP-8 signer over
 * `termsDigest`. {@link toMasumiSellerSigner} builds one from a mnemonic; a
 * CIP-30 wallet integration supplies its own.
 */
export interface MasumiSellerSigner {
  sellerAddress: string;
  signTerms: MasumiTermsSigner;
}

/** What the issuer knows about the request a quote is being issued for. */
export interface MasumiIssueContext {
  /** The template requirement the route declared. */
  requirement: PaymentRequirements;
  /** The protected resource the 402 is being served for. */
  resourceInfo: ResourceInfo;
  /** Transport-specific request context (HTTP request, MCP tool call), if any. */
  transportContext?: unknown;
}

/**
 * Escrow deadlines as offsets from `payByTime`, in milliseconds. The defaults
 * clear Masumi's minimum intervals (5, 15 and 15 minutes) with headroom and keep
 * `submitResultTime` at least 15 minutes ahead of issuance for any
 * `maxTimeoutSeconds`.
 */
export interface MasumiDeadlineOffsets {
  submitResultAfterPayByMs?: number;
  unlockAfterPayByMs?: number;
  externalDisputeUnlockAfterPayByMs?: number;
}

/** Default {@link MasumiDeadlineOffsets}: 15, 35 and 55 minutes after `payByTime`. */
export const DEFAULT_MASUMI_DEADLINE_OFFSETS: Required<MasumiDeadlineOffsets> = {
  submitResultAfterPayByMs: 15 * 60_000,
  unlockAfterPayByMs: 35 * 60_000,
  externalDisputeUnlockAfterPayByMs: 55 * 60_000,
};

/**
 * Configures the resource-server scheme to issue Masumi quotes itself.
 *
 * With this block present, a route only has to declare
 * `extra: { assetTransferMethod: "masumi" }` (plus an optional
 * `confirmationPolicy` and `deployment`) and put the escrow address in `payTo`;
 * the scheme signs a fresh quote for every 402 and answers a paid retry with the
 * quote that retry was issued.
 */
export interface MasumiIssuerConfig {
  /**
   * The selling wallet, or a resolver returning the wallet for a network when
   * one scheme instance serves several Cardano networks.
   */
  seller:
    | MasumiSellerSigner
    | ((network: string) => MasumiSellerSigner | Promise<MasumiSellerSigner>);
  /** Optional key-credential payout address; datum `seller_return_address`. */
  sellerReturnAddress?: string;
  /** Registry asset identifier; omitted, `null` or empty means unregistered. */
  agentIdentifier?: string | null;
  /**
   * Non-canonical validator parameters, used when a template declares none.
   * Required on Preview, which has no canonical deployment.
   */
  deployment?: MasumiDeployment;
  /**
   * Builds the request commitment the escrow's `input_hash` binds the payment
   * to. Defaults to one `jcs` part committing to the protected resource URL,
   * which is the whole request for an argument-less resource; a job endpoint
   * that takes parameters should commit to them here.
   */
  commitment?: (
    context: MasumiIssueContext,
  ) => MasumiCommitmentInput[] | Promise<MasumiCommitmentInput[]>;
  /** Escrow deadlines relative to `payByTime`; see {@link DEFAULT_MASUMI_DEADLINE_OFFSETS}. */
  deadlines?: MasumiDeadlineOffsets;
  /** Seller-side ceiling on how far `externalDisputeUnlockTime` may sit past now. */
  maxDeadlineHorizonMs?: bigint;
  /**
   * Reads the paid payload out of a transport context this package does not
   * recognise. The HTTP `PAYMENT-SIGNATURE` header and MCP `_meta["x402/payment"]`
   * are handled without it.
   */
  paymentPayloadFromTransport?: (transportContext: unknown) => PaymentPayload | undefined;
}

/** `extra` keys a Masumi template may carry; everything else is issued. */
const TEMPLATE_KEYS = new Set([
  "assetTransferMethod",
  "confirmationPolicy",
  "areFeesSponsored",
  "deployment",
]);

/** Meta key `@x402/mcp` carries the payment payload under. */
const MCP_PAYMENT_META_KEY = "x402/payment";

/**
 * Returns whether a requirements `extra` selects the Masumi transfer method.
 *
 * @param extra - Requirements `extra` block.
 * @returns True when the block selects `masumi`.
 */
export function isMasumiExtra(extra: unknown): extra is Record<string, unknown> {
  return (
    typeof extra === "object" &&
    extra !== null &&
    (extra as { assetTransferMethod?: unknown }).assetTransferMethod ===
      ASSET_TRANSFER_METHOD_MASUMI
  );
}

/**
 * Returns whether a Masumi `extra` is a template awaiting issuance: it selects
 * the method but carries no seller-signed `terms` yet.
 *
 * @param extra - Requirements `extra` block.
 * @returns True for an unissued Masumi template.
 */
export function isMasumiTemplate(extra: unknown): extra is Record<string, unknown> {
  return isMasumiExtra(extra) && extra.terms === undefined;
}

/**
 * Checks a Masumi template at route-build time, before any request arrives:
 * only template keys are present, and `payTo` is the escrow address the
 * deployment derives to — the seller signs `payTo` into `termsDigest`, and
 * scheme enrichment may not change it later.
 *
 * @param requirements - The template requirements.
 * @param config - Issuer settings the template must fit: default deployment,
 *   deadline offsets and the seller's deadline horizon.
 * @throws When the template cannot be issued as declared.
 */
export function assertMasumiTemplate(
  requirements: PaymentRequirements,
  config: Pick<MasumiIssuerConfig, "deployment" | "deadlines" | "maxDeadlineHorizonMs">,
): void {
  const extra = requirements.extra ?? {};
  for (const key of Object.keys(extra)) {
    if (!TEMPLATE_KEYS.has(key)) {
      throw new Error(
        `Masumi template extra may only carry ${[...TEMPLATE_KEYS].join(", ")}; found ${key}`,
      );
    }
  }
  // The last deadline is payByTime (= now + maxTimeoutSeconds) plus its offset;
  // the issuer refuses one past its horizon, so catch that at route build time
  // instead of on every 402.
  const offsets = { ...DEFAULT_MASUMI_DEADLINE_OFFSETS, ...config.deadlines };
  const horizonMs = config.maxDeadlineHorizonMs ?? MASUMI_MAX_DEADLINE_HORIZON_MS;
  const lastDeadlineMs =
    BigInt(requirements.maxTimeoutSeconds) * 1000n +
    BigInt(offsets.externalDisputeUnlockAfterPayByMs);
  if (lastDeadlineMs > horizonMs) {
    throw new Error(
      `Masumi template maxTimeoutSeconds ${requirements.maxTimeoutSeconds} pushes externalDisputeUnlockTime past the ${horizonMs}ms horizon`,
    );
  }
  const deployment = resolveMasumiDeployment(
    requirements.network,
    (extra.deployment as MasumiDeployment | undefined) ?? config.deployment,
  );
  if (!deployment) {
    throw new Error(
      `Network ${requirements.network} has no canonical Masumi deployment; supply extra.deployment or masumi.deployment`,
    );
  }
  const escrow = masumiEscrowAddress(requirements.network, deployment);
  if (requirements.payTo !== escrow) {
    throw new Error(
      `Masumi route payTo must be the escrow address ${escrow} on ${requirements.network}; got ${requirements.payTo || "(empty)"}`,
    );
  }
}

/**
 * Reads the paid payload out of the transport contexts this package knows:
 * the HTTP request's `PAYMENT-SIGNATURE` header and MCP `_meta`. Core passes
 * neither `paymentPayload` nor the decoded header to
 * `enrichPaymentRequiredResponse` on the paid path, so this is how the scheme
 * learns which quote a retry presents.
 *
 * @param transportContext - The transport context handed to the enrich hook.
 * @returns The payload, or undefined when the transport carries none.
 */
export function paymentPayloadFromTransportContext(
  transportContext: unknown,
): PaymentPayload | undefined {
  if (typeof transportContext !== "object" || transportContext === null) return undefined;
  const context = transportContext as {
    request?: { paymentHeader?: unknown };
    meta?: Record<string, unknown>;
  };
  const header = context.request?.paymentHeader;
  if (typeof header === "string" && header.length > 0) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      if (isPaymentPayloadLike(decoded)) return decoded;
    } catch {
      // Malformed header: the request will fail matching downstream anyway.
    }
  }
  const meta = context.meta?.[MCP_PAYMENT_META_KEY];
  if (isPaymentPayloadLike(meta)) return meta;
  return undefined;
}

/**
 * Structural check for a v2 payment payload: enough to read `accepted` from it.
 *
 * @param value - Candidate value.
 * @returns True when the value has the payload shape.
 */
function isPaymentPayloadLike(value: unknown): value is PaymentPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { x402Version?: unknown; accepted?: unknown; payload?: unknown };
  return (
    typeof candidate.x402Version === "number" &&
    typeof candidate.accepted === "object" &&
    candidate.accepted !== null &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

/**
 * Issues seller-signed Masumi quotes for template requirements.
 */
export class MasumiQuoteIssuer {
  /**
   * Creates an issuer.
   *
   * @param config - The seller and issuance policy.
   */
  constructor(private readonly config: MasumiIssuerConfig) {}

  /**
   * Checks a template at route-build time against this issuer's configuration.
   *
   * @param requirements - The template requirements.
   * @throws When the template cannot be issued as declared.
   */
  assertTemplate(requirements: PaymentRequirements): void {
    assertMasumiTemplate(requirements, this.config);
  }

  /**
   * Resolves the paid payload a 402 is being built in response to, if any.
   *
   * @param paymentPayload - The payload core passed to the hook, when it did.
   * @param transportContext - The transport context handed to the hook.
   * @returns The payload, or undefined for an unpaid request.
   */
  paidPayload(
    paymentPayload: PaymentPayload | undefined,
    transportContext: unknown,
  ): PaymentPayload | undefined {
    return (
      paymentPayload ??
      paymentPayloadFromTransportContext(transportContext) ??
      this.config.paymentPayloadFromTransport?.(transportContext)
    );
  }

  /**
   * Issues a fresh quote for a template.
   *
   * The result keeps the template's `payTo`, `amount`, `asset` and
   * `maxTimeoutSeconds` (the seller signs them) and every template `extra` key,
   * so it satisfies core's additive enrichment policy. `payByTime` is
   * `now + maxTimeoutSeconds`; the later deadlines follow the configured offsets.
   *
   * @param template - The template requirements.
   * @param resourceInfo - The protected resource.
   * @param transportContext - Transport-specific request context, if any.
   * @returns The complete, seller-signed requirements.
   */
  async issue(
    template: PaymentRequirements,
    resourceInfo: ResourceInfo,
    transportContext: unknown,
  ): Promise<PaymentRequirements> {
    const templateExtra = (template.extra ?? {}) as Record<string, unknown>;
    const seller =
      typeof this.config.seller === "function"
        ? await this.config.seller(template.network)
        : this.config.seller;
    const deployment =
      (templateExtra.deployment as MasumiDeployment | undefined) ?? this.config.deployment;
    const commitment = await (this.config.commitment ?? defaultCommitment)({
      requirement: template,
      resourceInfo,
      transportContext,
    });
    const offsets = { ...DEFAULT_MASUMI_DEADLINE_OFFSETS, ...this.config.deadlines };
    const payByMs = Date.now() + template.maxTimeoutSeconds * 1000;

    const issued = await issueMasumiRequirements({
      network: template.network,
      asset: template.asset,
      amount: template.amount,
      maxTimeoutSeconds: template.maxTimeoutSeconds,
      sellerAddress: seller.sellerAddress,
      signTerms: seller.signTerms,
      commitment,
      payByTime: payByMs.toString(),
      submitResultTime: (payByMs + offsets.submitResultAfterPayByMs).toString(),
      unlockTime: (payByMs + offsets.unlockAfterPayByMs).toString(),
      externalDisputeUnlockTime: (payByMs + offsets.externalDisputeUnlockAfterPayByMs).toString(),
      ...(this.config.sellerReturnAddress !== undefined
        ? { sellerReturnAddress: this.config.sellerReturnAddress }
        : {}),
      ...(this.config.agentIdentifier !== undefined
        ? { agentIdentifier: this.config.agentIdentifier }
        : {}),
      ...(templateExtra.confirmationPolicy !== undefined
        ? {
            confirmationPolicy: templateExtra.confirmationPolicy as { l1Confirmations: number },
          }
        : {}),
      ...(deployment ? { deployment } : {}),
      ...(this.config.maxDeadlineHorizonMs !== undefined
        ? { maxDeadlineHorizonMs: this.config.maxDeadlineHorizonMs }
        : {}),
    });
    if (issued.payTo !== template.payTo) {
      throw new Error(
        `Masumi route payTo must be the escrow address ${issued.payTo} on ${template.network}; got ${template.payTo || "(empty)"}`,
      );
    }
    return {
      ...template,
      extra: {
        ...issued.extra,
        // Outside termsDigest and part of the template baseline, so it must survive.
        ...(templateExtra.areFeesSponsored !== undefined
          ? { areFeesSponsored: templateExtra.areFeesSponsored }
          : {}),
      },
    };
  }
}

/**
 * Default request commitment: the protected resource URL.
 *
 * @param context - The issuance context.
 * @returns One `jcs` commitment part.
 */
function defaultCommitment(context: MasumiIssueContext): MasumiCommitmentInput[] {
  return [
    {
      name: "resource",
      canonicalization: "jcs",
      mediaType: "application/json",
      content: { url: context.resourceInfo.url },
    },
  ];
}
