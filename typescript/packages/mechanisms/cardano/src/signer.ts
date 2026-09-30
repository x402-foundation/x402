import {
  Address,
  Assets,
  type Chain,
  Client,
  Credential,
  mainnet,
  preprod,
  preview,
  Transaction,
  TransactionHash,
  TransactionInput,
} from "@evolution-sdk/evolution";
import { addressFromSeed } from "@evolution-sdk/evolution/sdk/wallet/Derivation";
import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";

import {
  ASSET_TRANSFER_METHOD_MASUMI,
  ASSET_TRANSFER_METHOD_SCRIPT,
  CARDANO_MAINNET_CAIP2,
  CARDANO_PREPROD_CAIP2,
  CARDANO_PREVIEW_CAIP2,
  LOVELACE_ASSET,
  normalizeCardanoNetwork,
} from "./constants";
import {
  MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE,
  MASUMI_MAX_DEADLINE_HORIZON_MS,
} from "./exact/masumi/constants";
import { buildMasumiLock, type MasumiBuyerInput } from "./exact/masumi/lock";
import { parseMasumiLockDatum } from "./exact/masumi/datum";
import {
  verifyMasumiDatumInvariants,
  verifyMasumiAuthorization,
  type MasumiDeploymentValidator,
  type MasumiRegistryValidator,
} from "./exact/masumi/verify";
import { isKeyCredentialAddressOn, validateMasumiExtra } from "./exact/masumi/schema";
import { buildScriptDatumInline } from "./exact/script/datum";
import { DEFAULT_CARDANO_PROVIDER_TIMEOUT_MS } from "./limits";
import type { CardanoExtra, CardanoExtraMasumi, CardanoExtraScript } from "./types";
import { decodeCardanoTransactionBytes, parseAssetUnit, parseUtxoRef } from "./utils";

/**
 * Provider connection used by the reference signers. Exactly one of
 * `blockfrost` or `koios` must be supplied. These map directly onto the
 * Evolution SDK provider configs.
 */
export type CardanoProviderConfig =
  | {
      blockfrost: { baseUrl: string; projectId?: string };
      koios?: never;
      requestTimeoutMs?: number;
    }
  | {
      koios: { baseUrl: string; token?: string };
      blockfrost?: never;
      requestTimeoutMs?: number;
    };

/**
 * Resolves and validates the deadline shared by every reference-signer
 * provider operation.
 *
 * @param provider - Provider configuration.
 * @returns Validated timeout in milliseconds.
 */
function providerTimeoutMs(provider: CardanoProviderConfig): number {
  const timeoutMs = provider.requestTimeoutMs ?? DEFAULT_CARDANO_PROVIDER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("Cardano provider requestTimeoutMs must be an integer from 1 to 120000");
  }
  return timeoutMs;
}

/**
 * Bounds a provider promise even when its SDK transport exposes no abort
 * signal. The underlying request may finish later, but callers never wait past
 * the configured deadline.
 *
 * @param operation - Provider promise to await.
 * @param timeoutMs - Deadline in milliseconds.
 * @param name - Operation name used in timeout errors.
 * @returns The provider result.
 */
export async function withCardanoProviderTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  name: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Cardano provider ${name} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Resolves an x402 Cardano network identifier to an Evolution SDK chain preset.
 *
 * @param network - The x402 network identifier (e.g. "cardano:mainnet").
 * @returns The matching Evolution SDK chain preset.
 */
function resolveChain(network: string): Chain {
  switch (normalizeCardanoNetwork(network)) {
    case CARDANO_MAINNET_CAIP2:
      return mainnet;
    case CARDANO_PREPROD_CAIP2:
      return preprod;
    case CARDANO_PREVIEW_CAIP2:
      return preview;
    default:
      throw new Error(`Unsupported Cardano network: ${network}`);
  }
}

/**
 * Normalizes a BIP-39 mnemonic: trims, collapses internal whitespace, and
 * lowercases it. The BIP-39 word list is all lowercase, so this recovers the
 * correct wallet from a mnemonic that picked up stray capitalization or extra
 * whitespace (e.g. when copied into an env file) instead of failing derivation.
 *
 * @param mnemonic - The raw mnemonic phrase.
 * @returns The normalized mnemonic.
 */
function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Attaches the configured provider to a chain-scoped client assembly.
 *
 * @param assembly - The chain-scoped client assembly.
 * @param provider - The provider connection config.
 * @returns A read-capable client.
 */
function withProvider(
  assembly: ReturnType<typeof Client.make>,
  provider: CardanoProviderConfig,
): ReturnType<ReturnType<typeof Client.make>["withBlockfrost"]> {
  if (provider.blockfrost) {
    return assembly.withBlockfrost(provider.blockfrost);
  }
  return assembly.withKoios(provider.koios);
}

/**
 * Builds the payment-output assets for the requested asset/amount. Lovelace
 * lives in the output coin; native assets live in the multi-asset map.
 *
 * @param asset - The asset unit (`lovelace` or `policyId.assetNameHex`).
 * @param amount - The amount in the asset's smallest unit.
 * @returns Evolution SDK assets describing the output value.
 */
function buildOutputAssets(asset: string, amount: bigint): Assets.Assets {
  if (asset.toLowerCase() === LOVELACE_ASSET) {
    return Assets.fromLovelace(amount);
  }
  const { policyId, assetNameHex } = parseAssetUnit(asset);
  // Native-asset outputs still require lovelace; build() bumps it to the
  // protocol minimum when autoMinUtxo is enabled.
  return Assets.addByHex(Assets.zero, policyId, assetNameHex, amount);
}

