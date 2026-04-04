import * as jose from "jose";
import { hashTypedData, recoverTypedDataAddress, type Hex, type TypedDataDomain } from "viem";
import type { JWSSigner } from "../offer-receipt/types";
import { createJWS, extractJWSHeader, extractJWSPayload } from "../offer-receipt/signing";
import { extractPublicKeyFromKid } from "../offer-receipt/did";
import { computeOperationDigest } from "./digest";
import type {
  EIP712OperationReceipt,
  JWSOperationReceipt,
  OperationReceiptInput,
  OperationReceiptPayload,
  SignedOperationReceipt,
} from "./types";
import { isEIP712OperationReceipt, isJWSOperationReceipt } from "./types";

const OPERATION_RECEIPT_VERSION = 1;

export function createOperationReceiptDomain(): TypedDataDomain {
  return { name: "x402 operation receipt", version: "1", chainId: 1 };
}

export const OPERATION_RECEIPT_TYPES = {
  OperationReceipt: [
    { name: "version", type: "uint256" },
    { name: "network", type: "string" },
    { name: "transport", type: "string" },
    { name: "resourceUrl", type: "string" },
    { name: "method", type: "string" },
    { name: "pathTemplate", type: "string" },
    { name: "operationId", type: "string" },
    { name: "policyVersion", type: "string" },
    { name: "canonicalization", type: "string" },
    { name: "digestAlgorithm", type: "string" },
    { name: "bindPathParams", type: "bool" },
    { name: "bindQuery", type: "bool" },
    { name: "bindBody", type: "bool" },
    { name: "operationDigest", type: "string" },
    { name: "payer", type: "string" },
    { name: "issuedAt", type: "uint256" },
  ],
};

export type SignTypedDataFn = (params: {
  domain: TypedDataDomain;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}) => Promise<Hex>;

export function prepareOperationReceiptForEIP712(payload: OperationReceiptPayload): {
  version: bigint;
  network: string;
  transport: string;
  resourceUrl: string;
  method: string;
  pathTemplate: string;
  operationId: string;
  policyVersion: string;
  canonicalization: string;
  digestAlgorithm: string;
  bindPathParams: boolean;
  bindQuery: boolean;
  bindBody: boolean;
  operationDigest: string;
  payer: string;
  issuedAt: bigint;
} {
  return {
    version: BigInt(payload.version),
    network: payload.network,
    transport: payload.transport,
    resourceUrl: payload.resourceUrl,
    method: payload.method,
    pathTemplate: payload.pathTemplate,
    operationId: payload.operationId,
    policyVersion: payload.policyVersion,
    canonicalization: payload.canonicalization,
    digestAlgorithm: payload.digestAlgorithm,
    bindPathParams: payload.bindPathParams,
    bindQuery: payload.bindQuery,
    bindBody: payload.bindBody,
    operationDigest: payload.operationDigest,
    payer: payload.payer,
    issuedAt: BigInt(payload.issuedAt),
  };
}

export function hashOperationReceiptTypedData(payload: OperationReceiptPayload): Hex {
  return hashTypedData({
    domain: createOperationReceiptDomain(),
    types: OPERATION_RECEIPT_TYPES,
    primaryType: "OperationReceipt",
    message: prepareOperationReceiptForEIP712(payload),
  });
}

export async function createOperationReceiptPayload(
  input: OperationReceiptInput,
): Promise<OperationReceiptPayload> {
  const operationDigest = await computeOperationDigest(input.binding, input);

  return {
    version: OPERATION_RECEIPT_VERSION,
    network: input.network,
    transport: input.binding.transport,
    resourceUrl: input.binding.resourceUrl,
    method: input.binding.method,
    pathTemplate: input.binding.pathTemplate,
    operationId: input.binding.operationId,
    policyVersion: input.binding.policyVersion,
    canonicalization: input.binding.canonicalization,
    digestAlgorithm: input.binding.digestAlgorithm,
    bindPathParams: input.binding.bindPathParams,
    bindQuery: input.binding.bindQuery,
    bindBody: input.binding.bindBody,
    operationDigest,
    payer: input.payer,
    issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
  };
}

export async function createOperationReceiptJWS(
  input: OperationReceiptInput,
  signer: JWSSigner,
): Promise<JWSOperationReceipt> {
  const payload = await createOperationReceiptPayload(input);
  const signature = await createJWS(payload, signer);
  return {
    format: "jws",
    signature,
  };
}

export async function createOperationReceiptEIP712(
  input: OperationReceiptInput,
  signTypedData: SignTypedDataFn,
): Promise<EIP712OperationReceipt> {
  const payload = await createOperationReceiptPayload(input);
  const signature = await signTypedData({
    domain: createOperationReceiptDomain(),
    types: OPERATION_RECEIPT_TYPES,
    primaryType: "OperationReceipt",
    message: prepareOperationReceiptForEIP712(payload) as unknown as Record<string, unknown>,
  });

  return {
    format: "eip712",
    payload,
    signature,
  };
}

export function extractOperationReceiptPayload(
  receipt: SignedOperationReceipt,
): OperationReceiptPayload {
  if (isJWSOperationReceipt(receipt)) {
    return extractJWSPayload<OperationReceiptPayload>(receipt.signature);
  }

  if (isEIP712OperationReceipt(receipt)) {
    return receipt.payload;
  }

  throw new Error(`Unknown receipt format: ${(receipt as SignedOperationReceipt).format}`);
}

export interface EIP712VerificationResult<T> {
  signer: Hex;
  payload: T;
}

export async function verifyOperationReceiptSignatureEIP712(
  receipt: EIP712OperationReceipt,
): Promise<EIP712VerificationResult<OperationReceiptPayload>> {
  if (receipt.format !== "eip712") {
    throw new Error(`Expected eip712 format, got ${receipt.format}`);
  }

  const signer = await recoverTypedDataAddress({
    domain: createOperationReceiptDomain(),
    types: OPERATION_RECEIPT_TYPES,
    primaryType: "OperationReceipt",
    message: prepareOperationReceiptForEIP712(receipt.payload),
    signature: receipt.signature as Hex,
  });

  return {
    signer,
    payload: receipt.payload,
  };
}

async function resolveVerificationKey(
  jws: string,
  providedKey?: jose.KeyLike | jose.JWK,
): Promise<jose.KeyLike> {
  if (providedKey) {
    if ("kty" in providedKey) {
      const key = await jose.importJWK(providedKey);
      if (key instanceof Uint8Array) {
        throw new Error("Symmetric keys are not supported for JWS verification");
      }
      return key;
    }
    return providedKey;
  }

  const header = extractJWSHeader(jws);
  if (!header.kid) {
    throw new Error("No public key provided and JWS header missing kid");
  }

  return extractPublicKeyFromKid(header.kid);
}

export async function verifyOperationReceiptSignatureJWS(
  receipt: JWSOperationReceipt,
  publicKey?: jose.KeyLike | jose.JWK,
): Promise<OperationReceiptPayload> {
  if (receipt.format !== "jws") {
    throw new Error(`Expected jws format, got ${receipt.format}`);
  }

  const key = await resolveVerificationKey(receipt.signature, publicKey);
  const { payload } = await jose.compactVerify(receipt.signature, key);
  return JSON.parse(new TextDecoder().decode(payload)) as OperationReceiptPayload;
}

