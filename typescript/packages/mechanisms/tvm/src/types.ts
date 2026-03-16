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
  /** Full signed external message BOC (base64) for settlement */
  settlementBoc: string;
  /** Wallet public key (hex) */
  walletPublicKey: string;
}