/**
 * Client-side signer protocol for Cardano.
 *
 * Implementations integrate the user's wallet / key management. The signer
 * receives the desired payment requirements and returns a base64-encoded
 * signed Cardano transaction along with the UTXO reference used as nonce.
 */
export interface ClientCardanoSigner {
  /**
   * Returns the bech32 address that will fund the payment.
   *
   * @returns The bech32 payment address.
   */
  getAddress(): string;

  /**
   * Builds and signs a Cardano transaction satisfying the supplied payment
   * requirements. The implementation MUST return both the signed CBOR
   * transaction (base64) and the UTXO reference it consumed for replay
   * protection. The chosen UTXO MUST appear as a transaction input.
   *
   * @param input - Payment building parameters.
   * @returns A promise resolving to the signed transaction and nonce.
   */
  buildAndSignPaymentTransaction(
    input: ClientCardanoSignInput,
  ): Promise<ClientCardanoSignResult> | ClientCardanoSignResult;
}

/**
 * Inputs forwarded to a client signer when constructing a payment.
 */
export interface ClientCardanoSignInput {
  /**
   * The x402 network identifier (e.g. "cardano:mainnet").
   */
  network: string;
  /**
   * The recipient bech32 address.
   */
  payTo: string;
  /**
   * The asset unit (`policyId.assetNameHex`).
   */
  asset: string;
  /**
   * The amount in the asset's smallest unit, as a string.
   */
  amount: string;
  /**
   * Maximum lifetime of the transaction in seconds.
   */
  maxTimeoutSeconds: number;
  /**
   * The full `extra` block coming from the payment requirements (includes
   * assetTransferMethod and any method-specific metadata).
   */
  extra?: Record<string, unknown>;
  /** Protected resource, used to validate registered Masumi agent endpoints. */
  resource?: ResourceInfo;
}

/**
 * Result returned by a client signer. The transaction MUST NOT have been
 * broadcast: the facilitator submits it during `settle()`.
 */
export interface ClientCardanoSignResult {
  /**
   * Base64 encoded signed Cardano transaction (CBOR).
   */
  transaction: string;
  /**
   * UTXO reference (`txHashHex#index`) used as nonce. MUST appear as a tx input.
   */
  nonce: string;
}

/**
 * Status returned by the chain layer for a settled / submitted transaction.
 */
export type CardanoSettlementStatus = "confirmed" | "mempool";

/**
 * Authenticated settlement evidence for one transaction.
 *
 * `confirmations` reports the strongest verified evidence: `-1` for
 * authenticated mempool acceptance, `0` for inclusion in a canonical block, and
 * `n` for `n` newer canonical blocks. It is meaningless when `status` is
 * `unknown`, which means the ledger has no record of the transaction.
 */
export interface CardanoSettlementEvidence {
  status: "unknown" | "mempool" | "confirmed";
  confirmations: number;
}

/**
 * Result of submitting a transaction via a facilitator signer.
 */
export interface CardanoSubmissionResult {
  /**
   * Hex transaction hash returned by the chain layer.
   */
  txHash: string;
  /**
   * Settlement status as defined by the spec ("confirmed" recommended;
   * "mempool" is permitted but strongly discouraged).
   */
  status: CardanoSettlementStatus;
}

/**
 * The live protocol parameters the facilitator's built-in phase-1 checks need.
 */
export interface CardanoProtocolParameters {
  /** `coinsPerUtxoByte` (`utxoCostPerByte`): min-UTXO lovelace per output byte. */
  coinsPerUtxoByte: bigint;
  /** `minFeeA`: lovelace per transaction byte. */
  minFeeCoefficient: bigint;
  /** `minFeeB`: constant lovelace per transaction. */
  minFeeConstant: bigint;
}

/**
 * Lightweight UTXO summary returned by the facilitator's chain query layer.
 */
export interface CardanoUtxoSnapshot {
  /**
   * Whether the UTXO currently exists in the chain's UTXO set (i.e. is unspent).
   */
  exists: boolean;
  /**
   * The bech32 address that controls the UTXO. Implementations SHOULD report it
   * even when `exists` is false: on a settlement retry the broadcast payment has
   * already consumed the nonce, and this address is how the facilitator
   * resolves the payer (and, for Masumi, the datum's `buyer`).
   */
  address?: string;
  /**
   * Lovelace held by the UTXO. Required for an unspent input: the facilitator
   * checks value conservation from it before broadcasting.
   */
  coin?: bigint;
  /** Native assets held by the UTXO, keyed by canonical asset unit. */
  assets?: Record<string, bigint>;
  /**
   * Lowercase payment-key hash controlling this UTXO. Required before server
   * submission; omitted for script or legacy addresses.
   */
  paymentKeyHash?: string;
}

/**
 * Facilitator-side signer / chain-query protocol for Cardano.
 *
 * Verification rule 5 of the spec requires confirming that the nonce UTXO
 * exists in the on-chain UTXO set. Verification rule 6 needs the current slot
 * to compare against the transaction's TTL. Settlement (step 6 of the
 * protocol) needs to submit the transaction. All of these are abstracted
 * behind this protocol so the mechanism remains agnostic to the specific
 * Cardano chain provider (Blockfrost, Koios, Yaci-Store, Ogmios, etc.).
 */
export interface FacilitatorCardanoSigner {
  /**
   * Returns all addresses managed by this facilitator. Useful for producing
   * the `signers` field of the `/supported` response.
   *
   * @returns An array of bech32 addresses.
   */
  getAddresses(): readonly string[];

