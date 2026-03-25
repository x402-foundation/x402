import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { Address, beginCell, Cell } from "@ton/core";
import { TonClient, JettonMaster, WalletContractV5R1 } from "@ton/ton";
import { ClientTvmSigner } from "../../signer";
import { TvmPaymentPayload } from "../../types";
import { DEFAULT_VALID_UNTIL_OFFSET } from "../../constants";

/** Default TON RPC endpoint (toncenter.com free tier, 1 req/sec without API key) */
const DEFAULT_RPC_URL = "https://toncenter.com/api/v2/jsonRPC";

/** Default forward TON amount for jetton transfers (0.01 TON covers transfer chain) */
const DEFAULT_JETTON_FWD_AMOUNT = 10_000_000n; // 0.01 TON in nanoTON

/**
 * Configuration for TVM client scheme.
 */
export interface ExactTvmClientConfig {
  /** TON RPC endpoint URL (default: toncenter.com free tier) */
  rpcUrl?: string;
  /** Optional API key for higher rate limits */
  apiKey?: string;
}

/**
 * Build a TEP-74 jetton_transfer body cell.
 */
function buildJettonTransferBody(
  destination: Address,
  amount: bigint,
  responseDestination: Address,
  queryId: bigint = 0n,
  forwardTonAmount: bigint = 1n,
): Cell {
  return beginCell()
    .storeUint(0x0f8a7ea5, 32)    // op: jetton_transfer
    .storeUint(queryId, 64)
    .storeCoins(amount)
    .storeAddress(destination)
    .storeAddress(responseDestination)
    .storeBit(false)                // no custom_payload
    .storeCoins(forwardTonAmount)
    .storeBit(false)                // no forward_payload
    .endCell();
}

/**
 * TVM client implementation for the Exact payment scheme.
 *
 * Resolves signing data (seqno, Jetton wallet) via TON RPC,
 * then signs locally and returns the payment payload.
 */
export class ExactTvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  private readonly rpcUrl: string;
  private readonly apiKey?: string;

  constructor(
    private readonly signer: ClientTvmSigner,
    options?: ExactTvmClientConfig,
  ) {
    this.rpcUrl = options?.rpcUrl ?? DEFAULT_RPC_URL;
    this.apiKey = options?.apiKey;
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const { asset, amount, payTo } = paymentRequirements;

    // Create TON RPC client
    const client = new TonClient({
      endpoint: this.rpcUrl,
      apiKey: this.apiKey,
    });

    // Resolve client's Jetton wallet address via RPC
    const jettonMaster = client.open(
      JettonMaster.create(Address.parseRaw(asset)),
    );
    const jettonWalletAddress = await jettonMaster.getWalletAddress(
      Address.parseRaw(this.signer.address),
    );

    // Get client wallet seqno via RPC
    const wallet = client.open(
      WalletContractV5R1.create({
        workchain: 0,
        publicKey: Buffer.from(this.signer.publicKey, "hex"),
      }),
    );
    const seqno = await wallet.getSeqno();

    // Build jetton transfer body
    const jettonBody = buildJettonTransferBody(
      Address.parseRaw(payTo),           // destination
      BigInt(amount),                     // jetton amount
      Address.parseRaw(this.signer.address), // response_destination (excess back to sender)
    );

    const timeoutSeconds = paymentRequirements.maxTimeoutSeconds ?? DEFAULT_VALID_UNTIL_OFFSET;
    const validUntil = Math.floor(Date.now() / 1000) + timeoutSeconds;

    // Sign the W5R1 transfer — returns internal message BoC
    const messagesToSign = [{
      address: jettonWalletAddress.toRawString(),
      amount: DEFAULT_JETTON_FWD_AMOUNT,
      body: jettonBody,
    }];

    const settlementBoc = await this.signer.signTransfer(
      seqno,
      validUntil,
      messagesToSign,
    );

    // Minimal payload: BoC + asset. Everything else derived by facilitator.
    const tvmPayload: TvmPaymentPayload = {
      settlementBoc,
      asset,
    };

    return {
      x402Version,
      payload: tvmPayload as unknown as Record<string, unknown>,
    };
  }
}
