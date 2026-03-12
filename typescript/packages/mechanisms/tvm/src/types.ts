/**
 * A signed W5 internal message (from TONAPI gasless flow).
 */
export interface SignedW5Message {
  /** Destination address */
  address: string;
  /** Amount in nanoTON */
  amount: string;
  /** Payload as base64 BOC */
  payload: string;
  /** State init as base64 BOC (optional) */
  stateInit?: string;
}

/**
 * TVM payment payload — the scheme-specific data inside PaymentPayload.payload.
 */
export interface TvmPaymentPayload {
  /** Sender wallet address (raw format: 0:hex) */
  from: string;
  /** Recipient wallet address (raw format: 0:hex) */
  to: string;
  /** Jetton master contract address (raw format: 0:hex) */
  tokenMaster: string;
  /** Amount in token's smallest unit (e.g. 6 decimals for USDT) */
  amount: string;
  /** Valid until unix timestamp */
  validUntil: number;
  /** Random nonce for replay protection */
  nonce: string;
  /** Signed messages for W5 wallet (from TONAPI gasless/estimate) */
  signedMessages: SignedW5Message[];
  /** Commission amount in token units (paid to relay) */
  commission: string;
  /** Full signed external message BOC (base64) for gasless/send */
  settlementBoc: string;
  /** Wallet public key (hex) for gasless/send */
  walletPublicKey: string;
}
