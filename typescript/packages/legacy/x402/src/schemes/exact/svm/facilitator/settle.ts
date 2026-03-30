import {
  SettleResponse,
  PaymentPayload,
  PaymentRequirements,
  ExactSvmPayload,
  ErrorReasons,
} from "../../../../types/verify";
import { X402Config } from "../../../../types/config";
import {
  assertIsTransactionMessageWithBlockhashLifetime,
  Commitment,
  decompileTransactionMessageFetchingLookupTables,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  isSolanaError,
  type Transaction,
  type TransactionSigner,
  SendTransactionApi,
  SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
  SolanaRpcApiDevnet,
  SolanaRpcApiMainnet,
  RpcDevnet,
  RpcMainnet,
} from "@solana/kit";
import {
  decodeTransactionFromPayload,
  getTokenPayerFromTransaction,
  signTransactionWithSigner,
} from "../../../../shared/svm";
import { getRpcClient, getRpcSubscriptions } from "../../../../shared/svm/rpc";
import {
  createBlockHeightExceedencePromiseFactory,
  waitForRecentTransactionConfirmation,
  createRecentSignatureConfirmationPromiseFactory,
} from "@solana/transaction-confirmation";
import { verify } from "./verify";
import { SettlementCache } from "./settlement-cache";

/**
 * Settle the payment payload against the payment requirements.
 * TODO: handle durable nonce lifetime transactions
 *
 * @param signer - The signer that will sign the transaction
 * @param payload - The payment payload to settle
 * @param paymentRequirements - The payment requirements to settle against
 * @param config - Optional configuration for X402 operations (e.g., custom RPC URLs)
 * @returns A SettleResponse indicating if the payment is settled and any error reason
 */
const settlementCache = new SettlementCache();

/**
 * Settles an exact SVM payment by verifying the payment and recording the settlement.
 *
 * @param signer - Transaction signer used to verify the payment
 * @param payload - The payment payload to settle
 * @param paymentRequirements - The payment requirements to settle against
 * @param config - Optional configuration for X402 operations (e.g., custom RPC URLs)
 * @returns A promise that resolves to a SettleResponse indicating success or failure
 */
export async function settle(
  signer: TransactionSigner,
  payload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  config?: X402Config,
): Promise<SettleResponse> {
  const verifyResponse = await verify(signer, payload, paymentRequirements, config);
  if (!verifyResponse.isValid) {
    return {
      success: false,
      errorReason: verifyResponse.invalidReason,
      network: payload.network,
      transaction: "",
    };
  }

  const svmPayload = payload.payload as ExactSvmPayload;

  // Duplicate settlement check: reject if this transaction is already being settled.
  // Must occur before any async work so concurrent calls for the same tx are caught.
  const txKey = svmPayload.transaction;
  if (settlementCache.isDuplicate(txKey)) {
    return {
      success: false,
      errorReason: "duplicate_settlement",
      network: payload.network,
      transaction: "",
    };
  }
  const decodedTransaction = decodeTransactionFromPayload(svmPayload);
  const signedTransaction = await signTransactionWithSigner(signer, decodedTransaction);
  assertTransactionFullySigned(signedTransaction);
  const payer = getTokenPayerFromTransaction(signedTransaction);

  const rpc = getRpcClient(paymentRequirements.network, config?.svmConfig?.rpcUrl);
  const rpcSubscriptions = getRpcSubscriptions(
    paymentRequirements.network,
    config?.svmConfig?.rpcUrl,
  );

  try {
    const { success, errorReason, signature } = await sendAndConfirmSignedTransaction(
      signedTransaction,
      rpc,
      rpcSubscriptions,
    );

    return {
      success,
      errorReason,
      payer,
      transaction: signature,
      network: payload.network,
    };
  } catch (error) {
    console.error("Unexpected error during transaction settlement:", error);
    return {
      success: false,
      errorReason: "unexpected_settle_error",
      network: payload.network,
      transaction: getSignatureFromTransaction(signedTransaction),
      payer,
    };
  }
}

/**
 * Send a signed transaction to the RPC.
 * TODO: should this be moved to the shared/svm/rpc.ts file?
 *
 * @param signedTransaction - The signed transaction to send
 * @param rpc - The RPC client to use to send the transaction
 * @param sendTxConfig - The configuration for the transaction send
 * @returns The signature of the sent transaction
 */
export async function sendSignedTransaction(
  signedTransaction: Transaction,
  rpc: RpcDevnet<SolanaRpcApiDevnet> | RpcMainnet<SolanaRpcApiMainnet>,
  sendTxConfig: Parameters<SendTransactionApi["sendTransaction"]>[1] = {
    skipPreflight: true,
    encoding: "base64",
  },
): Promise<string> {
  const base64EncodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
  return await rpc.sendTransaction(base64EncodedTransaction, sendTxConfig).send();
}