  /**
   * Looks up a single UTXO by reference.
   *
   * Implementations SHOULD return `{ exists: false }` when the UTXO has been
   * spent or never existed, and rethrow / let exceptions propagate when the
   * lookup itself fails (network error, unknown chain, …).
   *
   * @param ref - The UTXO reference (`txHashHex#index`).
   * @param network - The x402 network identifier.
   * @returns A snapshot describing the UTXO presence.
   */
  getUtxo(ref: string, network: string): Promise<CardanoUtxoSnapshot>;

  /**
   * Optional complete ledger phase-1 validator, for facilitators that can run
   * one (e.g. against their own node). `verify()` already checks that the
   * inputs are unspent, the validity interval, value conservation, the fee
   * floor and min-UTXO from provider data; this hook adds the remaining
   * ledger rules and is the only way to accept balance-changing operations
   * (`mint`, `withdrawals`, `certificates`, ...) or script-controlled funding
   * inputs. It MUST throw unless the exact signed transaction passes all
   * phase-1 rules against the authenticated current UTXO set and protocol
   * parameters.
   *
   * @param signedTransactionBase64 - Exact signed transaction CBOR.
   * @param network - The x402 network identifier.
   */
  validatePhase1Transaction?(signedTransactionBase64: string, network: string): Promise<void>;

  /**
   * Returns the current absolute slot number for the supplied network.
   *
   * @param network - The x402 network identifier.
   * @returns The current absolute slot.
   */
  getCurrentSlot(network: string): Promise<bigint>;

  /**
   * Submits a fully signed transaction to the chain. Implementations MAY wait
   * for confirmation; if they do not, they SHOULD return `status: "mempool"`
   * and the facilitator will surface that to the client (the spec discourages
   * granting access on `mempool`).
   *
   * @param signedTransactionBase64 - The base64-encoded CBOR transaction.
   * @param network - The x402 network identifier.
   * @returns The submission result.
   */
  submitTransaction(
    signedTransactionBase64: string,
    network: string,
  ): Promise<CardanoSubmissionResult>;

  /**
   * Optional classifier for a submission error that definitively proves the
   * transaction was rejected before it could be accepted. Ambiguous transport,
   * timeout and provider errors MUST return false or leave this hook absent.
   */
  isDefinitiveSubmissionRejection?(error: unknown): boolean;

  /**
   * Optional: waits for confirmation of a previously submitted transaction.
   * Implementations that already wait inside `submitTransaction` may return
   * immediately.
   *
   * @param txHash - The hex transaction hash to wait for.
   * @param network - The x402 network identifier.
   * @returns A promise that resolves once the transaction is confirmed.
   */
  waitForConfirmation?(txHash: string, network: string): Promise<void>;

  /**
   * Optional: ask a Cardano node / evaluation service to dry-run the signed
   * transaction. When implemented, the facilitator's `verify()` calls it after
   * the spec's six rules have passed. This evaluates Plutus script execution
   * units only (Ogmios evaluateTransaction / Blockfrost /utils/txs/evaluate);
   * it does NOT validate vkey signatures and is a no-op for simple
   * address-to-address payments. vkey-signature authorization is enforced by
   * the node at submit time (settle), per the eUTXO model.
   *
   * Implementations should throw on any rejection. The thrown error is
   * surfaced as `invalid_message` on the verify response.
   *
   * @param signedTransactionBase64 - The base64-encoded CBOR transaction.
   * @param network - The x402 network identifier.
   * @returns A promise that resolves on a successful dry-run.
   */
  evaluateTransaction?(signedTransactionBase64: string, network: string): Promise<void>;

  /**
   * Optional: reads authenticated settlement evidence for one transaction.
   *
   * Required for any `confirmationPolicy.l1Confirmations` above `0`, which
   * needs the real canonical depth, and for the `settlement_pending` retry to
   * resume observing a transaction this facilitator already broadcast.
   * Without this hook, the facilitator cannot advertise confirmation depths
   * above canonical inclusion.
   *
   * Implementations MUST return `status: "unknown"` when the ledger has no
   * record of the transaction, and SHOULD throw only on lookup failure. A
   * transaction the ledger marked phase-2 invalid (`valid_contract: false`)
   * MUST also report `unknown`: it lands under its own id but consumes
   * collateral instead of its inputs and creates none of its declared outputs,
   * so it is not evidence that anything was paid.
   *
   * @param txHash - The canonical Cardano transaction id (hex).
   * @param network - The x402 network identifier.
   * @returns The strongest verified evidence for that transaction.
   */
  getTransactionEvidence?(txHash: string, network: string): Promise<CardanoSettlementEvidence>;

  /**
   * Optional: reads the live protocol parameters. When implemented, the
   * facilitator's `verify()` rejects a recipient output below the protocol
   * min-UTXO and a fee below the protocol floor — both transactions the chain
   * would refuse at submission. The values are governance-settable, so the spec
   * requires reading them live rather than hardcoding.
   *
   * @param network - The x402 network identifier.
   * @returns The current protocol parameters.
   */
  getProtocolParameters?(network: string): Promise<CardanoProtocolParameters>;
}

/**
 * Configuration for the reference {@link toClientCardanoSigner} factory.
 */
