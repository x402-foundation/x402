import type { Network } from "@x402/core/types";
import type { Deploy, Transaction } from "casper-js-sdk";
import type { NetworkConfig } from "./constants";

/**
 * Authorization fields for an exact Casper payment.
 */
export type ExactCasperAuthorization = {
  /** Payer account-hash address with "00" prefix. */
  from: string;
  /** Recipient account-hash or package-hash address with "00" or "01" prefix. */
  to: string;
  /** Atomic token amount as a decimal string. */
  value: string;
  /** Unix timestamp after which the authorization is valid. */
  validAfter: string;
  /** Unix timestamp before which the authorization must be used. */
  validBefore: string;
  /** 32-byte nonce as a hex string. */
  nonce: string;
};

/**
 * Payload for an exact Casper payment.
 */
export type ExactCasperPayload = {
  /** Signature with leading Casper algorithm byte. */
  signature: string;
  /** Payer public key with leading Casper algorithm byte. */
  publicKey: string;
  /** Signed authorization fields. */
  authorization: ExactCasperAuthorization;
};

/**
 * CEP-3009 authorization state.
 */
export type CasperAuthorizationState = "unused" | "used" | "canceled";

/**
 * Parameters for balance reads.
 */
export type CasperBalanceParams = {
  network: Network;
  asset: string;
  account: string;
};

/**
 * Parameters for CEP-3009 authorization state reads.
 */
export type CasperPreflightParams = {
  network: Network;
  asset: string;
  payer: string;
  nonce: string;
};

export type RpcUrlConfig = Record<string, string>;

export type SpeculativeRpcUrlConfig = Record<string, string>;

export type PreflightHooks = {
  getBalance?: (params: CasperBalanceParams) => Promise<bigint>;
  getAuthorizationState?: (params: CasperPreflightParams) => Promise<CasperAuthorizationState>;
  assertTransferWithAuthorizationSupported?: (params: {
    network: Network;
    asset: string;
  }) => Promise<void>;
};

export type FacilitatorCasperSignerOptions = {
  rpcUrlConfig?: RpcUrlConfig;
  preflightHooks?: PreflightHooks;
  speculativeRpcUrlConfig?: SpeculativeRpcUrlConfig;
};

export type ToFacilitatorCasperSignerOptions = FacilitatorCasperSignerOptions;

export type CasperSpeculativeTransferParams = {
  network: Network;
  asset: string;
  deploy: Deploy;
};

/**
 * Client-side signer for Casper x402 payments.
 */
export type ClientCasperSigner = {
  /** Get the payer account-hash address as a 66-character hex string prefixed with "00". */
  accountAddress(): string;
  /** Get the payer's public key hex, including the algorithm prefix byte. */
  publicKey(): string;
  /** Sign a 32-byte EIP-712 digest. */
  signEIP712(digest: Uint8Array): Promise<Uint8Array>;
};

/**
 * Facilitator-side signer for Casper x402 settlement and preflight checks.
 */
export type FacilitatorCasperSigner = {
  /** Resolve network configuration. */
  getNetworkConfig(network: Network): Promise<NetworkConfig>;
  /** Get signer addresses for the supported endpoint. */
  getAddresses(network: Network): string[];
  /** Get the facilitator public key for settlement transactions. */
  getPublicKeyHex(network: Network): string;
  /** Read payer balance for the required asset. */
  getBalance?(params: CasperBalanceParams): Promise<bigint>;
  /** Read CEP-3009 authorization state for the payer and nonce. */
  getAuthorizationState?(params: CasperPreflightParams): Promise<CasperAuthorizationState>;
  /** Fail when the asset cannot support CEP-3009 transfer_with_authorization. */
  assertTransferWithAuthorizationSupported?(params: {
    network: Network;
    asset: string;
  }): Promise<void>;
  /** Simulate a transfer before submission. */
  simulateTransferWithAuthorization?(params: CasperSpeculativeTransferParams): Promise<void>;
  /** Sign a Casper transaction. */
  signTransaction(transaction: Transaction, network: Network): Promise<void>;
  /** Submit a Casper transaction and return its hash. */
  putTransaction(network: Network, transaction: Transaction): Promise<string>;
  /** Wait for a submitted transaction to execute successfully. */
  waitForTransaction(network: Network, transactionHash: string): Promise<void>;
};