/**
 * Confirm a signed transaction.
 * TODO: can some of this be refactored to be moved to the shared/svm/rpc.ts file?
 * TODO: should the commitment and the timeout be passed in as parameters?
 *
 * @param signedTransaction - The signed transaction to confirm
 * @param rpc - The RPC client to use to confirm the transaction
 * @param rpcSubscriptions - The RPC subscriptions to use to confirm the transaction
 * @returns The success and signature of the confirmed transaction
 */
export async function confirmSignedTransaction(
  signedTransaction: Transaction,
  rpc: RpcDevnet<SolanaRpcApiDevnet> | RpcMainnet<SolanaRpcApiMainnet>,
  rpcSubscriptions: ReturnType<typeof getRpcSubscriptions>,
): Promise<{ success: boolean; errorReason?: (typeof ErrorReasons)[number]; signature: string }> {
  // get the signature from the signed transaction
  const signature = getSignatureFromTransaction(signedTransaction);

  // set a timeout for the transaction confirmation
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort("Transaction confirmation timed out after 60 seconds");
  }, 60000);

  try {
    // decompile the transaction message to get the blockhash lifetime
    const compiledTransactionMessage = getCompiledTransactionMessageDecoder().decode(
      signedTransaction.messageBytes,
    );
    const decompiledTransactionMessage = await decompileTransactionMessageFetchingLookupTables(
      compiledTransactionMessage,
      rpc,
    );
    assertIsTransactionMessageWithBlockhashLifetime(decompiledTransactionMessage);

    // add the blockhash lifetime to the signed transaction
    const signedTransactionWithBlockhashLifetime = {
      ...signedTransaction,
      lifetimeConstraint: decompiledTransactionMessage.lifetimeConstraint,
    };

    // create the config for the transaction confirmation
    const commitment: Commitment = "confirmed";

    const getRecentSignatureConfirmationPromise = createRecentSignatureConfirmationPromiseFactory({
      rpc,
      rpcSubscriptions,
    } as Parameters<typeof createRecentSignatureConfirmationPromiseFactory>[0]);

    const getBlockHeightExceedencePromise = createBlockHeightExceedencePromiseFactory({
      rpc,
      rpcSubscriptions,
    } as Parameters<typeof createBlockHeightExceedencePromiseFactory>[0]);

    const config = {
      abortSignal: abortController.signal,
      commitment,
      getBlockHeightExceedencePromise,
      getRecentSignatureConfirmationPromise,
    };

    // wait for the transaction to be confirmed
    await waitForRecentTransactionConfirmation({
      ...config,
      transaction: signedTransactionWithBlockhashLifetime as Parameters<
        typeof waitForRecentTransactionConfirmation
      >[0]["transaction"],
    });

    // return the success and signature
    return {
      success: true,
      signature,
    };
  } catch (error) {
    console.error(error);

    // block height exceeded error
    if (isSolanaError(error, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) {
      return {
        success: false,
        errorReason: "settle_exact_svm_block_height_exceeded",
        signature,
      };
    }
    // transaction confirmation timed out error
    else if (error instanceof DOMException && error.name === "AbortError") {
      return {
        success: false,
        errorReason: "settle_exact_svm_transaction_confirmation_timed_out",
        signature,
      };
    }
    // unexpected error
    else {
      throw error;
    }
  } finally {
    // clear the timeout
    clearTimeout(timeout);
  }
}

/**
 * Send and confirm a signed transaction.
 *
 * @param signedTransaction - The signed transaction to send and confirm
 * @param rpc - The RPC client to use to send and confirm the transaction
 * @param rpcSubscriptions - The RPC subscriptions to use to send and confirm the transaction
 * @returns The success and signature of the confirmed transaction
 */
export async function sendAndConfirmSignedTransaction(
  signedTransaction: Transaction,
  rpc: RpcDevnet<SolanaRpcApiDevnet> | RpcMainnet<SolanaRpcApiMainnet>,
  rpcSubscriptions: ReturnType<typeof getRpcSubscriptions>,
): Promise<{ success: boolean; errorReason?: (typeof ErrorReasons)[number]; signature: string }> {
  await sendSignedTransaction(signedTransaction, rpc);
  return await confirmSignedTransaction(signedTransaction, rpc, rpcSubscriptions);
}

/**
 * Ensures the provided transaction contains a signature for every required address.
 *
 * @param transaction - Transaction to verify for complete signatures
 */
function assertTransactionFullySigned(transaction: Transaction): void {
  const missingAddresses = Object.entries(transaction.signatures)
    .filter(([, signature]) => signature == null)
    .map(([address]) => address);

  if (missingAddresses.length > 0) {
    throw new Error(`transaction_signer_missing_signatures:${missingAddresses.join(",")}`);
  }
}