export interface ClientCardanoSignerConfig {
  /**
   * BIP-39 mnemonic controlling the funding wallet.
   */
  mnemonic: string;
  /**
   * The x402 network identifier (one of `CARDANO_NETWORKS`).
   */
  network: string;
  /**
   * Provider connection used to read wallet UTXOs and protocol parameters.
   */
  provider: CardanoProviderConfig;
  /**
   * Optional account index for key derivation. Defaults to 0.
   */
  accountIndex?: number;
  /**
   * Supplies the buyer-side datum fields for a Masumi lock, called once per
   * payment with the server's masumi `extra`. Only `buyer_return_address` is
   * buyer-chosen — every other datum field comes from the seller-signed
   * `terms`. Omit it to take the contract default (`None`).
   */
  masumiBuyerInput?: (extra: CardanoExtraMasumi) => MasumiBuyerInput | Promise<MasumiBuyerInput>;
  /**
   * Independently validates a Masumi registry claim before paying. Without one,
   * a 402 whose `terms.agentIdentifier` claims a registered agent is refused
   * rather than paid on an unverified reputation claim.
   */
  validateMasumiRegistryClaim?: MasumiRegistryValidator;
  /**
   * The buyer's own content for `inputCommitment` parts the issuer chose not to
   * echo, keyed by part name. The issuer may omit content for parts derived
   * from the buyer's own request bytes, and the buyer recomputes those digests
   * from what it actually sent. A 402 carrying an omitted part that is not
   * supplied here is **refused**: a seller free to invent that part's digest is
   * free to bind the escrow to a request that was never made.
   */
  masumiRequestContent?: Record<string, unknown>;
  /**
   * Explicitly approves one non-canonical `extra.deployment`. Choosing a
   * deployment is choosing the escrow's dispute arbitrators, so approval must
   * inspect the exact network, address and applied parameters.
   */
  validateCustomMasumiDeployment?: MasumiDeploymentValidator;
  /**
   * Ceiling on the `collateral_return_lovelace` this client will lock,
   * defaulting to {@link MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE}.
   *
   * The collateral is derived from the datum size, and the datum carries the
   * seller's `reference_key` and `reference_signature` verbatim — so a seller
   * that pads them inflates the buyer's own locked funds. The collateral does
   * come back, but not before `submit_result_time`.
   */
  masumiMaxCollateralLovelace?: bigint;
  /**
   * How far past now `external_dispute_unlock_time` may sit, defaulting to
   * {@link MASUMI_MAX_DEADLINE_HORIZON_MS}. Until `submit_result_time` passes
   * the buyer can recover neither the payment nor its collateral, so this bounds
   * how long a 402 can hold the wallet's funds.
   */
  masumiMaxDeadlineHorizonMs?: bigint;
}

/**
 * Builds a reference {@link ClientCardanoSigner} backed by the Evolution SDK.
 *
 * The signer picks a wallet UTXO as the replay-protection nonce, pays the
 * requested asset/amount to `payTo`, sets the transaction TTL from
 * `maxTimeoutSeconds`, signs offline, and returns the base64 signed CBOR plus
 * the chosen UTXO reference. The returned transaction satisfies the
 * facilitator's `verify()` rules: the nonce appears as an input, an output
 * pays the requested asset/amount, and at least one vkey witness is present.
 *
 * @param config - The client signer configuration.
 * @returns A ready-to-use client signer.
 */
