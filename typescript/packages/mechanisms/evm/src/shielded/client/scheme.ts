import type {
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import type { SchemeNetworkClient } from "@x402/core/types/mechanisms";
import type { UnshieldFn } from "../types.js";

export interface ShieldedEvmClientConfig {
  unshield: UnshieldFn;
}

export class ShieldedEvmClient implements SchemeNetworkClient {
  readonly scheme = "exact";
  private unshield: UnshieldFn;

  constructor(config: ShieldedEvmClientConfig) {
    this.unshield = config.unshield;
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const { txHash } = await this.unshield(
      paymentRequirements.asset,
      paymentRequirements.amount,
      paymentRequirements.payTo,
      paymentRequirements.network,
    );

    return {
      x402Version,
      payload: { txHash },
    };
  }
}
