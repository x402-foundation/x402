/**
 * Type definitions for the x402 Offer/Receipt Extension
 *
 * Based on: x402/specs/extensions/extension-offer-and-receipt.md (v1.0)
 *
 * Offers prove payment requirements originated from a resource server.
 * Receipts prove service was delivered after payment.
 */

/**
 * Extension identifier constant
 */
export const OFFER_RECEIPT = "offer-receipt";

/**
 * Supported signature formats (§3.1)
 */
export type SignatureFormat = "jws" | "eip712";

// ============================================================================
// Low-Level Signer Interfaces
// ============================================================================

/**
 * Base signer interface for pluggable signing backends
 */
export interface Signer {
  /** Key identifier DID (e.g., did:web:api.example.com#key-1) */
  kid: string;
  /** Sign payload and return signature string */
  sign: (payload: Uint8Array) => Promise<string>;
  /** Signature format */
  format: SignatureFormat;
}

/**
 * JWS-specific signer with algorithm info
 */
export interface JWSSigner extends Signer {
  format: "jws";
  /** JWS algorithm (e.g., ES256K, EdDSA) */
  algorithm: string;
}

/**
 * EIP-712 specific signer
 */
export interface EIP712Signer extends Signer {
  format: "eip712";
  /** Chain ID for EIP-712 domain */
  chainId: number;
}

// ============================================================================
// Offer Types (§4)
// ============================================================================

/**
 * Offer payload fields (§4.2)
 *
 * Required: version, resourceUrl, scheme, network, asset, payTo, amount
 * Optional: validUntil
 */
export interface OfferPayload {
  /** Offer payload schema version (currently 1) */
  version: number;
  /** The paid resource URL */
  resourceUrl: string;
  /** Payment scheme identifier (e.g., "exact") */
  scheme: string;
  /** Blockchain network identifier (CAIP-2 format, e.g., "eip155:8453") */
  network: string;
  /** Token contract address or "native" */
  asset: string;
  /** Recipient wallet address */
  payTo: string;
  /** Required payment amount */
  amount: string;
  /** Unix timestamp (seconds) when the offer expires (optional) */
  validUntil: number;
}

/**
 * Signed offer in JWS format (§3.1.1)
 *
 * "When format = 'jws': payload MUST be omitted"
 */
export interface JWSSignedOffer {
  format: "jws";
  /** Index into accepts[] array (unsigned envelope field, §4.1.1) */
  acceptIndex?: number;
  /** JWS Compact Serialization string (header.payload.signature) */
  signature: string;
}

/**
 * Signed offer in EIP-712 format (§3.1.1)
 *
 * "When format = 'eip712': payload is REQUIRED"
 */
export interface EIP712SignedOffer {
  format: "eip712";
  /** Index into accepts[] array (unsigned envelope field, §4.1.1) */
  acceptIndex?: number;
  /** The canonical payload fields */
  payload: OfferPayload;
  /** Hex-encoded ECDSA signature (0x-prefixed, 65 bytes: r+s+v) */
  signature: string;
}

/**
 * Union type for signed offers
 */
export type SignedOffer = JWSSignedOffer | EIP712SignedOffer;

// ============================================================================
// Receipt Types (§5)
// ============================================================================

/**
 * Receipt payload fields (§5.2)
 *
 * Required: version, network, resourceUrl, payer, issuedAt
 * Optional: transaction (for verifiability over privacy)
 */
export interface ReceiptPayload {
  /** Receipt payload schema version (currently 1) */
  version: number;
  /** Blockchain network identifier (CAIP-2 format, e.g., "eip155:8453") */
  network: string;
  /** The paid resource URL */
  resourceUrl: string;
  /** Payer identifier (commonly a wallet address) */
  payer: string;
  /** Unix timestamp (seconds) when receipt was issued */
  issuedAt: number;
  /** Blockchain transaction hash (optional - for verifiability over privacy) */
  transaction: string;
}

/**
 * Signed receipt in JWS format (§3.1.1)
 */
export interface JWSSignedReceipt {
  format: "jws";
  /** JWS Compact Serialization string */
  signature: string;
}

/**
 * Signed receipt in EIP-712 format (§3.1.1)
 */