export function toClientCardanoSigner(config: ClientCardanoSignerConfig): ClientCardanoSigner {
  const chain = resolveChain(config.network);
  const timeoutMs = providerTimeoutMs(config.provider);
  const mnemonic = normalizeMnemonic(config.mnemonic);
  const client = withProvider(Client.make(chain), config.provider).withSeed({
    mnemonic,
    accountIndex: config.accountIndex,
  });

  // Derive the funding address synchronously so getAddress() needs no await.
  const address = Address.toBech32(
    addressFromSeed(mnemonic, {
      accountIndex: config.accountIndex,
      networkId: chain.id,
    }).address,
  );

  return {
    getAddress(): string {
      return address;
    },

    async buildAndSignPaymentTransaction(
      input: ClientCardanoSignInput,
    ): Promise<ClientCardanoSignResult> {
      if (normalizeCardanoNetwork(input.network) !== normalizeCardanoNetwork(config.network)) {
        throw new Error(
          `Signer configured for ${config.network} but asked to pay on ${input.network}`,
        );
      }

      // Validate the 402 before touching the wallet: a malicious or malformed
      // Masumi 402 must be refused before any funds are selected.
      const extra = input.extra as CardanoExtra | undefined;
      let masumiExtra: CardanoExtraMasumi | undefined;
      let masumiBuyerInput: MasumiBuyerInput = {};
      if (extra?.assetTransferMethod === ASSET_TRANSFER_METHOD_MASUMI) {
        const schema = validateMasumiExtra(extra, input.network);
        if (!schema.ok) {
          throw new Error(`Masumi payment requirements are invalid: ${schema.detail}`);
        }
        masumiExtra = schema.extra;
        // The client MUST verify the seller authorization itself — it is about
        // to sign away real value on the strength of this 402. Skipping this
        // would let a malicious 402 send funds to a non-escrow address or bind
        // them to terms no seller ever signed.
        const authorization = await verifyMasumiAuthorization(
          masumiExtra,
          {
            scheme: "exact",
            network: input.network as PaymentRequirements["network"],
            asset: input.asset,
            amount: input.amount,
            payTo: input.payTo,
            maxTimeoutSeconds: input.maxTimeoutSeconds,
            extra: extra as unknown as Record<string, unknown>,
          },
          {
            // The client sees the original request, so every commitment part
            // must verify — an unverifiable one binds the escrow to a request
            // the buyer never made.
            requireAllPartContent: true,
            ...(config.masumiRequestContent
              ? { localCommitmentContent: config.masumiRequestContent }
              : {}),
            ...(config.validateMasumiRegistryClaim
              ? { validateRegistryClaim: config.validateMasumiRegistryClaim }
              : {}),
            ...(input.resource ? { resource: input.resource } : {}),
            ...(config.validateCustomMasumiDeployment
              ? { validateCustomDeployment: config.validateCustomMasumiDeployment }
              : {}),
            // Always set: the horizon is buyer policy, so the client is the
            // side that applies it. A verifier leaves it unset.
            maxDeadlineHorizonMs:
              config.masumiMaxDeadlineHorizonMs ?? MASUMI_MAX_DEADLINE_HORIZON_MS,
          },
        );
        if (!authorization.ok) {
          throw new Error(
            `Masumi seller authorization failed: ${authorization.reason}${
              authorization.detail ? ` (${authorization.detail})` : ""
            }`,
          );
        }
        assertMasumiPaymentWindow(masumiExtra, input.maxTimeoutSeconds);
        masumiBuyerInput = (await config.masumiBuyerInput?.(masumiExtra)) ?? {};
        if (
          masumiBuyerInput.buyerReturnAddress !== undefined &&
          !isKeyCredentialAddressOn(masumiBuyerInput.buyerReturnAddress, input.network)
        ) {
          throw new Error(
            "Masumi buyer return address must be a key-credential address on network",
          );
        }
      }

      const changeAddress = await client.address();
      const utxos = await withCardanoProviderTimeout(
        client.getWalletUtxos(),
        timeoutMs,
        "getWalletUtxos",
      );
      if (utxos.length === 0) {
        throw new Error("Funding wallet has no UTXOs available for the payment");
      }
      // Use the first wallet UTXO as the nonce; collectFrom forces it to appear
      // as a transaction input (verification rule 5).
      const nonceUtxo = utxos[0];
      const nonceTxHash = Buffer.from(nonceUtxo.transactionId.hash).toString("hex").toLowerCase();
      const nonce = `${nonceTxHash}#${Number(nonceUtxo.index)}`;

      // Masumi attaches an inline lock datum whose `buyer` must control the
      // nonce input the facilitator resolves, so derive it from that UTXO. The
      // script method attaches the server-supplied inline datum verbatim
      // (contract-specific; not verified). Other methods pay a plain output.
      const scriptExtra =
        extra?.assetTransferMethod === ASSET_TRANSFER_METHOD_SCRIPT
          ? (extra as CardanoExtraScript)
          : undefined;

      const amount = BigInt(input.amount);
      const isLovelace = input.asset.toLowerCase() === LOVELACE_ASSET;
      let outputAssets = buildOutputAssets(input.asset, amount);
      let paymentDatum = scriptExtra ? buildScriptDatumInline(scriptExtra) : undefined;

      if (masumiExtra) {
        // The seller never signs `collateral_return_lovelace`; the client derives
        // it from the requested asset and live protocol parameters so the escrow
        // still clears min-UTXO after `SubmitResult`.
        const { coinsPerUtxoByte } = await withCardanoProviderTimeout(
          client.getProtocolParameters(),
          timeoutMs,
          "getProtocolParameters",
        );
        const lock = buildMasumiLock(
          masumiExtra,
          Address.toBech32(nonceUtxo.address),
          input.asset,
          amount,
          coinsPerUtxoByte,
          masumiBuyerInput,
        );
        const datumView = parseMasumiLockDatum(lock.datum.data);
        if (!datumView) {
          throw new Error("Masumi client preflight could not decode the lock datum");
        }
        const datumInvariants = verifyMasumiDatumInvariants(datumView, input.payTo);
        if (!datumInvariants.ok) {
          throw new Error(
            `Masumi client preflight failed: ${datumInvariants.reason}${
              datumInvariants.detail ? ` (${datumInvariants.detail})` : ""
            }`,
          );
        }
        // The collateral is the buyer's own money and follows the datum size,
        // which the seller inflates by padding `reference_key` /
        // `reference_signature`. Refuse before signing rather than lock it away
        // until `submit_result_time`.
        const maxCollateral =
          config.masumiMaxCollateralLovelace ?? MASUMI_DEFAULT_MAX_COLLATERAL_LOVELACE;
        if (lock.collateralLovelace > maxCollateral) {
          throw new Error(
            `Masumi client preflight failed: collateral ${lock.collateralLovelace} exceeds the ` +
              `configured maximum ${maxCollateral}`,
          );
        }
        paymentDatum = lock.datum;
        // The escrow output carries EXACTLY the requested asset set, with
        // `lockedLovelace = requestedLovelace + collateral`.
        if (isLovelace) {
          outputAssets = Assets.fromLovelace(lock.lockedLovelace);
        } else {
          const { policyId, assetNameHex } = parseAssetUnit(input.asset);
          outputAssets = Assets.addByHex(
            Assets.fromLovelace(lock.lockedLovelace),
            policyId,
            assetNameHex,
            amount,
          );
        }
      }

      // Masumi: anchor the tx's validity upper bound to pay_by_time so the lock
      // can never settle past the deadline (Masumi invalidates a late lock).
      // Other methods use maxTimeoutSeconds.
      const ttlMs = masumiExtra
        ? BigInt(masumiExtra.terms.payByTime)
        : BigInt(Date.now()) + BigInt(input.maxTimeoutSeconds) * 1000n;

      const signBuilder = await withCardanoProviderTimeout(
        client
          .newTx()
          // .collectFrom() with a specific UTXO ensures the nonce appears as an input (rule 5).
          // Additional UTXOs from the wallet may be auto-selected as needed to satisfy the output and fees.
          .collectFrom({ inputs: [nonceUtxo] })
          .payToAddress({
            address: Address.fromBech32(input.payTo),
            assets: outputAssets,
            ...(paymentDatum ? { datum: paymentDatum } : {}),
          })
          .setValidity({ to: ttlMs })
          .build({
            changeAddress,
            // Bump the output to the protocol min-UTXO for native-asset outputs
            // and for datum-bearing outputs (an attached datum raises it). A
            // Masumi lock already carries its exact structural lovelace, and
            // raising it would break `locked == requested + collateral`.
            autoMinUtxo: masumiExtra ? false : !isLovelace || paymentDatum !== undefined,
          }),
        timeoutMs,
        "buildTransaction",
      );

      const submitBuilder = await signBuilder.sign();
      const unsigned = await signBuilder.toTransaction();
      const signed = new Transaction.Transaction({
        body: unsigned.body,
        witnessSet: submitBuilder.witnessSet,
        isValid: true,
        auxiliaryData: null,
      });

      if (masumiExtra) {
        assertMasumiPayByTimeNotExpired(masumiExtra);
      }

      // Never broadcast here: the facilitator verifies and submits the exact
      // signed bytes during `settle()`.
      return {
        transaction: Buffer.from(Transaction.toCBORBytes(signed)).toString("base64"),
        nonce,
      };
    },
  };
}

