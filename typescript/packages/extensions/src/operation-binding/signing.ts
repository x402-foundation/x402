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

/**
 * Create the fixed EIP-712 domain used for operation-receipt signatures.
 *
 * @returns The typed-data domain shared by all operation receipts.
 */
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

/**
 * Prepare a typed-data message from an operation-receipt payload.
 *
 * @param payload - Receipt payload to encode for EIP-712 signing.
 * @returns The bigint-normalized message object expected by `viem`.
 */
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

/**
 * Hash an operation-receipt payload as EIP-712 typed data.
 *
 * @param payload - Receipt payload to hash.
 * @returns The EIP-712 digest as a hex string.
 */
export function hashOperationReceiptTypedData(payload: OperationReceiptPayload): Hex {
  return hashTypedData({
    domain: createOperationReceiptDomain(),
    types: OPERATION_RECEIPT_TYPES,
    primaryType: "OperationReceipt",
    message: prepareOperationReceiptForEIP712(payload),
  });
}

/**
 * Create the canonical payload that both JWS and EIP-712 receipts sign.
 *
 * @param input - Operation-binding metadata plus payer and request components.
 * @returns Receipt payload with a freshly computed operation digest.
 */
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

/**
 * Sign an operation receipt using the JWS format.
 *
 * @param input - Operation-binding metadata plus payer and request components.
 * @param signer - JWS signer implementation for the receipt issuer.
 * @returns Signed receipt encoded as a compact JWS.
 */
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

/**
 * Sign an operation receipt using the EIP-712 format.
 *
 * @param input - Operation-binding metadata plus payer and request components.
 * @param signTypedData - Callback that signs the prepared typed-data message.
 * @returns Signed receipt containing the payload and EIP-712 signature.
 */
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

/**
 * Extract the payload from either supported signed receipt format.
 *
 * @param receipt - Signed receipt in JWS or EIP-712 form.
 * @returns The decoded operation-receipt payload.
 */
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

/**
 * Result returned after recovering the signer of an EIP-712 receipt.
 */
export interface EIP712VerificationResult<T> {
  signer: Hex;
  payload: T;
}

/**
 * Verify an EIP-712 receipt signature and recover the signer address.
 *
 * @param receipt - Signed receipt in EIP-712 form.
 * @returns The recovered signer address together with the verified payload.
 */
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

/**
 * Resolve the public key that should be used to verify a JWS receipt.
 *
 * @param jws - Compact JWS receipt string.
 * @param providedKey - Optional explicit verification key or JWK.
 * @returns A public key usable with `jose.compactVerify`.
 */
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

/**
 * Verify a JWS receipt signature and return the decoded payload.
 *
 * @param receipt - Signed receipt in JWS form.
 * @param publicKey - Optional explicit verification key or JWK.
 * @returns The verified operation-receipt payload.
 */
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
