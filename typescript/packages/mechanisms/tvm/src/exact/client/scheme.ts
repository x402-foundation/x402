import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { Cell } from "@ton/core";
import { ClientTvmSigner } from "../../signer";
import { TvmPaymentPayload } from "../../types";
import { DEFAULT_VALID_UNTIL_OFFSET } from "../../constants";

/**
 * Response from the facilitator /prepare endpoint.
 */
interface PrepareResponse {
  seqno: number;
  messages: { address: string; amount: string; payload?: string; stateInit?: string }[];
}

/**
 * TVM client implementation for the Exact payment scheme.
 *
 * Uses the self-relay architecture:
 * 1. Call facilitator /prepare to get seqno + messages
 * 2. Sign W5R1 transfer with returned messages
 * 3. Return payment payload with settlement BOC
 */
export class ExactTvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  constructor(private readonly signer: ClientTvmSigner) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const { asset: tokenMaster, amount, payTo } = paymentRequirements;

    // Get facilitator URL from payment requirements
    const facilitatorUrl = (paymentRequirements.extra as Record<string, unknown> | undefined)?.facilitatorUrl as string | undefined;
    if (!facilitatorUrl) {
      throw new Error("Missing facilitatorUrl in paymentRequirements.extra");
    }

    // Call facilitator /prepare to get seqno and messages to sign
    const prepareResponse = await fetch(`${facilitatorUrl}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.signer.address,
        to: payTo,
        tokenMaster,
        amount,
        walletPublicKey: this.signer.publicKey,
      }),
    });

    if (!prepareResponse.ok) {
      const error = await prepareResponse.text();
      throw new Error(`Facilitator /prepare failed: ${prepareResponse.status} ${error}`);
    }

    const { seqno, messages } = (await prepareResponse.json()) as PrepareResponse;

    // Sign W5R1 transfer
    const validUntil = Math.ceil(Date.now() / 1000) + DEFAULT_VALID_UNTIL_OFFSET;

    const messagesToSign = messages.map((m) => ({
      address: m.address,
      amount: BigInt(m.amount),
      body: m.payload ? Cell.fromBase64(m.payload) : null,
    }));

    const settlementBoc = await this.signer.signTransfer(
      seqno,
      validUntil,
      messagesToSign,
    );

    // Build x402 payment payload
    const nonce = crypto.randomUUID();
    const jettonAmount = BigInt(amount);

    const tvmPayload: TvmPaymentPayload = {
      from: this.signer.address,
      to: payTo,
      tokenMaster,
      amount: jettonAmount.toString(),
      validUntil,
      nonce,
      settlementBoc,
      walletPublicKey: this.signer.publicKey,
    };

    return {
      x402Version,
      payload: tvmPayload as unknown as Record<string, unknown>,
    };
  }
}