/**
 * Ensures the transaction validity bound derived from `payByTime` still lies
 * inside the x402 validity window before the wallet is touched.
 *
 * @param extra - Validated Masumi requirements.
 * @param maxTimeoutSeconds - x402 validity-window limit.
 */
function assertMasumiPaymentWindow(extra: CardanoExtraMasumi, maxTimeoutSeconds: number): void {
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error("Masumi maxTimeoutSeconds must be a positive safe integer");
  }
  assertMasumiPayByTimeNotExpired(extra);
  const payByTime = BigInt(extra.terms.payByTime);
  const latestPayByTime = BigInt(Date.now()) + BigInt(maxTimeoutSeconds) * 1000n;
  if (payByTime > latestPayByTime) {
    throw new Error("Masumi client preflight failed: payByTime exceeds maxTimeoutSeconds");
  }
}

/**
 * Re-checks only the bound that can newly fail between preflight and broadcast.
 *
 * The `maxTimeoutSeconds` ceiling is deliberately not repeated here: it grows
 * with the wall clock, so once it has been cleared it cannot fail later. Expiry
 * is the opposite — building and signing takes real time, and a transaction
 * whose TTL is already past `pay_by_time` can never settle.
 *
 * @param extra - Validated Masumi requirements.
 */
function assertMasumiPayByTimeNotExpired(extra: CardanoExtraMasumi): void {
  if (BigInt(extra.terms.payByTime) <= BigInt(Date.now())) {
    throw new Error("Masumi client preflight failed: payByTime has expired");
  }
}

/** How long the reference facilitator signer caches protocol parameters. */
const PROTOCOL_PARAMETERS_CACHE_MS = 10 * 60_000;

/**
 * Configuration for the reference {@link toFacilitatorCardanoSigner} factory.
 */
export interface FacilitatorCardanoSignerConfig {
  /**
   * Optional BIP-39 mnemonic. The facilitator only broadcasts the client's
   * already-signed transaction (the client pays the network fee), so it needs no
   * funds and no signing key. When supplied, its address is exposed via
   * `getAddresses` for the `/supported` response; when omitted the facilitator
   * runs provider-only and `getAddresses` returns an empty list.
   */
  mnemonic?: string;
  /**
   * The x402 network identifier (one of `CARDANO_NETWORKS`).
   */
  network: string;
  /**
   * Provider connection used for chain lookups and submission.
   */
  provider: CardanoProviderConfig;
  /**
   * Optional account index for key derivation. Defaults to 0.
   */
  accountIndex?: number;
  /**
   * When `true` (default), `submitTransaction` awaits on-chain confirmation
   * before reporting `status: "confirmed"`. Set to `false` to return
   * `status: "mempool"` immediately after broadcast and let the facilitator
   * scheme poll for the confirmation policy's evidence instead; that needs a
   * Blockfrost provider, which is the only one with transaction evidence.
   */
  awaitConfirmation?: boolean;
  /**
   * Optional complete Cardano ledger phase-1 validator, for operators that can
   * run one (e.g. against their own node). Without it the facilitator relies on
   * its built-in checks (inputs unspent, validity interval, value conservation,
   * fee floor, min-UTXO), which is what every standard provider setup can do.
   */
  validatePhase1Transaction?: (signedTransactionBase64: string, network: string) => Promise<void>;
}

/**
 * Direct Blockfrost REST access for the two queries the Evolution provider
 * interface does not expose: authenticated settlement evidence (a
 * transaction's canonical depth) and the owner of an already-spent UTXO.
 *
 * Returns a disabled shim when the signer is configured with another provider;
 * the facilitator then cannot settle confirmation depths above canonical
 * inclusion or resume a pending settlement.
 *
 * @param provider - The signer's provider connection config.
 * @returns The Blockfrost query helpers.
 */