export interface EIP712SignedReceipt {
  format: "eip712";
  /** The receipt payload */
  payload: ReceiptPayload;
  /** Hex-encoded ECDSA signature */
  signature: string;
}

/**
 * Union type for signed receipts
 */
export type SignedReceipt = JWSSignedReceipt | EIP712SignedReceipt;

// ============================================================================
// Extension Configuration Types
// ============================================================================

/**
 * Declaration for the offer-receipt extension in route config
 * Used by servers to declare that a route uses offer-receipt
 */
export interface OfferReceiptDeclaration {
  /** Include transaction hash in receipt (default: false for privacy). Set to true for verifiability. */
  includeTxHash?: boolean;
  /** Offer validity duration in seconds. Default: 300 (see x402ResourceServer.ts) */
  offerValiditySeconds?: number;
}

/**
 * Input for creating an offer (derived from PaymentRequirements)
 */
export interface OfferInput {
  /** Index into accepts[] array this offer corresponds to (0-based) */
  acceptIndex: number;
  /** Payment scheme identifier */
  scheme: string;
  /** Blockchain network identifier (CAIP-2 format) */
  network: string;
  /** Token contract address or "native" */
  asset: string;
  /** Recipient wallet address */
  payTo: string;
  /** Required payment amount */
  amount: string;
  /** Offer validity duration in seconds. Default: 300 (see x402ResourceServer.ts) */
  offerValiditySeconds?: number;
}

/**
 * High-level issuer interface for the offer-receipt extension.
 * Creates and signs offers and receipts.
 * Used by createOfferReceiptExtension()
 */
export interface OfferReceiptIssuer {
  /** Key identifier DID */
  kid: string;
  /** Signature format */
  format: SignatureFormat;
  /** Create and sign an offer for a resource */
  issueOffer(resourceUrl: string, input: OfferInput): Promise<SignedOffer>;
  /** Create and sign a receipt for a completed payment */
  issueReceipt(
    resourceUrl: string,
    payer: string,
    network: string,
    transaction?: string,
  ): Promise<SignedReceipt>;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an offer is JWS format
 *
 * @param offer - The signed offer to check
 * @returns True if the offer uses JWS format
 */
export function isJWSSignedOffer(offer: SignedOffer): offer is JWSSignedOffer {
  return offer.format === "jws";
}

/**
 * Check if an offer is EIP-712 format
 *
 * @param offer - The signed offer to check
 * @returns True if the offer uses EIP-712 format
 */
export function isEIP712SignedOffer(offer: SignedOffer): offer is EIP712SignedOffer {
  return offer.format === "eip712";
}

/**
 * Check if a receipt is JWS format
 *
 * @param receipt - The signed receipt to check
 * @returns True if the receipt uses JWS format
 */
export function isJWSSignedReceipt(receipt: SignedReceipt): receipt is JWSSignedReceipt {
  return receipt.format === "jws";
}

/**
 * Check if a receipt is EIP-712 format
 *
 * @param receipt - The signed receipt to check
 * @returns True if the receipt uses EIP-712 format
 */
export function isEIP712SignedReceipt(receipt: SignedReceipt): receipt is EIP712SignedReceipt {
  return receipt.format === "eip712";
}

/**
 * Check if a signer is JWS format
 *
 * @param signer - The signer to check
 * @returns True if the signer uses JWS format
 */
export function isJWSSigner(signer: Signer): signer is JWSSigner {
  return signer.format === "jws";
}

/**
 * Check if a signer is EIP-712 format
 *
 * @param signer - The signer to check
 * @returns True if the signer uses EIP-712 format
 */
export function isEIP712Signer(signer: Signer): signer is EIP712Signer {
  return signer.format === "eip712";
}

// ============================================================================
// Receipt Input Type
// ============================================================================

/**
 * Input for creating a receipt
 */
export interface ReceiptInput {
  /** The resource URL that was paid for */
  resourceUrl: string;
  /** The payer identifier (wallet address) */
  payer: string;
  /** The blockchain network (CAIP-2 format) */
  network: string;
  /** The transaction hash (optional, for verifiability) */
  transaction?: string;
}
