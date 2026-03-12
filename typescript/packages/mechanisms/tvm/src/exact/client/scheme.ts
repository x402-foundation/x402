import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import {
  Address,
  beginCell,
  internal,
  storeMessageRelaxed,
  Cell,
} from "@ton/core";
import { ClientTvmSigner } from "../../signer";
import { TvmPaymentPayload } from "../../types";
import {
  JETTON_TRANSFER_OP,
  BASE_JETTON_SEND_AMOUNT,
  DEFAULT_VALID_UNTIL_OFFSET,
} from "../../constants";

/**
 * TVM client implementation for the Exact payment scheme.
 *
 * Builds gasless USDT payments on TON using TONAPI relay.
 * Flow:
 * 1. Resolve jetton wallet address
 * 2. Build jetton transfer payload
 * 3. Estimate gasless fees via TONAPI
 * 4. Sign W5R1 transfer with estimated messages
 * 5. Return payment payload with settlement BOC
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

    // Resolve jetton wallet address for sender
    const jettonWalletAddr = await this.signer.getJettonWallet(
      tokenMaster,
      this.signer.address,
    );

    // Get relay address for excess returns
    const relayAddress = await this.signer.getRelayAddress();

    // Build jetton transfer payload
    const payToAddr = Address.parseRaw(payTo);
    const relayAddr = Address.parseRaw(relayAddress);
    const jettonAmount = BigInt(amount);

    const transferPayload = beginCell()
      .storeUint(JETTON_TRANSFER_OP, 32) // op: jetton_transfer
      .storeUint(0, 64) // query_id
      .storeCoins(jettonAmount) // jetton amount
      .storeAddress(payToAddr) // destination
      .storeAddress(relayAddr) // response_destination (excess -> relay)
      .storeBit(false) // no custom_payload
      .storeCoins(1n) // forward_ton_amount (1 nanoton for notification)
      .storeMaybeRef(undefined) // no forward_payload
      .endCell();

    // Wrap in internal message for gasless estimate
    const jettonWallet = Address.parseRaw(jettonWalletAddr);
    const messageToEstimate = beginCell()
      .storeWritable(
        storeMessageRelaxed(
          internal({
            to: jettonWallet,
            bounce: true,
            value: BASE_JETTON_SEND_AMOUNT,
            body: transferPayload,
          }),
        ),
      )
      .endCell();

    // Estimate gasless fee
    const estimatedMessages = await this.signer.gaslessEstimate(
      tokenMaster,
      this.signer.address,
      this.signer.publicKey,
      [messageToEstimate],
    );

    // Get seqno
    const seqno = await this.signer.getSeqno();

    // Sign W5R1 transfer
    const validUntil = Math.ceil(Date.now() / 1000) + DEFAULT_VALID_UNTIL_OFFSET;

    const messagesToSign = estimatedMessages.map((m) => ({
      address: m.address,
      amount: BigInt(m.amount),
      body: m.payload,
    }));

    const settlementBoc = await this.signer.signTransfer(
      seqno,
      validUntil,
      messagesToSign,
    );

    // Build x402 payment payload
    const nonce = crypto.randomUUID();

    // Compute commission: sum of estimated message amounts (relay takes fees from these)
    const commission = estimatedMessages
      .reduce((sum, m) => sum + BigInt(m.amount), 0n)
      .toString();

    const tvmPayload: TvmPaymentPayload = {
      from: this.signer.address,
      to: payTo,
      tokenMaster,
      amount: jettonAmount.toString(),
      validUntil,
      nonce,
      signedMessages: estimatedMessages.map((m) => ({
        address: m.address,
        amount: m.amount,
        payload: m.payload
          ? m.payload.toBoc().toString("base64")
          : "",
        stateInit: m.stateInit,
      })),
      commission,
      settlementBoc,
      walletPublicKey: this.signer.publicKey,
    };

    return {
      x402Version,
      payload: tvmPayload as unknown as Record<string, unknown>,
    };
  }
}
