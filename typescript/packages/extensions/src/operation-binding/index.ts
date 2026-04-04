/**
 * x402 Operation-Binding Extension
 */

export type {
  JsonArray,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  OperationBindingCanonicalization,
  OperationBindingComponents,
  OperationBindingDeclaration,
  OperationBindingDigestAlgorithm,
  OperationBindingExtension,
  OperationBindingInfo,
  OperationBindingLogicalInput,
  OperationBindingSchema,
  OperationBindingSignatureFormat,
  OperationBindingTransport,
  OperationReceiptInput,
  OperationReceiptPayload,
  SignedOperationReceipt,
  JWSOperationReceipt,
  EIP712OperationReceipt,
} from "./types";

export {
  OPERATION_BINDING,
  isEIP712OperationReceipt,
  isJWSOperationReceipt,
} from "./types";

export { operationBindingSchema } from "./schema";

export {
  createOperationBindingInput,
  getOperationBindingCanonicalBytes,
  computeOperationDigest,
  verifyOperationReceiptMatchesInput,
} from "./digest";

export {
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
  type EIP712VerificationResult,
  type SignTypedDataFn,
} from "./signing";

export {
  declareOperationBindingExtension,
  operationBindingResourceServerExtension,
} from "./resourceServer";
