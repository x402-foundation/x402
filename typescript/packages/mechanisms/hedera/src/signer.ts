import type { PaymentRequirements } from "@x402/core/types";
// `@hiero-ledger/proto` must stay pinned in lockstep with `@hiero-ledger/sdk`
// `parseMirrorKey` below relies on the SDK's internal `Key._fromProtobufKey`,
// so re-check its availability whenever either dependency is bumped.
import { proto } from "@hiero-ledger/proto";
import {
  AccountId,
  Client,
  Hbar,
  Key,
  KeyList,
  PrivateKey,
  PublicKey,
  TokenId,
  Transaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { HEDERA_MAINNET_CAIP2, HEDERA_TESTNET_CAIP2 } from "./constants";
import { fetchJson, mirrorNodeUrlForNetwork } from "./preflight";
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
   * Verify that the inferred payer actually signed the frozen transaction body.
   *
   * Required verify-time capability, called unconditionally by the scheme (it
   * cannot be silently skipped), mirroring EVM's `verifyTypedData`. The default
   * `createHederaVerifyPayerSignature` fetches the payer's onchain account key
   * and verifies the signature against it; on `{ ok: false }` or a thrown error
   * the scheme fails closed with `invalid_exact_hedera_payload_signature_invalid`.
   *
   * @param params - Signature verification parameters
   * @param params.payer - Payer account id (inferred from decoded transfers)
   * @param params.transaction - Base64-encoded transaction the payer should have signed
   * @param params.network - CAIP-2 network identifier
   * @returns `{ ok: true }` when the payer signed, otherwise
   *          `{ ok: false, reason?, message? }`
   */
  verifyPayerSignature(params: {
    payer: string;
    transaction: string;
    network: string;
  }): Promise<{ ok: boolean; reason?: string; message?: string }>;

  /**
   * Optional account resolution hook (used for alias policy).
   *
   * @param accountIdOrAlias - payTo field value
   * @param network - CAIP-2 network
   * @returns Resolution status
   */
  resolveAccount?(accountIdOrAlias: string, network: string): Promise<HederaAccountResolution>;

  /**
   * Pre-settlement check that the transfer is expected to succeed on chain.
   * Implements the SHOULD in `specs/schemes/exact/scheme_exact_hedera.md` §6 —
   * verify payer balance and recipient token association / auto-association
   * capacity.
   *
   * Required verify-time capability, called unconditionally by the scheme.
   * The scheme fails closed with `invalid_exact_hedera_payload_preflight_failed` on `{ ok: false }` or a thrown error.
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
  preflightTransfer(params: {
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
 * Returns true when `key` (a single key, or a KeyList whose threshold is met)
 * has produced a valid signature over `tx`. Recurses into nested KeyLists so
 * threshold and multi-key accounts are handled.
 *
 * @param key - Account key fetched from the network
 * @param tx - Frozen, signed transaction to verify against
 * @returns Whether the key's signing requirement is satisfied by `tx`
 */
function keySignsTransaction(key: Key, tx: Transaction): boolean {
  if (key instanceof PublicKey) {
    return key.verifyTransaction(tx);
  }
  if (key instanceof KeyList) {
    const keys = key.toArray();
    // A non-positive or absent threshold means every key in the list must sign.
    const threshold = key.threshold && key.threshold > 0 ? key.threshold : keys.length;
    return keys.filter(k => keySignsTransaction(k, tx)).length >= threshold;
  }
  return false;
}

/**
 * Optional configuration for the default Mirror Node verify implementation.
 */
export type HederaVerifyConfig = {
  /**
   * Mirror Node REST API base URL (no trailing slash). Defaults to the public
   * Mirror Node for the request's CAIP-2 network.
   */
  mirrorNodeUrl?: string;
};

/**
 * Account key as returned by the Mirror Node `/accounts/{id}` endpoint.
 */
type MirrorAccountKey = {
  key: { _type: "ED25519" | "ECDSA_SECP256K1" | "ProtobufEncoded"; key: string } | null;
};

/**
 * Thrown when the Hedera SDK no longer exposes the internal
 * `Key._fromProtobufKey` that {@link parseMirrorKey} relies on to rebuild
 * KeyList/threshold keys, e.g. after an SDK upgrade renames or removes it.
 */
class ProtobufKeyReconstructionError extends Error {}

/**
 * Converts a Mirror Node `key` field into a Hedera SDK `Key`.
 *
 * Simple keys are parsed directly; threshold / KeyList accounts arrive as a
 * hex-encoded protobuf (`ProtobufEncoded`) and are rebuilt via the SDK's
 * internal `Key._fromProtobufKey`, the only entry point that reconstructs a
 * `Key` from its protobuf form.
 *
 * @param mirrorKey - The `key` object from the Mirror Node account response
 * @returns Parsed SDK `Key`, or `null` when the key is missing or unrecognized
 * @throws {ProtobufKeyReconstructionError} If the SDK no longer exposes
 * `Key._fromProtobufKey`
 */
function parseMirrorKey(mirrorKey: MirrorAccountKey["key"]): Key | null {
  if (!mirrorKey || typeof mirrorKey.key !== "string" || mirrorKey.key.length === 0) {
    return null;
  }
  switch (mirrorKey._type) {
    case "ED25519":
      return PublicKey.fromStringED25519(mirrorKey.key);
    case "ECDSA_SECP256K1":
      return PublicKey.fromStringECDSA(mirrorKey.key);
    case "ProtobufEncoded": {
      const decoded = proto.Key.decode(Buffer.from(mirrorKey.key, "hex"));
      // `_fromProtobufKey` is an internal static on the SDK `Key` base class; it
      // is the only way to rebuild a KeyList/threshold `Key` from its protobuf.
      // Guarded explicitly so a future SDK rename/removal surfaces a
      // diagnosable error instead of silently failing signature checks.
      const fromProtobufKey = (Key as unknown as { _fromProtobufKey?: (key: proto.IKey) => Key })
        ._fromProtobufKey;
      if (typeof fromProtobufKey !== "function") {
        throw new ProtobufKeyReconstructionError(
          "@hiero-ledger/sdk Key._fromProtobufKey is unavailable; check the " +
            "@hiero-ledger/sdk / @hiero-ledger/proto version pins in package.json",
        );
      }
      return fromProtobufKey(decoded);
    }
    default:
      return null;
  }
}

/**
 * Builds a `verifyPayerSignature` implementation backed by the Hedera Mirror
 * Node REST API.
 *
 * Reads the payer's onchain account key from the free Mirror Node (the same
 * source as `createHederaPreflightTransfer`) and verifies that the frozen
 * transaction body carries a valid signature satisfying that key — including
 * KeyList/threshold accounts. Binds the signature to the payer account, so a
 * transaction signed with the wrong key (or left unsigned) is rejected.
 *
 * @param config - Optional Mirror Node configuration
 * @returns A function suitable for `FacilitatorHederaSigner.verifyPayerSignature`
 */
export function createHederaVerifyPayerSignature(
  config: HederaVerifyConfig = {},
): FacilitatorHederaSigner["verifyPayerSignature"] {
  return async ({ payer, transaction, network }) => {
    const tx = Transaction.fromBytes(Buffer.from(transaction, "base64"));
    const baseUrl = config.mirrorNodeUrl ?? mirrorNodeUrlForNetwork(network);
    const account = await fetchJson<MirrorAccountKey>(
      `${baseUrl}/api/v1/accounts/${encodeURIComponent(payer)}`,
    );
    let key: Key | null;
    try {
      key = parseMirrorKey(account.key);
    } catch (error) {
      if (error instanceof ProtobufKeyReconstructionError) {
        return {
          ok: false,
          reason: "signature_unverifiable",
          message: error.message,
        };
      }
      throw error;
    }
    if (!key) {
      return {
        ok: false,
        reason: "signature_invalid",
        message: "could not resolve payer key",
      };
    }
    if (keySignsTransaction(key, tx)) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: "signature_invalid",
      message: `payer ${payer} did not sign the transaction`,
    };
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
