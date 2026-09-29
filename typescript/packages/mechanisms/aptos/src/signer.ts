import {
  Account,
  Ed25519PrivateKey,
  Aptos,
  AptosConfig,
  SimpleTransaction,
  AccountAuthenticator,
  PrivateKey,
  PrivateKeyVariants,
  type PendingTransactionResponse,
} from "@aptos-labs/ts-sdk";
import { getAptosNetwork, getAptosRpcUrl } from "./constants";

/**
 * Client-side signer for creating and signing Aptos transactions
 */
export type ClientAptosSigner = Account;

/**
 * Configuration for client operations
 */
export type ClientAptosConfig = {
  /**
   * Optional custom RPC URL for the client to use
   */
  rpcUrl?: string;
};

/**
 * Minimal facilitator signer interface for Aptos operations
 */
export type FacilitatorAptosSigner = {
  /**
   * Get all addresses this facilitator can use for signing
   */
  getAddresses(): readonly string[];

  /**
   * Sign a transaction as the fee payer and submit it
   */
  signAndSubmitAsFeePayer(
    transaction: SimpleTransaction,
    senderAuthenticator: AccountAuthenticator,
    network: string,
  ): Promise<PendingTransactionResponse>;

  /**
   * Submit a fully-signed transaction (non-sponsored)
   */
  submitTransaction(
    transaction: SimpleTransaction,
    senderAuthenticator: AccountAuthenticator,
    network: string,
  ): Promise<PendingTransactionResponse>;

  /**
   * Simulate a transaction to verify it would succeed
   */
  simulateTransaction(transaction: SimpleTransaction, network: string): Promise<void>;

  /**
   * Wait for transaction confirmation
   */
  waitForTransaction(txHash: string, network: string): Promise<void>;
};

/**
 * Creates a client signer from a private key
 *
 * @param privateKey - The private key as a hex string or AIP-80 format
 * @returns An Aptos Account instance
 */
export async function createClientSigner(privateKey: string): Promise<ClientAptosSigner> {
  const formattedKey = PrivateKey.formatPrivateKey(privateKey, PrivateKeyVariants.Ed25519);
  const privateKeyBytes = new Ed25519PrivateKey(formattedKey);
  return Account.fromPrivateKey({ privateKey: privateKeyBytes });
}

/**
 * Create a facilitator signer from an Aptos Account
 *
 * @param account - The Aptos Account that will act as fee payer
 * @param rpcConfig - Optional RPC configuration
 * @returns FacilitatorAptosSigner instance
 */
export function toFacilitatorAptosSigner(
  account: Account,
  rpcConfig?: { defaultRpcUrl?: string } | Record<string, string>,
): FacilitatorAptosSigner {
  const getRpcUrl = (network: string): string => {
    if (rpcConfig) {
      if ("defaultRpcUrl" in rpcConfig && rpcConfig.defaultRpcUrl) {
        return rpcConfig.defaultRpcUrl;
      }
      if (network in rpcConfig) {
        return (rpcConfig as Record<string, string>)[network];
      }
    }
    return getAptosRpcUrl(getAptosNetwork(network));
  };

  const getAptos = (network: string): Aptos => {
    const aptosNetwork = getAptosNetwork(network);
    const rpcUrl = getRpcUrl(network);
    return new Aptos(new AptosConfig({ network: aptosNetwork, fullnode: rpcUrl }));
  };

  return {
    getAddresses: () => [account.accountAddress.toStringLong()],

    signAndSubmitAsFeePayer: async (
      transaction: SimpleTransaction,
      senderAuthenticator: AccountAuthenticator,
      network: string,
    ) => {
      const aptos = getAptos(network);
      transaction.feePayerAddress = account.accountAddress;
      const feePayerAuthenticator = aptos.transaction.signAsFeePayer({
        signer: account,
        transaction,
      });
      return aptos.transaction.submit.simple({
        transaction,
        senderAuthenticator,
        feePayerAuthenticator,
      });
    },

    submitTransaction: async (
      transaction: SimpleTransaction,
      senderAuthenticator: AccountAuthenticator,
      network: string,
    ) => {
      const aptos = getAptos(network);
      return aptos.transaction.submit.simple({ transaction, senderAuthenticator });
    },

    simulateTransaction: async (transaction: SimpleTransaction, network: string) => {
      const aptos = getAptos(network);
      const results = await aptos.transaction.simulate.simple({ transaction });
      if (results.length === 0 || !results[0].success) {
        throw new Error(`Simulation failed: ${results[0]?.vm_status || "unknown error"}`);
      }
    },

    waitForTransaction: async (txHash: string, network: string) => {
      const aptos = getAptos(network);
      await aptos.waitForTransaction({ transactionHash: txHash });
    },
  };
}
