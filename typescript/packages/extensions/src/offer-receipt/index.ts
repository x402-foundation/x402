/**
 * x402 Offer/Receipt Extension
 */

// Types
export {
  OFFER_RECEIPT,
  type SignatureFormat,
  type Signer,
  type JWSSigner,
  type EIP712Signer,
  type OfferPayload,
  type SignedOffer,
  type JWSSignedOffer,
  type EIP712SignedOffer,
  type ReceiptPayload,
  type SignedReceipt,
  type JWSSignedReceipt,
  type EIP712SignedReceipt,
  type OfferReceiptDeclaration,
  type OfferReceiptIssuer,
  type OfferInput,
  type ReceiptInput,
  isJWSSignedOffer,
  isEIP712SignedOffer,
  isJWSSignedReceipt,
  isEIP712SignedReceipt,
  isJWSSigner,
  isEIP712Signer,
} from "./types";

// Signing utilities and offer/receipt creation
export {
  // Canonicalization
  canonicalize,
  hashCanonical,
  getCanonicalBytes,
  // JWS
  createJWS,
  extractJWSHeader,
  extractJWSPayload,
  // EIP-712
  createOfferDomain,
  createReceiptDomain,
  OFFER_TYPES,
  RECEIPT_TYPES,
  prepareOfferForEIP712,
  prepareReceiptForEIP712,
  hashOfferTypedData,
  hashReceiptTypedData,
  signOfferEIP712,
  signReceiptEIP712,
  type SignTypedDataFn,
  // Network utilities
  extractEIP155ChainId,
  convertNetworkStringToCAIP2,
  extractChainIdFromCAIP2,
  // Offer creation
  createOfferJWS,
  createOfferEIP712,
  extractOfferPayload,
  // Receipt creation
  createReceiptJWS,
  createReceiptEIP712,
  extractReceiptPayload,
} from "./signing";

// Server extension and factory functions
export {
  createOfferReceiptExtension,
  declareOfferReceiptExtension,
  createJWSOfferReceiptIssuer,
  createEIP712OfferReceiptIssuer,
} from "./server";

// Client utilities for extracting offers/receipts
export {
  decodeSignedOffers,
  extractOffersFromPaymentRequired,
  extractReceiptFromResponse,
  findAcceptsObjectFromSignedOffer,
  verifyReceiptMatchesOffer,
  type DecodedOffer,
} from "./client";

// Verification utilities (exported from signing.ts)
export {
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureEIP712,
  verifyOfferSignatureJWS,
  verifyReceiptSignatureJWS,
  type EIP712VerificationResult,
} from "./signing";

// DID resolution utilities
export { extractPublicKeyFromKid } from "./did";
