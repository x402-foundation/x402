/**
 * Type definitions for the x402 Operation-Binding Extension
 *
 * This companion extension binds a payment receipt to one exact validated
 * HTTP operation by hashing a canonical logical input object.
 */

export const OPERATION_BINDING = "operation-binding";

export type OperationBindingTransport = "http";
export type OperationBindingCanonicalization = "rfc8785-jcs";
export type OperationBindingDigestAlgorithm = "sha-256";
export type OperationBindingSignatureFormat = "jws" | "eip712";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];

/**
 * Static route declaration used by resource servers.
 * Dynamic request fields (method, resourceUrl, pathTemplate) are enriched from
 * HTTP transport context when generating PaymentRequired responses.
 */
export interface OperationBindingDeclaration {
  operationId: string;
  policyVersion: string;
  bindPathParams?: boolean;
  bindQuery?: boolean;
  bindBody?: boolean;
}

export interface OperationBindingInfo {
  transport: OperationBindingTransport;
  resourceUrl: string;
  method: string;
  pathTemplate: string;
  operationId: string;
  policyVersion: string;
  canonicalization: OperationBindingCanonicalization;
  digestAlgorithm: OperationBindingDigestAlgorithm;
  bindPathParams: boolean;
  bindQuery: boolean;
  bindBody: boolean;
}

export interface OperationBindingSchema {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface OperationBindingExtension {
  info: OperationBindingInfo;
  schema: OperationBindingSchema;
}

export interface OperationBindingLogicalInput {
  version: 1;
  transport: OperationBindingTransport;
  resourceUrl: string;
  method: string;
  pathTemplate: string;
  operationId: string;
  policyVersion: string;
  pathParams: JsonObject | null;
  query: JsonObject | null;
  body: JsonValue | null;
}

export interface OperationBindingComponents {
  pathParams?: Record<string, unknown> | null;
  query?: Record<string, unknown> | null;
  body?: unknown;
}

export interface OperationReceiptPayload {
  version: number;
  network: string;
  transport: OperationBindingTransport;
  resourceUrl: string;
  method: string;
  pathTemplate: string;
  operationId: string;
  policyVersion: string;
  canonicalization: OperationBindingCanonicalization;
  digestAlgorithm: OperationBindingDigestAlgorithm;
  bindPathParams: boolean;
  bindQuery: boolean;
  bindBody: boolean;
  operationDigest: string;
  payer: string;
  issuedAt: number;
}

export interface OperationReceiptInput extends OperationBindingComponents {
  binding: OperationBindingInfo;
  payer: string;
  network: string;
  issuedAt?: number;
}

export interface JWSOperationReceipt {
  format: "jws";
  signature: string;
}

export interface EIP712OperationReceipt {
  format: "eip712";
  payload: OperationReceiptPayload;
  signature: string;
}

export type SignedOperationReceipt = JWSOperationReceipt | EIP712OperationReceipt;

export function isJWSOperationReceipt(
  receipt: SignedOperationReceipt,
): receipt is JWSOperationReceipt {
  return receipt.format === "jws";
}

export function isEIP712OperationReceipt(
  receipt: SignedOperationReceipt,
): receipt is EIP712OperationReceipt {
  return receipt.format === "eip712";
}

