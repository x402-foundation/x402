import {
  Address,
  Client,
  Transaction,
  TransactionBody,
  TransactionHash,
} from "@evolution-sdk/evolution";

import { buildPaymentOutputAssets, resolveCardanoChain } from "../chain";
import {
  ASSET_TRANSFER_METHOD_DEFAULT,
  LOVELACE_ASSET,
  normalizeCardanoNetwork,
} from "../constants";
import type {
  ClientCardanoSigner,
  ClientCardanoSignInput,
  ClientCardanoSignResult,
} from "../signer";
import { Cip30SignerError } from "./errors";
import {
  assertBuiltPaymentAllowed,
  assertCip30ProtocolParametersInBounds,
  assertVkeyOnlyWitnessSet,
  type Cip30ProtocolParameters,
} from "./guards";
import { buildCip30Pool, chooseCip30Nonce, inputRef } from "./utxo";

/** Longest validity window (seconds) a CIP-30 payment will sign for. */
export const CIP30_MAX_WINDOW_SECONDS = 900;
/** Shortest usable window (seconds); shorter routes cannot be paid from a browser wallet. */
export const CIP30_MIN_WINDOW_SECONDS = 240;
/** Subtracted from the TTL to absorb facilitator clock skew and slot rounding. */
export const CIP30_TTL_MARGIN_MS = 90_000;
/** Time that must remain before the TTL once the wallet has signed. */
export const CIP30_POST_SIGN_MIN_REMAINING_MS = 90_000;

/**
 * The subset of the CIP-30 API (`enable()` result) that Evolution's wallet
 * adapter requires. The signer reads addresses and UTXOs and calls `signTx`;
 * it never calls `submitTx` or `signData`.
 */
export interface Cip30WalletApi {
  getUsedAddresses(): Promise<ReadonlyArray<string>>;
  getUnusedAddresses(): Promise<ReadonlyArray<string>>;
  getRewardAddresses(): Promise<ReadonlyArray<string>>;
  getUtxos(): Promise<ReadonlyArray<string> | null | undefined>;
  signTx(txCborHex: string, partialSign: boolean): Promise<string>;
  signData(addressHex: string, payload: string): Promise<{ signature: string; key: string }>;
  submitTx(txCborHex: string): Promise<string>;
}

/** Wall-clock source, in unix milliseconds. Browsers should pass a server-anchored clock. */
export interface Cip30PaymentClock {
  now(): number;
}

/** Details of a signed payment, reported before it leaves the signer. */
export interface Cip30SignedPayment {
  /** Lowercase hex transaction id. */
  readonly txId: string;
  /** `txHash#index` of the nonce UTXO the transaction spends. */
  readonly nonce: string;
  /** Requested validity upper bound in unix milliseconds, before slot rounding. */
  readonly ttlMs: number;
}

/** Configuration for {@link createCip30ClientCardanoSigner}. */
export interface Cip30ClientCardanoSignerConfig {
  /** x402 network identifier (e.g. `cardano:preprod`). */
  network: string;
  /** Protocol parameters; bounded by `CIP30_PROTOCOL_PARAMETER_BOUNDS` (see `guards.ts`) before use. */
  protocolParameters: Cip30ProtocolParameters;
  /** Clock used for the TTL and the post-sign check. Defaults to `Date.now`. */
  clock?: Cip30PaymentClock;
  /** Returns the nonce an earlier attempt of the same payment pinned, if any. */
  pinnedNonce?: () => string | undefined;
  /** Called after the wallet signed and every check passed, before returning. */
  onSigned?: (payment: Cip30SignedPayment) => void | Promise<void>;
}

/** The wallet API type Evolution's `withCip30` expects. */
type EvolutionWalletApi = Parameters<ReturnType<typeof Client.make>["withCip30"]>[0];

/** CIP-30 error codes meaning the user refused: `TxSignError.UserDeclined`, `APIError.Refused`. */
const CIP30_DECLINE_CODES: ReadonlySet<number> = new Set([2, -3]);

/**
 * Turns a CIP-30 `signTx` rejection (`{ code, info }`, not an `Error`) into a
 * signer error, so callers can tell a decline from a wallet failure.
 *
 * @param error - Whatever the wallet rejected with.
 * @returns The signer error.
 */
