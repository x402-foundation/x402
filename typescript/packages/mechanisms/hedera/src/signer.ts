import type { PaymentRequirements } from "@x402/core/types";
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { HEDERA_MAINNET_CAIP2, HEDERA_TESTNET_CAIP2 } from "./constants";
import { assertSupportedHederaNetwork, isHbarAsset } from "./utils";

/**
 * Client-side signer interface for Hedera transactions.
 */
export type ClientHederaSigner = {
  /**
   * Hedera account id of the payer creating the transfer.
   */
  readonly accountId: string;

  /**
   * Builds and signs a partially-signed TransferTransaction,
   * returning it as base64 serialized bytes.
   *
   * @param requirements - Chosen payment requirements
   * @returns Base64 transaction
   */
  createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string>;
};

/**
 * Optional account resolution result for alias policy checks.
 */
export type HederaAccountResolution = {
  exists: boolean;
  isAlias: boolean;
};

/**
 * Minimal facilitator signer interface for Hedera verification + settlement.
 */
export type FacilitatorHederaSigner = {
  /**
   * Get all fee payer account ids managed by facilitator.
   */
  getAddresses(): readonly string[];

  /**
   * Add fee payer signature and submit the transaction to Hedera.
   *
   * Must resolve only when the transaction has reached consensus with a
   * SUCCESS receipt; any non-SUCCESS status (e.g. `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`,
   * `INSUFFICIENT_ACCOUNT_BALANCE`, `INVALID_SIGNATURE`) must throw. The scheme
   * translates thrown errors into `SettleResponse { success: false,
   * errorReason: "transaction_failed" }`; a resolved promise is treated as
   * an on-chain success. Use `createHederaSignAndSubmitTransaction` for a
   * correct default implementation.
   *
   * @param transactionBase64 - Base64 transaction payload
   * @param feePayer - Fee payer account
   * @param network - CAIP-2 network
   * @returns Settlement metadata with the Hedera transaction id
   */
  signAndSubmitTransaction(
    transactionBase64: string,
    feePayer: string,
    network: string,
  ): Promise<{ transactionId: string }>;

  /**
   * Optional account resolution hook (used for alias policy).
   *
   * @param accountIdOrAlias - payTo field value
   * @param network - CAIP-2 network
   * @returns Resolution status
   */
  resolveAccount?(accountIdOrAlias: string, network: string): Promise<HederaAccountResolution>;

  /**
   * Optional pre-settlement check that the transfer is expected to succeed
   * on chain. Implements the SHOULD in
   * `specs/schemes/exact/scheme_exact_hedera.md` §6 — verify payer balance
   * and recipient token association / auto-association capacity.
   *
   * The hook is advisory: if it throws or is unreachable, the scheme treats
   * the check as failed and reports `invalid_exact_hedera_payload_preflight_failed`,
   * but verify itself never throws. There is an inherent verify→settle race
   * (balance may change between calls) — this is best-effort.
   *
   * @param params - Preflight parameters
   * @param params.payer - Payer account id (inferred from decoded transfers)
   * @param params.payTo - Destination account id from the payment requirements
   * @param params.asset - "0.0.0" for HBAR or HTS token id
   * @param params.amount - Transfer amount in tinybars or token smallest units
   * @param params.network - CAIP-2 network identifier
   * @returns `{ ok: true }` when the transfer is expected to succeed,
   *          otherwise `{ ok: false, reason?, message? }`
   */
  preflightTransfer?(params: {
    payer: string;
    payTo: string;
    asset: string;
    amount: string;
    network: string;
  }): Promise<{ ok: boolean; reason?: string; message?: string }>;
};

/**
 * Wraps a facilitator signer base object into a FacilitatorHederaSigner.
 *
 * @param base - Signer without getAddresses (uses getAddresses from base directly)
 * @returns FacilitatorHederaSigner
 */
export function toFacilitatorHederaSigner(base: FacilitatorHederaSigner): FacilitatorHederaSigner {
  return base;
}

/**
 * Optional configuration for the default client signer helper.
 */
export type HederaClientSignerConfig = {
  /**
   * Optional explicit network.
   * If omitted, defaults to testnet.
   */
  network?: string;
  /**
   * Optional custom node endpoint.
   * Useful for private Hedera environments.
   */
  nodeUrl?: string;
};