export function blockfrostQueries(provider: CardanoProviderConfig): {
  enabled: boolean;
  evidence(txHash: string): Promise<CardanoSettlementEvidence>;
  spentUtxoAddress(txHash: string, index: number): Promise<{ address?: string }>;
  /**
   * Whether Blockfrost records the output as consumed (`consumed_by_tx`).
   * `undefined` when the transaction or output is unknown to the provider.
   */
  outputConsumed(txHash: string, index: number): Promise<boolean | undefined>;
} {
  const timeoutMs = providerTimeoutMs(provider);
  const config = provider.blockfrost;
  if (!config) {
    return {
      enabled: false,
      evidence: () => Promise.resolve({ status: "unknown", confirmations: -2 }),
      spentUtxoAddress: () => Promise.resolve({}),
      outputConsumed: () => Promise.resolve(undefined),
    };
  }
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const headers = config.projectId ? { project_id: config.projectId } : undefined;
  /**
   * Performs one Blockfrost GET.
   *
   * @param path - The API path, starting with a slash.
   * @returns The parsed body, or `null` on 404.
   */
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Blockfrost ${path} failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as Record<string, unknown>;
  };

  return {
    enabled: true,

    async evidence(txHash: string): Promise<CardanoSettlementEvidence> {
      const tx = await get(`/txs/${txHash}`);
      if (!tx) {
        // Not on chain. Blockfrost exposes no mempool read, so an unconfirmed
        // transaction is indistinguishable from an unknown one.
        return { status: "unknown", confirmations: -2 };
      }
      // A phase-2-invalid transaction is recorded under this id but consumed its
      // collateral instead of its inputs and produced none of its declared
      // outputs. It paid nothing, so it is not evidence of settlement.
      if (tx.valid_contract === false) {
        return { status: "unknown", confirmations: -2 };
      }
      const tip = await get("/blocks/latest");
      const txHeight = Number(tx.block_height);
      const tipHeight = Number(tip?.height);
      if (!Number.isFinite(txHeight) || !Number.isFinite(tipHeight)) {
        return { status: "confirmed", confirmations: 0 };
      }
      // `confirmations` counts blocks NEWER than the one containing the tx.
      return { status: "confirmed", confirmations: Math.max(0, tipHeight - txHeight) };
    },

    async spentUtxoAddress(txHash: string, index: number): Promise<{ address?: string }> {
      const utxos = await get(`/txs/${txHash}/utxos`);
      const outputs = (utxos?.outputs ?? []) as Array<{
        output_index?: number;
        address?: string;
      }>;
      const output = outputs.find(o => o.output_index === index);
      return output?.address ? { address: output.address } : {};
    },

    async outputConsumed(txHash: string, index: number): Promise<boolean | undefined> {
      const utxos = await get(`/txs/${txHash}/utxos`);
      const outputs = (utxos?.outputs ?? []) as Array<{
        output_index?: number;
        consumed_by_tx?: string | null;
      }>;
      const output = outputs.find(o => o.output_index === index);
      if (!output || output.consumed_by_tx === undefined) return undefined;
      return typeof output.consumed_by_tx === "string" && output.consumed_by_tx.length > 0;
    },
  };
}

/**
 * Builds a reference {@link FacilitatorCardanoSigner} backed by the Evolution
 * SDK provider for chain queries and transaction submission.
 *
 * @param config - The facilitator signer configuration.
 * @returns A ready-to-use facilitator signer.
 */
