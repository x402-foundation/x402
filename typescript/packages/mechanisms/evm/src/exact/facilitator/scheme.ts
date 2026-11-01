import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { InMemoryPendingSettlementStore, PendingSettlementStore } from "@x402/core/facilitator";
import { isAddress, isHex } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactEIP3009Payload, ExactPermit2Payload } from "../../types";
import { verifyEIP3009, settleEIP3009 } from "./eip3009";
import * as Errors from "./errors";
import { verifyPermit2, settlePermit2 } from "./permit2";

export interface ExactEvmSchemeConfig {
  /**
   * Allowlist of factory contract addresses (hex strings, case-insensitive) that the facilitator
   * will call when deploying an undeployed smart wallet via ERC-6492.
   *
   * A non-empty list enables ERC-4337 smart wallet deployment via EIP-6492. An empty or omitted
   * list denies all factory deployment calls (feature disabled by default).
   *
   * @default []
   */
  eip6492AllowedFactories?: string[];
  /**
   * If enabled, run on-chain simulation during settle's re-verify.
   *
   * @default false
   */
  simulateInSettle?: boolean;
  /**
   * Lets a retried settle for the same payload reconcile against an
   * already-broadcast transaction instead of re-verifying and
   * re-broadcasting (see {@link PendingSettlementStore}). Defaults to a
   * fresh in-memory store shared across all settle calls on this scheme
   * instance. Inject a shared, network-backed implementation (e.g. Redis)
   * for a multi-instance facilitator so a settle retry landing on a
   * different replica still reconciles correctly.
   */
  pendingSettlementStore?: PendingSettlementStore;
}

/**
 * EVM facilitator implementation for the Exact payment scheme.
 * Thin router that delegates to EIP-3009 or Permit2 based on payload type.
 * All extension handling (EIP-2612, ERC-20 approval gas sponsoring) is owned
 * by the Permit2 functions via FacilitatorContext.
 */
export class ExactEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "eip155:*";
  private readonly config: Required<Omit<ExactEvmSchemeConfig, "pendingSettlementStore">>;
  private readonly pendingStore: PendingSettlementStore;

  /**
   * Creates a new ExactEvmScheme facilitator instance.
   *
   * @param signer - The EVM signer for facilitator operations
   * @param config - Optional configuration
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    config?: ExactEvmSchemeConfig,
  ) {
    this.config = {
      eip6492AllowedFactories: config?.eip6492AllowedFactories ?? [],
      simulateInSettle: config?.simulateInSettle ?? false,
    };
    this.pendingStore = config?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
  }

  /**
   * Returns undefined — EVM has no mechanism-specific extra data.
   *
   * @param _ - The network identifier (unused)
   * @returns undefined
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Returns facilitator wallet addresses for the supported response.
   *
   * @param _ - The network identifier (unused, addresses are network-agnostic)
   * @returns Array of facilitator wallet addresses
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload. Routes to Permit2 or EIP-3009 based on payload type.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements
   * @param context - Optional facilitator context for extension capabilities
   * @param _ - Payment required extensions (unused; reserved for interface parity)
   * @returns Promise resolving to verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
    _?: Record<string, unknown>,
  ): Promise<VerifyResponse> {
    const kind = exactPayloadKind(payload.payload);
    if (!kind) {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayload };
    }

    switch (kind) {
      case "permit2":
        return verifyPermit2(
          this.signer,
          payload,
          requirements,
          payload.payload as ExactPermit2Payload,
          context,
        );
      case "eip3009": {
        const { response } = await verifyEIP3009(
          this.signer,
          payload,
          requirements,
          payload.payload as ExactEIP3009Payload,
          undefined,
          this.config.eip6492AllowedFactories,
        );
        return response;
      }
      default: {
        const unreachable: never = kind;
        return unreachable;
      }
    }
  }

  /**
   * Settles a payment. Routes to Permit2 or EIP-3009 based on payload type.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements
   * @param context - Optional facilitator context for extension capabilities
   * @returns Promise resolving to settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const kind = exactPayloadKind(payload.payload);
    if (!kind) {
      return {
        success: false,
        errorReason: Errors.ErrInvalidPayload,
        transaction: "",
        network: payload.accepted.network,
      };
    }

    switch (kind) {
      case "permit2":
        return settlePermit2(
          this.signer,
          payload,
          requirements,
          payload.payload as ExactPermit2Payload,
          context,
          { simulateInSettle: this.config.simulateInSettle },
          this.pendingStore,
        );
      case "eip3009":
        return settleEIP3009(
          this.signer,
          payload,
          requirements,
          payload.payload as ExactEIP3009Payload,
          this.config,
          context,
          this.pendingStore,
        );
      default: {
        const unreachable: never = kind;
        return unreachable;
      }
    }
  }
}

type ExactPayloadKind = "eip3009" | "permit2";

/**
 * True when `value` is a string `BigInt` accepts.
 *
 * @param value - Candidate value
 * @returns Whether `value` is a bigint string
 */
function isBigIntString(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    BigInt(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * True for any 20-byte hex address. `strict: false` matches `getAddress`, which checksums later.
 *
 * @param value - Candidate address field
 * @returns Whether the field is an EVM address
 */
function isEvmAddress(value: unknown): boolean {
  return typeof value === "string" && isAddress(value, { strict: false });
}

/**
 * True for a non-null, non-array object.
 *
 * @param value - Candidate value
 * @returns Whether `value` is a non-null, non-array object
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `value` has EIP-3009 authorization fields.
 *
 * @param value - Candidate authorization
 * @returns Whether `value` is an EIP-3009 authorization
 */
function isEip3009Authorization(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return (
    isEvmAddress(value.from) &&
    isEvmAddress(value.to) &&
    isBigIntString(value.value) &&
    isBigIntString(value.validAfter) &&
    isBigIntString(value.validBefore) &&
    isHex(value.nonce)
  );
}

/**
 * True when `value` has Permit2 authorization fields.
 *
 * @param value - Candidate authorization
 * @returns Whether `value` is a Permit2 authorization
 */
function isPermit2Authorization(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.permitted) || !isObject(value.witness)) {
    return false;
  }
  const permitted = value.permitted;
  const witness = value.witness;
  return (
    isEvmAddress(value.from) &&
    isEvmAddress(value.spender) &&
    isBigIntString(value.nonce) &&
    isBigIntString(value.deadline) &&
    isEvmAddress(permitted.token) &&
    isBigIntString(permitted.amount) &&
    isEvmAddress(witness.to) &&
    isBigIntString(witness.validAfter)
  );
}

/**
 * Classifies a client payload as EIP-3009 or Permit2.
 *
 * `parseErc6492Signature` throws when `signature` is not a string, and that
 * call happens after an `eth_getCode` lookup. Reject it here.
 *
 * @param payload - Raw `PaymentPayload.payload`
 * @returns The payload kind, or undefined when the shape does not match
 */
function exactPayloadKind(payload: unknown): ExactPayloadKind | undefined {
  if (!isObject(payload) || typeof payload.signature !== "string") {
    return undefined;
  }
  if ("permit2Authorization" in payload) {
    return isPermit2Authorization(payload.permit2Authorization) ? "permit2" : undefined;
  }
  return isEip3009Authorization(payload.authorization) ? "eip3009" : undefined;
}