function walletSignError(error: unknown): Cip30SignerError {
  const { code, info } = (error ?? {}) as { code?: unknown; info?: unknown };
  const detail =
    typeof info === "string" ? info : error instanceof Error ? error.message : String(error);
  if (typeof code === "number" && CIP30_DECLINE_CODES.has(code)) {
    return new Cip30SignerError("wallet_declined", detail, {
      cause: error,
    });
  }
  return new Cip30SignerError("wallet_sign_failed", detail, {
    cause: error,
  });
}

/**
 * Encodes bytes as base64 using the platform `btoa`; this signer runs in
 * browsers, where Node's `Buffer` is not available.
 *
 * @param bytes - Bytes to encode.
 * @returns Base64 string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Creates a client signer backed by a CIP-30 browser wallet, for the default
 * (plain transfer) method only.
 *
 * The signer never contacts a chain provider: it builds from the wallet's own
 * UTXOs and the supplied protocol parameters, and the wallet only signs (the
 * facilitator broadcasts). Because the parameters may come from the payee, it
 * bounds them, and before asking the wallet to sign it refuses any transaction
 * that is not exactly the requested payment plus change back to the wallet.
 * The returned signer handles one payment at a time; do not call it concurrently.
 *
 * @param api - The CIP-30 API returned by `window.cardano.<wallet>.enable()`.
 * @param config - Network, protocol parameters, clock and nonce pinning.
 * @returns A client signer for `ExactCardanoScheme`.
 */
