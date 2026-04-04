// Shared extension utilities
export { WithExtensions } from "./types";

// Bazaar extension
export * from "./bazaar";
export { bazaarResourceServerExtension } from "./bazaar/server";

// Sign-in-with-x extension
export * from "./sign-in-with-x";

// Offer/Receipt extension
export * from "./offer-receipt";

// Operation-binding extension
export {
  OPERATION_BINDING,
  operationBindingSchema,
  isEIP712OperationReceipt,
  isJWSOperationReceipt,
  createOperationBindingInput,
  getOperationBindingCanonicalBytes,
  computeOperationDigest,
  verifyOperationReceiptMatchesInput,
  createOperationReceiptDomain,
  OPERATION_RECEIPT_TYPES,
  prepareOperationReceiptForEIP712,
  hashOperationReceiptTypedData,
  createOperationReceiptPayload,
  createOperationReceiptJWS,
  createOperationReceiptEIP712,
  extractOperationReceiptPayload,
  verifyOperationReceiptSignatureEIP712,
  verifyOperationReceiptSignatureJWS,
  declareOperationBindingExtension,
  operationBindingResourceServerExtension,
  type JsonArray,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type OperationBindingCanonicalization,
  type OperationBindingComponents,
  type OperationBindingDeclaration,
  type OperationBindingDigestAlgorithm,
  type OperationBindingExtension,
  type OperationBindingInfo,
  type OperationBindingLogicalInput,
  type OperationBindingSchema,
  type OperationBindingSignatureFormat,
  type OperationBindingTransport,
  type OperationReceiptInput,
  type OperationReceiptPayload,
  type SignedOperationReceipt,
  type JWSOperationReceipt,
  type EIP712OperationReceipt,
  type EIP712VerificationResult as OperationBindingEIP712VerificationResult,
  type SignTypedDataFn as OperationBindingSignTypedDataFn,
} from "./operation-binding";

// Payment-identifier extension
export * from "./payment-identifier";
export { paymentIdentifierResourceServerExtension } from "./payment-identifier/resourceServer";

// EIP-2612 Gas Sponsoring extension
export * from "./eip2612-gas-sponsoring";

// ERC-20 Approval Gas Sponsoring extension
export * from "./erc20-approval-gas-sponsoring";
