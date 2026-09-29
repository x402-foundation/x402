import {
  Deserializer,
  SimpleTransaction,
  AccountAuthenticator,
  TransactionPayloadEntryFunction,
  TransactionPayload,
  EntryFunction,
  Aptos,
  AptosConfig,
} from "@aptos-labs/ts-sdk";
import type { DecodedAptosPayload } from "./types";
import { getAptosNetwork, getAptosRpcUrl } from "./constants";

/**
 * Deserialize an Aptos transaction and authenticator from the payment payload.
 *
 * @param transactionBase64 - The base64 encoded transaction payload
 * @returns The deserialized transaction and authenticator
 */
export function deserializeAptosPayment(transactionBase64: string): {
  transaction: SimpleTransaction;
  senderAuthenticator: AccountAuthenticator;
  entryFunction?: EntryFunction;
} {
  // Decode the base64 payload
  const decoded = Buffer.from(transactionBase64, "base64").toString("utf8");
  const parsed: DecodedAptosPayload = JSON.parse(decoded);

  // Deserialize the transaction bytes
  const transactionBytes = Uint8Array.from(parsed.transaction);
  const transaction = SimpleTransaction.deserialize(new Deserializer(transactionBytes));

  // Deserialize the authenticator bytes
  const authBytes = Uint8Array.from(parsed.senderAuthenticator);
  const senderAuthenticator = AccountAuthenticator.deserialize(new Deserializer(authBytes));

  // Only Entry Function transactions are supported
  if (!isEntryFunctionPayload(transaction.rawTransaction.payload)) {
    return { transaction, senderAuthenticator };
  }

  const entryFunction = transaction.rawTransaction.payload.entryFunction;

  return { transaction, senderAuthenticator, entryFunction };
}

/**
 * Checks if it's an entry function payload.
 *
 * @param payload - The payload to check
 * @returns True if it's an entry function payload
 */
export function isEntryFunctionPayload(
  payload: TransactionPayload,
): payload is TransactionPayloadEntryFunction {
  return "entryFunction" in payload;
}

/**
 * Create an Aptos SDK client for the given network
 *
 * @param network - CAIP-2 network identifier (e.g., "aptos:1")
 * @param rpcUrl - Optional custom RPC URL
 * @returns Aptos SDK client
 */
export function createAptosClient(network: string, rpcUrl?: string): Aptos {
  const aptosNetwork = getAptosNetwork(network);
  const fullnodeUrl = rpcUrl || getAptosRpcUrl(aptosNetwork);

  const config = new AptosConfig({
    network: aptosNetwork,
    fullnode: fullnodeUrl,
  });

  return new Aptos(config);
}

/**
 * Encode an Aptos payment payload to base64
 *
 * @param transactionBytes - The serialized transaction bytes
 * @param authenticatorBytes - The serialized authenticator bytes
 * @returns Base64 encoded payload
 */
export function encodeAptosPayload(
  transactionBytes: Uint8Array,
  authenticatorBytes: Uint8Array,
): string {
  const payload: DecodedAptosPayload = {
    transaction: Array.from(transactionBytes),
    senderAuthenticator: Array.from(authenticatorBytes),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