/**
 * Creates a default SDK-backed client signer from account credentials.
 *
 * @param accountId - Hedera account id of the payer
 * @param privateKey - Hedera SDK private key for signing
 * @param config - Optional client configuration
 * @returns Client signer implementation
 */
export function createClientHederaSigner(
  accountId: string,
  privateKey: PrivateKey,
  config: HederaClientSignerConfig = {},
): ClientHederaSigner {
  const configuredNetwork = config.network ?? HEDERA_TESTNET_CAIP2;
  assertSupportedHederaNetwork(configuredNetwork);
  const parsedAccountId = AccountId.fromString(accountId);
  const parsedPrivateKey = privateKey;

  return {
    accountId: parsedAccountId.toString(),
    createPartiallySignedTransferTransaction: async (
      requirements: PaymentRequirements,
    ): Promise<string> => {
      assertSupportedHederaNetwork(requirements.network);
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== "string") {
        throw new Error("feePayer is required in paymentRequirements.extra");
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) {
        throw new Error("amount must be greater than zero");
      }

      const payTo = AccountId.fromString(requirements.payTo);
      const tx = new TransferTransaction();
      if (isHbarAsset(requirements.asset)) {
        tx.addHbarTransfer(parsedAccountId, Hbar.fromTinybars((-amount).toString()));
        tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const tokenId = TokenId.fromString(requirements.asset);
        tx.addTokenTransfer(tokenId, parsedAccountId, -amount);
        tx.addTokenTransfer(tokenId, payTo, amount);
      }

      tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));

      const client = createHederaClient(configuredNetwork, config.nodeUrl);
      try {
        tx.freezeWith(client);
        const signed = await tx.sign(parsedPrivateKey);
        return Buffer.from(signed.toBytes()).toString("base64");
      } finally {
        client.close();
      }
    },
  };
}

/**
 * Builds a `signAndSubmitTransaction` implementation backed by the Hiero SDK
 * that waits for consensus before reporting success.
 *
 * The SDK's `TransferTransaction.execute(client)` only performs a pre-check
 * and returns once the transaction has been forwarded to a node. Consensus
 * failures (`TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`, `INSUFFICIENT_ACCOUNT_BALANCE`,
 * `INVALID_SIGNATURE`, …) are only observable via `response.getReceipt(client)`,
 * which throws a `ReceiptStatusError` when the status is not `SUCCESS`. The
 * scheme's `settle()` converts that throw into
 * `SettleResponse { success: false, errorReason: "transaction_failed" }`.
 *
 * @param buildClient - Factory that produces an SDK client for a given CAIP-2 network
 * @param feePayerKey - Facilitator fee-payer private key used to add the fee-payer signature
 * @returns An implementation suitable for `FacilitatorHederaSigner.signAndSubmitTransaction`
 */
export function createHederaSignAndSubmitTransaction(
  buildClient: (network: string) => Client,
  feePayerKey: PrivateKey,
): FacilitatorHederaSigner["signAndSubmitTransaction"] {
  return async (transactionBase64, _feePayer, network) => {
    const tx = Transaction.fromBytes(Buffer.from(transactionBase64, "base64"));
    if (!(tx instanceof TransferTransaction)) {
      throw new Error("expected TransferTransaction");
    }
    const signed = await tx.sign(feePayerKey);
    const client = buildClient(network);
    try {
      const response = await signed.execute(client);
      await response.getReceipt(client);
      return { transactionId: response.transactionId.toString() };
    } finally {
      client.close();
    }
  };
}

/**
 * Creates a Hedera SDK client for a CAIP-2 network.
 *
 * @param network - Hedera network identifier
 * @param nodeUrl - Optional custom node URL
 * @returns Hedera SDK client
 */
export function createHederaClient(network: string, nodeUrl?: string): Client {
  if (nodeUrl) {
    // A custom endpoint is mapped to account 0.0.3 by default.
    // This can be overridden by constructing your own ClientHederaSigner.
    return Client.forNetwork({ [nodeUrl]: AccountId.fromString("0.0.3") });
  }
  if (network === HEDERA_MAINNET_CAIP2) {
    return Client.forMainnet();
  }
  if (network === HEDERA_TESTNET_CAIP2) {
    return Client.forTestnet();
  }
  throw new Error(`Unsupported Hedera network: ${network}`);
}
