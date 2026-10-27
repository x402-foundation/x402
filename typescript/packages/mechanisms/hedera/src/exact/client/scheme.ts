import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { HEDERA_CRYPTO_TRANSFER_METHOD, HEDERA_TRANSFER_EXECUTOR_METHOD } from "../../constants";
import type { ClientHederaSigner } from "../../signer";
import { findDefaultAsset } from "../../defaultAssets";
import { executorListAdmits, isStringArray, parseTransferExecutorPayload } from "../../internal";
import type { ExactHederaPayloadV2, HederaAssetTransferMethod } from "../../types";
import {
  assertSupportedHederaNetwork,
  isValidHederaEntityId,
  resolveHederaAssetTransferMethod,
} from "../../utils";

/**
 * Builds the payment payload for one asset transfer method.
 */
type PaymentPayloadBuilder = (
  x402Version: number,
  paymentRequirements: PaymentRequirements,
) => Promise<PaymentPayloadResult>;

/**
 * Hedera client implementation for the Exact payment scheme.
 */
export class ExactHederaScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  findDefaultAsset = findDefaultAsset;
  /**
   * One builder per method, so adding a method without handling it fails to compile.
   */
  private readonly methods: Record<HederaAssetTransferMethod, PaymentPayloadBuilder> = {
    [HEDERA_CRYPTO_TRANSFER_METHOD]: (x402Version, paymentRequirements) =>
      this.createCryptoTransferPayload(x402Version, paymentRequirements),
    [HEDERA_TRANSFER_EXECUTOR_METHOD]: (x402Version, paymentRequirements) =>
      this.createTransferExecutorPayload(x402Version, paymentRequirements),
  };

  /**
   * Creates a new ExactHederaScheme instance.
   *
   * @param signer - Client-side Hedera signer
   */
  constructor(private readonly signer: ClientHederaSigner) {}

  /**
   * Creates a payment payload for exact Hedera payments.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Selected payment requirements
   * @param _ - Optional payment payload context
   * @returns Payload result
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (paymentRequirements.scheme !== "exact") {
      throw new Error("Unsupported scheme for Hedera exact client");
    }
    assertSupportedHederaNetwork(paymentRequirements.network);

    const method = resolveHederaAssetTransferMethod(paymentRequirements.extra);
    if (method === null) {
      throw new Error(
        `Unsupported assetTransferMethod for Hedera exact: ${JSON.stringify(paymentRequirements.extra?.assetTransferMethod)}`,
      );
    }
    return this.methods[method](x402Version, paymentRequirements);
  }

  /**
   * Creates a `cryptoTransfer` payload: a partially signed transfer the facilitator completes.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Selected `cryptoTransfer` payment requirements
   * @returns Payload result
   */
  private async createCryptoTransferPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (typeof paymentRequirements.extra?.feePayer !== "string") {
      throw new Error("feePayer is required in paymentRequirements.extra for Hedera exact");
    }

    const transaction =
      await this.signer.createPartiallySignedTransferTransaction(paymentRequirements);

    const payload: ExactHederaPayloadV2 = { transaction };
    return { x402Version, payload };
  }

  /**
   * Creates a `transferExecutor` payload from the signer's authorization hook.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Selected `transferExecutor` payment requirements
   * @returns Payload result
   */
  private async createTransferExecutorPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    const executors = paymentRequirements.extra?.executors;
    if (!isStringArray(executors) || executors.length === 0) {
      throw new Error(
        "executors is required in paymentRequirements.extra for Hedera exact transferExecutor and must be a non-empty array of executor ids",
      );
    }

    if (typeof this.signer.createTransferExecutorAuthorization !== "function") {
      throw new Error(
        "Hedera exact transferExecutor requires a signer that implements createTransferExecutorAuthorization",
      );
    }

    const payer = this.signer.accountId;
    if (!isValidHederaEntityId(payer)) {
      throw new Error(
        `Signer accountId ${JSON.stringify(payer)} is not a Hedera account id, so it cannot be payload.payer`,
      );
    }

    // The hook is integrator code and may return anything at runtime.
    const authorized: unknown =
      await this.signer.createTransferExecutorAuthorization(paymentRequirements);
    if (typeof authorized !== "object" || authorized === null) {
      throw new Error(
        `createTransferExecutorAuthorization returned ${JSON.stringify(authorized)}, not { executor, authorization }`,
      );
    }
    const { executor, authorization } = authorized as Record<string, unknown>;
    const parsed = parseTransferExecutorPayload({ payer, executor, authorization });
    if ("malformedField" in parsed) {
      throw new Error(
        parsed.malformedField === "executor"
          ? `Executor ${JSON.stringify(executor)} returned by createTransferExecutorAuthorization is not a Hedera contract id`
          : `Authorization ${JSON.stringify(authorization)} returned by createTransferExecutorAuthorization is not 0x-prefixed hex`,
      );
    }
    if (!executorListAdmits(executors, parsed.payload.executor)) {
      throw new Error(
        `Executor ${parsed.payload.executor} is not in paymentRequirements.extra.executors`,
      );
    }

    return { x402Version, payload: parsed.payload };
  }
}