export async function createCip30ClientCardanoSigner(
  api: Cip30WalletApi,
  config: Cip30ClientCardanoSignerConfig,
): Promise<ClientCardanoSigner> {
  assertCip30ProtocolParametersInBounds(config.protocolParameters);
  const chain = resolveCardanoChain(config.network);
  const clock = config.clock ?? { now: () => Date.now() };
  // Keep the raw CIP-30 rejection: Evolution wraps it into an error whose
  // message reads "[object Object]" and drops the numeric code.
  let signRejection: { error: unknown } | undefined;
  const takeSignRejection = (): { error: unknown } | undefined => {
    const rejection = signRejection;
    signRejection = undefined;
    return rejection;
  };
  const wallet: Cip30WalletApi = {
    getUsedAddresses: () => api.getUsedAddresses(),
    getUnusedAddresses: () => api.getUnusedAddresses(),
    getRewardAddresses: () => api.getRewardAddresses(),
    getUtxos: () => api.getUtxos(),
    signData: (addressHex, payload) => api.signData(addressHex, payload),
    submitTx: cbor => api.submitTx(cbor),
    signTx: async (cbor, partialSign) => {
      try {
        return await api.signTx(cbor, partialSign);
      } catch (error) {
        signRejection = { error };
        throw error;
      }
    },
  };
  // The provider is required by the builder's type but is never called: the
  // build supplies `fullProtocolParameters` and `availableUtxos`, and a CIP-30
  // wallet signs without reference-input lookups. The cast bridges shape
  // differences only (`getUtxos` may return null here; `signData` payload types).
  const client = Client.make(chain)
    .withKoios({ baseUrl: "https://cip30-provider-unused.invalid" })
    .withCip30(wallet as unknown as EvolutionWalletApi);
  let changeAddress: Awaited<ReturnType<typeof client.address>>;
  try {
    changeAddress = await client.address();
  } catch (error) {
    // Evolution rejects a wallet whose first address is on another network
    // ("Wallet network mismatch: …"); every other failure passes through.
    const message = error instanceof Error ? error.message : String(error);
    if (!/network mismatch/i.test(message)) throw error;
    throw new Cip30SignerError(
      "wallet_network_mismatch",
      `The wallet is not on ${config.network}`,
      { cause: error },
    );
  }
  const changeBech32 = Address.toBech32(changeAddress);

  return {
    getAddress(): string {
      return changeBech32;
    },

    async buildAndSignPaymentTransaction(
      input: ClientCardanoSignInput,
    ): Promise<ClientCardanoSignResult> {
      if (normalizeCardanoNetwork(input.network) !== normalizeCardanoNetwork(config.network)) {
        throw new Cip30SignerError(
          "network_mismatch",
          `Signer configured for ${config.network} but asked to pay on ${input.network}`,
        );
      }
      const method = input.extra?.assetTransferMethod;
      if (method !== undefined && method !== ASSET_TRANSFER_METHOD_DEFAULT) {
        throw new Cip30SignerError(
          "transfer_method_unsupported",
          `Browser wallets can only pay plain transfers, not "${String(method)}"`,
        );
      }
      const windowSeconds = Math.min(input.maxTimeoutSeconds, CIP30_MAX_WINDOW_SECONDS);
      if (!Number.isFinite(windowSeconds) || windowSeconds < CIP30_MIN_WINDOW_SECONDS) {
        throw new Cip30SignerError(
          "payment_window_too_short",
          `This route's payment window (${input.maxTimeoutSeconds}s) is too short for a browser wallet; it needs at least ${CIP30_MIN_WINDOW_SECONDS}s`,
        );
      }
      const amount = /^[1-9][0-9]*$/.test(input.amount) ? BigInt(input.amount) : 0n;
      if (amount <= 0n) {
        throw new Cip30SignerError(
          "amount_invalid",
          "Payment amount must be a positive integer in the asset's smallest unit",
        );
      }

      const pool = buildCip30Pool((await api.getUtxos()) ?? [], chain.id);
      const nonceUtxo = chooseCip30Nonce(pool, config.pinnedNonce?.());
      const nonce = inputRef(nonceUtxo);
      const isLovelace = input.asset.toLowerCase() === LOVELACE_ASSET;

      const ttlMs = Math.floor(clock.now()) + windowSeconds * 1000 - CIP30_TTL_MARGIN_MS;
      const signBuilder = await client
        .newTx()
        .collectFrom({ inputs: [nonceUtxo] })
        .payToAddress({
          address: Address.fromBech32(input.payTo),
          assets: buildPaymentOutputAssets(input.asset, amount),
        })
        .setValidity({ to: BigInt(ttlMs) })
        .build({
          changeAddress,
          availableUtxos: pool,
          fullProtocolParameters: config.protocolParameters,
          // ADA payments must carry exactly the amount; a token output gets the
          // protocol min-UTxO, capped by assertBuiltPaymentAllowed.
          autoMinUtxo: !isLovelace,
        });

      const unsigned = await signBuilder.toTransaction();
      const withFakeWitnesses = await signBuilder.toTransactionWithFakeWitnesses();
      assertBuiltPaymentAllowed(unsigned, {
        networkId: chain.id,
        poolRefs: new Set(pool.map(inputRef)),
        nonceRef: nonce,
        payTo: input.payTo,
        changeAddress: changeBech32,
        asset: input.asset,
        amount,
        params: config.protocolParameters,
        signedSizeBytes: Transaction.toCBORBytes(withFakeWitnesses).length,
      });

      takeSignRejection();
      let submitBuilder: Awaited<ReturnType<typeof signBuilder.sign>>;
      try {
        submitBuilder = await signBuilder.sign();
      } catch (error) {
        const rejection = takeSignRejection();
        throw rejection ? walletSignError(rejection.error) : error;
      }
      assertVkeyOnlyWitnessSet(submitBuilder.witnessSet);
      if (ttlMs - clock.now() < CIP30_POST_SIGN_MIN_REMAINING_MS) {
        throw new Cip30SignerError(
          "payment_window_expired",
          "Signing took too long for this payment window; please sign again",
        );
      }

      const signed = new Transaction.Transaction({
        body: unsigned.body,
        witnessSet: submitBuilder.witnessSet,
        isValid: true,
        auxiliaryData: null,
      });
      const txBytes = Transaction.toCBORBytes(signed);
      const txId = TransactionHash.toHex(
        TransactionBody.toHashFromBytes(Transaction.extractBodyBytes(txBytes)),
      );
      await config.onSigned?.({ txId, nonce, ttlMs });

      // Never broadcast: the facilitator verifies and submits during settle().
      return { transaction: bytesToBase64(txBytes), nonce };
    },
  };
}
