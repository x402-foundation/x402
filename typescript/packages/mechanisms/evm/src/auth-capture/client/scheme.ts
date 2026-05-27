/**
 * AuthCapture Scheme - Client
 * Builds payment payloads for auth-capture payments.
 *
 * Implements x402's SchemeNetworkClient interface so it can be registered
 * on an x402Client via client.register('eip155:84532', new AuthCaptureEvmScheme(signer)).
 */

import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { ClientEvmSigner } from "../../signer";
import { hexToBigInt } from "viem";
import {
  AUTH_CAPTURE_SCHEME,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "../constants";
import {
  computePayerAgnosticPaymentInfoHash,
  generateSalt,
  signERC3009,
  signPermit2,
} from "../nonce";
import type { AuthCaptureExtra, Eip3009Payload, PaymentInfoStruct, Permit2Payload } from "../types";
import { parseChainId } from "../utils";

/**
 * Client-side implementation of the auth-capture scheme: derives the canonical
 * payer-agnostic PaymentInfo hash, signs an ERC-3009 ReceiveWithAuthorization
 * (default) or a Permit2 PermitTransferFrom against it, and returns a wire
 * payload the facilitator can settle. Implements `SchemeNetworkClient`.
 */
export class AuthCaptureEvmScheme implements SchemeNetworkClient {
  readonly scheme = AUTH_CAPTURE_SCHEME;

  /**
   * Construct a client-side auth-capture scheme bound to a specific signer.
   *
   * @param signer - Client-side signer that exposes `address` and `signTypedData`.
   */
  constructor(private readonly signer: ClientEvmSigner) {}

  /**
   * Build and sign an auth-capture payment payload for the given requirements.
   * Validates all spec-mandated `extra` fields and the asset-transfer method
   * (default `eip3009`, alternative `permit2`), reconstructs the on-chain
   * PaymentInfo struct, computes its payer-agnostic hash, and returns the
   * signed wire payload.
   *
   * @param x402Version - Wire protocol version; only `2` is supported.
   * @param requirements - Resource server's payment requirements (includes scheme `extra`).
   * @param _ - Unused FacilitatorContext (interface compatibility).
   * @returns The signed wire payload tagged with the x402 protocol version.
   * @throws If `x402Version !== 2` or any required `extra` field is missing.
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    _?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) {
      throw new Error(`Unsupported x402Version: ${x402Version}. Only version 2 is supported.`);
    }

    const extra = requirements.extra as unknown as AuthCaptureExtra;

    // Validate required EIP-712 token-domain parameters
    if (!extra.name) {
      throw new Error(
        `EIP-712 domain parameter 'name' is required in payment requirements for asset ${requirements.asset}`,
      );
    }
    if (!extra.version) {
      throw new Error(
        `EIP-712 domain parameter 'version' is required in payment requirements for asset ${requirements.asset}`,
      );
    }
    if (!extra.captureAuthorizer) {
      throw new Error(`'captureAuthorizer' is required in payment requirements extra`);
    }
    if (!extra.feeRecipient) {
      throw new Error(`'feeRecipient' is required in payment requirements extra`);
    }
    if (typeof extra.captureDeadline !== "number") {
      throw new Error(`'captureDeadline' is required in payment requirements extra`);
    }
    if (typeof extra.refundDeadline !== "number") {
      throw new Error(`'refundDeadline' is required in payment requirements extra`);
    }
    if (typeof extra.minFeeBps !== "number") {
      throw new Error(`'minFeeBps' is required in payment requirements extra`);
    }
    if (typeof extra.maxFeeBps !== "number") {
      throw new Error(`'maxFeeBps' is required in payment requirements extra`);
    }
    if (typeof requirements.maxTimeoutSeconds !== "number") {
      throw new Error(
        `'maxTimeoutSeconds' is required in PaymentRequirements (used to derive preApprovalExpiry)`,
      );
    }

    const chainId = parseChainId(requirements.network);
    const maxAmount = requirements.amount;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const preApprovalExpiry = nowSeconds + requirements.maxTimeoutSeconds;
    const salt = generateSalt();
    const assetTransferMethod = extra.assetTransferMethod ?? "eip3009";

    // Build the canonical PaymentInfo struct (Solidity field names — do not rename).
    const paymentInfo: PaymentInfoStruct = {
      operator: extra.captureAuthorizer,
      payer: this.signer.address,
      receiver: requirements.payTo as `0x${string}`,
      token: requirements.asset as `0x${string}`,
      maxAmount,
      preApprovalExpiry,
      authorizationExpiry: extra.captureDeadline,
      refundExpiry: extra.refundDeadline,
      minFeeBps: extra.minFeeBps,
      maxFeeBps: extra.maxFeeBps,
      feeReceiver: extra.feeRecipient,
      salt,
    };

    // Payer-agnostic PaymentInfo hash — used as ERC-3009 nonce or Permit2 nonce.
    const nonce = computePayerAgnosticPaymentInfoHash(chainId, paymentInfo);

    if (assetTransferMethod === "permit2") {
      const permit2Authorization: Permit2Payload["permit2Authorization"] = {
        from: this.signer.address,
        permitted: {
          token: requirements.asset as `0x${string}`,
          amount: maxAmount,
        },
        spender: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
        nonce: hexToBigInt(nonce).toString(),
        deadline: String(preApprovalExpiry),
      };
      const signature = await signPermit2(this.signer, permit2Authorization, chainId);
      const payload: Permit2Payload = { permit2Authorization, signature, salt };
      return { x402Version, payload: payload as unknown as Record<string, unknown> };
    }

    // Default: EIP-3009 ReceiveWithAuthorization to the canonical EIP-3009 token collector.
    const authorization: Eip3009Payload["authorization"] = {
      from: this.signer.address,
      to: EIP3009_TOKEN_COLLECTOR_ADDRESS,
      value: maxAmount,
      validAfter: "0",
      validBefore: String(preApprovalExpiry),
      nonce,
    };
    const signature = await signERC3009(
      this.signer,
      authorization,
      extra,
      requirements.asset as `0x${string}`,
      chainId,
    );
    const payload: Eip3009Payload = { authorization, signature, salt };
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}