export function toFacilitatorCardanoSigner(
  config: FacilitatorCardanoSignerConfig,
): FacilitatorCardanoSigner {
  const chain = resolveChain(config.network);
  const timeoutMs = providerTimeoutMs(config.provider);
  const providerClient = withProvider(Client.make(chain), config.provider);
  const slotConfig = chain.slotConfig;
  const blockfrost = blockfrostQueries(config.provider);

  // The facilitator only broadcasts the client's already-signed transaction and
  // queries the chain — both are provider operations. A mnemonic is optional and
  // used solely to expose an address via getAddresses() for the /supported
  // response; without it the facilitator runs provider-only (no funds, no signer).
  // Without Blockfrost the signer cannot read settlement evidence, so the only
  // way it can ever report inclusion is to await it inside submitTransaction. A
  // Koios signer that returns on broadcast would leave every payment above
  // mempool level unsettleable, so refuse that combination up front.
  if (!blockfrost.enabled && config.awaitConfirmation === false) {
    throw new Error(
      "awaitConfirmation: false requires a Blockfrost provider; a signer without transaction evidence must await confirmation itself",
    );
  }

  const mnemonic = config.mnemonic ? normalizeMnemonic(config.mnemonic) : undefined;
  const client = mnemonic
    ? providerClient.withSeed({ mnemonic, accountIndex: config.accountIndex })
    : providerClient;
  const addresses: readonly string[] = mnemonic
    ? [
        Address.toBech32(
          addressFromSeed(mnemonic, {
            accountIndex: config.accountIndex,
            networkId: chain.id,
          }).address,
        ),
      ]
    : [];

  const assertNetwork = (network: string): void => {
    if (normalizeCardanoNetwork(network) !== normalizeCardanoNetwork(config.network)) {
      throw new Error(`Signer configured for ${config.network} but asked about ${network}`);
    }
  };

  // Protocol parameters change only at an epoch/governance boundary, so caching
  // them avoids a provider round-trip on every verify(); the cache expires so a
  // long-lived facilitator picks up a governance change within minutes.
  let protocolParameters: { value: CardanoProtocolParameters; fetchedAt: number } | undefined;

  /**
   * Whether an output the provider resolved by out-ref has since been spent.
   * Blockfrost reports it directly (`consumed_by_tx`); otherwise the owner's
   * unspent set, which every provider serves, decides.
   *
   * @param txHash - Producing transaction id.
   * @param index - Output index.
   * @param address - The output's address.
   * @returns True when the output is no longer in the UTXO set.
   */
  const outputSpent = async (
    txHash: string,
    index: number,
    address: Address.Address,
  ): Promise<boolean> => {
    if (blockfrost.enabled) {
      const consumed = await blockfrost.outputConsumed(txHash, index);
      if (consumed !== undefined) return consumed;
    }
    const unspent = await withCardanoProviderTimeout(
      client.getUtxos(address),
      timeoutMs,
      "getUtxos",
    );
    return !unspent.some(
      candidate =>
        Buffer.from(candidate.transactionId.hash).toString("hex").toLowerCase() === txHash &&
        Number(candidate.index) === index,
    );
  };

  return {
    getAddresses(): readonly string[] {
      return addresses;
    },

    ...(config.validatePhase1Transaction
      ? {
          async validatePhase1Transaction(
            signedTransactionBase64: string,
            network: string,
          ): Promise<void> {
            assertNetwork(network);
            await config.validatePhase1Transaction!(signedTransactionBase64, network);
          },
        }
      : {}),

    async getUtxo(ref: string, network: string): Promise<CardanoUtxoSnapshot> {
      assertNetwork(network);
      const { txHash, index } = parseUtxoRef(ref);
      const input = new TransactionInput.TransactionInput({
        transactionId: TransactionHash.fromHex(txHash),
        index: BigInt(index),
      });
      const utxos = await withCardanoProviderTimeout(
        client.getUtxosByOutRef([input]),
        timeoutMs,
        "getUtxosByOutRef",
      );
      if (utxos.length > 0) {
        const utxo = utxos[0];
        const assets: Record<string, bigint> = {};
        if (utxo.assets.multiAsset) {
          for (const [policyId, innerMap] of utxo.assets.multiAsset.map) {
            const policyHex = Buffer.from(policyId.hash).toString("hex").toLowerCase();
            for (const [assetName, quantity] of innerMap) {
              const assetNameHex = Buffer.from(assetName.bytes).toString("hex").toLowerCase();
              assets[`${policyHex}.${assetNameHex}`] = quantity;
            }
          }
        }
        const address = Address.toBech32(utxo.address);
        const paymentCredential = Address.getPaymentCredential(Address.toHex(utxo.address));
        const owner = {
          address,
          ...(paymentCredential?._tag === "KeyHash"
            ? { paymentKeyHash: Credential.toHex(paymentCredential).toLowerCase() }
            : {}),
        };
        // Both Evolution providers resolve an out-ref from the producing
        // transaction's outputs, which still lists an output after it has been
        // spent. Ask the provider whether it was consumed before reporting it
        // unspent, or rule 5 (inputs unspent) would never fire.
        if (await outputSpent(txHash, index, utxo.address)) {
          return { exists: false, ...owner };
        }
        return { exists: true, ...owner, coin: utxo.assets.lovelace, assets };
      }
      // Spent (or unknown). A settlement retry still needs the owner address to
      // resolve the payer, so read it from the producing transaction when the
      // provider can serve it.
      return { exists: false, ...(await blockfrost.spentUtxoAddress(txHash, index)) };
    },

    ...(blockfrost.enabled
      ? {
          async getTransactionEvidence(
            txHash: string,
            network: string,
          ): Promise<CardanoSettlementEvidence> {
            assertNetwork(network);
            return blockfrost.evidence(txHash);
          },
        }
      : {}),

    async getCurrentSlot(network: string): Promise<bigint> {
      assertNetwork(network);
      // SlotConfig.zeroTime and slotLength are both in milliseconds for the
      // Evolution presets: slot = zeroSlot + floor((nowMs - zeroTime) / slotLength).
      const elapsedSlots = Math.floor(
        (Date.now() - Number(slotConfig.zeroTime)) / slotConfig.slotLength,
      );
      return slotConfig.zeroSlot + BigInt(elapsedSlots);
    },

    async submitTransaction(
      signedTransactionBase64: string,
      network: string,
    ): Promise<CardanoSubmissionResult> {
      assertNetwork(network);
      const tx = Transaction.fromCBORBytes(decodeCardanoTransactionBytes(signedTransactionBase64));
      const hash = await withCardanoProviderTimeout(client.submitTx(tx), timeoutMs, "submitTx");
      const txHash = Buffer.from(hash.hash).toString("hex").toLowerCase();
      if (config.awaitConfirmation === false) {
        return { txHash, status: "mempool" };
      }
      // The broadcast already succeeded. A failure while WAITING for inclusion
      // must not be reported as a failed submission: the facilitator would then
      // treat a transaction that is on its way to the chain as never sent. Report
      // mempool acceptance instead and let the confirmation policy decide.
      try {
        await withCardanoProviderTimeout(client.awaitTx(hash), timeoutMs, "awaitTx");
      } catch {
        return { txHash, status: "mempool" };
      }
      return { txHash, status: "confirmed" };
    },

    async waitForConfirmation(txHash: string, network: string): Promise<void> {
      assertNetwork(network);
      await withCardanoProviderTimeout(
        client.awaitTx(TransactionHash.fromHex(txHash)),
        timeoutMs,
        "awaitTx",
      );
    },

    async evaluateTransaction(signedTransactionBase64: string, network: string): Promise<void> {
      assertNetwork(network);
      const tx = Transaction.fromCBORBytes(decodeCardanoTransactionBytes(signedTransactionBase64));
      await withCardanoProviderTimeout(client.evaluateTx(tx), timeoutMs, "evaluateTx");
    },

    async getProtocolParameters(network: string): Promise<CardanoProtocolParameters> {
      assertNetwork(network);
      if (
        protocolParameters === undefined ||
        Date.now() - protocolParameters.fetchedAt > PROTOCOL_PARAMETERS_CACHE_MS
      ) {
        const params = await withCardanoProviderTimeout(
          client.getProtocolParameters(),
          timeoutMs,
          "getProtocolParameters",
        );
        protocolParameters = {
          value: {
            coinsPerUtxoByte: params.coinsPerUtxoByte,
            minFeeCoefficient: BigInt(params.minFeeA),
            minFeeConstant: BigInt(params.minFeeB),
          },
          fetchedAt: Date.now(),
        };
      }
      return protocolParameters.value;
    },
  };
}
