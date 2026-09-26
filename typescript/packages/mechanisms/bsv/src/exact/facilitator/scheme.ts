import { Beef, PublicKey, Utils } from "@bsv/sdk";
import type { Transaction, WalletInterface } from "@bsv/sdk";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { ExactBsvPayloadV2 } from "../../types";
import {
  BRC29_PROTOCOL_ID,
  BSV_ASSET_IDENTIFIER,
  toBsvWalletNetwork,
  BSV_WILDCARD_CAIP2,
  COMPRESSED_PUBKEY_REGEX,
  DEFAULT_PAYMENT_WINDOW_MS,
  MAX_SATOSHIS,
  MIN_DERIVATION_PREFIX_BYTES,
  isBsvNetwork,
} from "../../constants";

export interface ExactBsvSchemeConfig {
  /**
   * The recipient's BRC-100 wallet. Settlement internalizes the payment
   * output into this wallet (BRC-29 `wallet payment` remittance), which is
   * the only party able to derive the payment key's private half.
   */
  wallet: WalletInterface;

  /**
   * The wallet's identity public key (compressed secp256k1 hex). Must match
   * `PaymentRequirements.payTo` for payments this facilitator can accept.
   * Use {@link ExactBsvScheme.create} to fetch it from the wallet instead.
   */
  identityKey: string;

  /**
   * Payment freshness window in milliseconds (BRC-121 default: 30 000).
   * At verify time the Unix-ms timestamp encoded in `derivationSuffix` must
   * be within this window of the facilitator's clock, in either direction.
   * At settle time the window is extended by `maxTimeoutSeconds` — the
   * server's advertised settlement budget.
   *
   * @default 30000
   */
  paymentWindowMs?: number;

  /**
   * Optional SPV pre-check run during `verify` (not `settle`). Because the
   * base `verify` performs only structural/derivation checks — the wallet's
   * SPV validation happens at `settle` — a structurally valid but unfunded
   * or invalid BEEF can force a resource handler to run before settlement
   * rejects it. Supply this to SPV-validate the BEEF at verify time and
   * close that DoS surface. Return `true` if the transaction is SPV-valid.
   */
  spvOnVerify?: (beefBytes: number[], subjectTxid: string) => Promise<boolean>;
}

/**
 * Floor for how long settled txids are remembered for duplicate-settlement
 * defense. The effective TTL per payment is at least the settlement
 * freshness window (paymentWindow + maxTimeoutSeconds) plus a margin, so a
 * replay can never outlive the window during which re-verification would
 * still accept it.
 */
const SETTLEMENT_CACHE_TTL_FLOOR_MS = 600_000;

/** Margin added on top of the settlement window when sizing the dedup TTL */
const SETTLEMENT_CACHE_TTL_MARGIN_MS = 60_000;

/**
 * BSV facilitator implementation for the `exact` payment scheme.
 *
 * Unlike account-based chains, a BRC-29/BRC-121 payment pays a key derived
 * from the *recipient's* identity key — a third party cannot take custody
 * of the output, nor verify its destination unless a counterparty
 * voluntarily discloses a key linkage (BRC-100 `revealSpecificKeyLinkage`,
 * per BRC-69/BRC-94). This facilitator therefore wraps the recipient's
 * own BRC-100 wallet (the standard BRC-121 deployment, run in-process or
 * self-hosted): `verify` checks structure, freshness, exact amount, and
 * that the payment output pays the correct BRC-42-derived key; `settle`
 * takes custody via `internalizeAction`, which SPV-validates the BEEF and
 * enforces transaction uniqueness.
 *
 * Replay protection is layered: a facilitator-side txid dedup cache, the
 * wallet's merge signal (`isMerge` / `satoshis` wallet-toolbox extensions —
 * not part of the core BRC-100 result shape), and the bounded freshness
 * window. `isMerge` alone is not a replay: self-payments (same wallet
 * creates and internalizes) report `isMerge: true` with newly internalized
 * satoshis on first settle.
 *
 * The dedup cache is process-local (an in-memory Map). Operators running
 * multiple facilitator instances (or restarting between settle attempts)
 * MUST route a given payment to a consistent instance (sticky sessions) or
 * rely on the wallet's own transaction-uniqueness, since a fresh instance
 * cannot see another's cache. A shared/persistent store is out of scope
 * here.
 */
export class ExactBsvScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = BSV_WILDCARD_CAIP2;

  private readonly wallet: WalletInterface;
  private readonly identityKey: string;
  private readonly paymentWindowMs: number;
  private readonly spvOnVerify?: (beefBytes: number[], subjectTxid: string) => Promise<boolean>;
  private walletNetworkPromise: Promise<string> | undefined;
  private readonly settledTxids = new Map<string, number>();

  /**
   * Creates a new ExactBsvScheme facilitator instance.
   *
   * @param config - Facilitator scheme configuration
   */
  constructor(config: ExactBsvSchemeConfig) {
    if (!config.identityKey || !COMPRESSED_PUBKEY_REGEX.test(config.identityKey)) {
      throw new Error(
        "identityKey must be a compressed secp256k1 public key (use ExactBsvScheme.create to fetch it from the wallet)",
      );
    }
    this.wallet = config.wallet;
    this.identityKey = config.identityKey.toLowerCase();
    this.paymentWindowMs = config.paymentWindowMs ?? DEFAULT_PAYMENT_WINDOW_MS;
    this.spvOnVerify = config.spvOnVerify;
  }

  /**
   * Creates a facilitator scheme, fetching the identity key from the wallet.
   *
   * @param config - Configuration without the identity key
   * @returns A ready-to-register facilitator scheme
   */
  static async create(config: Omit<ExactBsvSchemeConfig, "identityKey">): Promise<ExactBsvScheme> {
    const { publicKey } = await config.wallet.getPublicKey({ identityKey: true });
    return new ExactBsvScheme({ ...config, identityKey: publicKey });
  }

  /**
   * Returns extra metadata for the /supported endpoint.
   *
   * @param _ - Network identifier (unused; no fee sponsorship on BSV)
   * @returns Undefined — clients fund and fee their own transactions
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Returns signer addresses for the /supported endpoint.
   *
   * @param _ - Network identifier (unused, same wallet for all networks)
   * @returns The recipient wallet's identity public key
   */
  getSigners(_: string): string[] {
    return [this.identityKey];
  }

  /**
   * Verifies a BSV payment payload.
   *
   * Checks scheme/network agreement, wallet-chain agreement, payload shape,
   * sender key format, payee match (this facilitator can only accept
   * payments to its own wallet), BRC-121 timestamp freshness, BEEF
   * decodability, exact amount, and that the payment output pays the
   * BRC-42-derived key for this payment. SPV validity of the BEEF ancestry
   * is enforced by the wallet during settlement.
   *
   * @param payload - The x402 payment payload containing the BEEF transaction
   * @param requirements - The payment requirements from the resource server
   * @returns Verification result indicating validity and payer identity key
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await this.verifyInternal(payload, requirements, "verify");
    if (typeof result.error === "string") {
      return { isValid: false, invalidReason: result.error, payer: result.payer };
    }
    return { isValid: true, payer: result.payer };
  }

  /**
   * Settles the payment by internalizing the output into the recipient
   * wallet (BRC-29 `wallet payment`). The wallet SPV-validates the BEEF,
   * derives the payment key from the remittance data, takes custody, and
   * handles propagation to the BSV network.
   *
   * Freshness is re-checked with the window extended by the server's
   * advertised `maxTimeoutSeconds`, so slow resource handlers do not
   * invalidate payments that verified successfully.
   *
   * @param payload - The x402 payment payload containing the BEEF transaction
   * @param requirements - The payment requirements from the resource server
   * @returns Settlement result with the transaction id and network
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const network = requirements.network;

    const checked = await this.verifyInternal(payload, requirements, "settle");
    if (typeof checked.error === "string" || !checked.context) {
      return this.failure(network, checked.payer, checked.error ?? "verification_failed");
    }
    const { parsed, beefArr, txid } = checked.context;
    const payer = checked.payer;

    if (this.isRecentlySettled(txid)) {
      return this.failure(network, payer, "duplicate_settlement");
    }
    // Mark before internalizing so a concurrent duplicate /settle call is
    // rejected instead of racing the wallet; rolled back if nothing settles.
    this.markSettled(txid, requirements);

    let result: { accepted: boolean; isMerge?: boolean; satoshis?: number };
    try {
      result = (await this.wallet.internalizeAction({
        tx: beefArr,
        outputs: [
          {
            outputIndex: parsed.outputIndex,
            protocol: "wallet payment",
            paymentRemittance: {
              derivationPrefix: parsed.derivationPrefix,
              derivationSuffix: parsed.derivationSuffix,
              senderIdentityKey: parsed.senderIdentityKey,
            },
          },
        ],
        description: "x402 exact payment",
      })) as { accepted: boolean; isMerge?: boolean; satoshis?: number };
    } catch (err) {
      this.settledTxids.delete(txid);
      return this.failure(
        network,
        payer,
        `settlement_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // isMerge / satoshis are wallet-toolbox extensions. isMerge means the
    // wallet already knew the transaction — true for replays *and* for
    // self-payments, where createAction registers the tx before settle.
    // Newly internalized satoshis (> 0) distinguish first custody from a
    // no-op replay (satoshis === 0 or omitted).
    const newlyInternalized = typeof result.satoshis === "number" && result.satoshis > 0;
    if (result.isMerge && !newlyInternalized) {
      // Genuine replay: the wallet already held this tx and internalized
      // nothing new. Keep the dedup mark — it was legitimately settled before.
      return this.failure(network, payer, "duplicate_settlement");
    }

    if (!result.accepted) {
      // Soft rejection — nothing was internalized. Roll back the mark so a
      // later retry of the same BEEF is not falsely reported as a duplicate.
      this.settledTxids.delete(txid);
      return this.failure(network, payer, "settlement_rejected_by_wallet");
    }

    return { success: true, network, transaction: txid, payer };
  }

  /**
   * Runs the full verification rule set for either phase.
   *
   * @param payload - The x402 payment payload
   * @param requirements - The payment requirements
   * @param phase - "verify" uses the strict freshness window; "settle"
   *   extends it by `maxTimeoutSeconds` (the settlement budget)
   * @returns The payer plus either an error reason or the decoded context
   */
  private async verifyInternal(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: "verify" | "settle",
  ): Promise<{
    payer: string;
    error?: string;
    context?: { parsed: ExactBsvPayloadV2; beefArr: number[]; txid: string };
  }> {
    if (payload.accepted.scheme !== this.scheme || requirements.scheme !== this.scheme) {
      return { payer: "", error: "unsupported_scheme" };
    }

    if (payload.accepted.network !== requirements.network) {
      return { payer: "", error: "invalid_network" };
    }

    if (!isBsvNetwork(requirements.network)) {
      return { payer: "", error: "invalid_network" };
    }

    const asset = requirements.asset ?? BSV_ASSET_IDENTIFIER;
    if (asset !== "" && asset.toUpperCase() !== BSV_ASSET_IDENTIFIER) {
      return { payer: "", error: "invalid_exact_bsv_payload_asset" };
    }

    const parsed = this.parsePayload(payload.payload);
    if (typeof parsed === "string") {
      return { payer: "", error: parsed };
    }

    const payer = parsed.senderIdentityKey;

    if (!COMPRESSED_PUBKEY_REGEX.test(payer)) {
      return { payer: "", error: "invalid_exact_bsv_payload_sender_key" };
    }

    if ((requirements.payTo ?? "").toLowerCase() !== this.identityKey) {
      return { payer, error: "invalid_exact_bsv_payload_payee_mismatch" };
    }

    const networkError = await this.checkWalletNetwork(requirements.network);
    if (networkError !== null) {
      return { payer, error: networkError };
    }

    const timestampError = this.checkTimestamp(parsed.derivationSuffix, requirements, phase);
    if (timestampError !== null) {
      return { payer, error: timestampError };
    }

    if (!/^\d+$/.test(requirements.amount)) {
      return { payer, error: "invalid_payment_requirements" };
    }
    const required = BigInt(requirements.amount);
    if (required <= 0n || required > BigInt(MAX_SATOSHIS)) {
      return { payer, error: "invalid_payment_requirements" };
    }

    let beefArr: number[];
    let subject: Transaction;
    try {
      beefArr = Utils.toArray(parsed.transaction, "base64");
      const beef = Beef.fromBinary(beefArr);
      const found = this.findSubjectTransaction(beef);
      if (!found) {
        return { payer, error: "invalid_exact_bsv_payload_transaction" };
      }
      subject = found;
    } catch {
      return { payer, error: "invalid_exact_bsv_payload_transaction" };
    }
    const txid = subject.id("hex");

    const output = subject.outputs[parsed.outputIndex];
    if (!output || output.satoshis === undefined) {
      return { payer, error: "invalid_exact_bsv_payload_output_missing" };
    }

    // x402 `exact` semantics: the amount must match exactly (BRC-121 alone
    // would accept overpayment).
    if (BigInt(output.satoshis) !== required) {
      return { payer, error: "invalid_exact_bsv_payload_amount_mismatch" };
    }

    const scriptHex = output.lockingScript?.toHex() ?? "";
    const p2pkhMatch = /^76a914([0-9a-f]{40})88ac$/i.exec(scriptHex);
    if (!p2pkhMatch) {
      return { payer, error: "invalid_exact_bsv_payload_script" };
    }

    const destinationError = await this.checkDestination(parsed, p2pkhMatch[1]);
    if (destinationError !== null) {
      return { payer, error: destinationError };
    }

    // Optional SPV pre-check at verify time only (settle's internalizeAction
    // performs the authoritative SPV validation regardless).
    if (phase === "verify" && this.spvOnVerify) {
      let spvValid: boolean;
      try {
        spvValid = await this.spvOnVerify(beefArr, txid);
      } catch {
        return { payer, error: "invalid_exact_bsv_payload_spv" };
      }
      if (!spvValid) {
        return { payer, error: "invalid_exact_bsv_payload_spv" };
      }
    }

    return { payer, context: { parsed, beefArr, txid } };
  }

  /**
   * Resolves the subject (payment) transaction within a BEEF.
   *
   * Atomic BEEF (BRC-95) names its subject via `atomicTxid` — the same
   * transaction the recipient wallet will internalize. For plain BEEF the
   * last transaction is used, matching wallet subject-selection order.
   *
   * @param beef - Decoded BEEF structure
   * @returns The subject transaction, or undefined when absent
   */
  private findSubjectTransaction(beef: Beef): Transaction | undefined {
    if (beef.atomicTxid !== undefined) {
      return beef.findTxid(beef.atomicTxid)?.tx;
    }
    return beef.txs.at(-1)?.tx;
  }

  /**
   * Verifies the payment output pays the BRC-42-derived key for this
   * payment. The recipient wallet derives its own child public key
   * (`forSelf: true`) from the sender's identity key and the payload's
   * derivation parameters; its hash160 must match the P2PKH script.
   *
   * @param parsed - The shape-checked payload
   * @param scriptPkh - hash160 (hex) extracted from the P2PKH locking script
   * @returns An invalidReason string, or null if the destination is correct
   */
  private async checkDestination(
    parsed: ExactBsvPayloadV2,
    scriptPkh: string,
  ): Promise<string | null> {
    let derivedPubKey: string;
    try {
      const result = await this.wallet.getPublicKey({
        protocolID: BRC29_PROTOCOL_ID,
        keyID: `${parsed.derivationPrefix} ${parsed.derivationSuffix}`,
        counterparty: parsed.senderIdentityKey,
        forSelf: true,
      });
      derivedPubKey = result.publicKey;
    } catch {
      return "invalid_exact_bsv_payload_destination_derivation_failed";
    }

    let expectedPkh: string;
    try {
      expectedPkh = PublicKey.fromString(derivedPubKey).toHash("hex") as string;
    } catch {
      return "invalid_exact_bsv_payload_destination_derivation_failed";
    }

    if (expectedPkh.toLowerCase() !== scriptPkh.toLowerCase()) {
      return "invalid_exact_bsv_payload_destination_mismatch";
    }

    return null;
  }

  /**
   * Ensures the facilitator wallet operates on the requested network.
   *
   * @param network - CAIP-2 network identifier from the requirements
   * @returns An invalidReason string, or null when the chains agree
   */
  private async checkWalletNetwork(network: Network): Promise<string | null> {
    const expected = toBsvWalletNetwork(network);
    if (!expected) {
      return "invalid_network";
    }

    let walletNetwork: string;
    try {
      this.walletNetworkPromise ??= this.wallet
        .getNetwork({})
        .then((result: { network: string }) => result.network);
      walletNetwork = await this.walletNetworkPromise;
    } catch {
      this.walletNetworkPromise = undefined;
      return "unexpected_verify_error";
    }

    return walletNetwork === expected ? null : "invalid_network";
  }

  /**
   * Parses and shape-checks the scheme-specific payload.
   *
   * @param payload - The raw `PaymentPayload.payload` object
   * @returns A validated ExactBsvPayloadV2, or an invalidReason string
   */
  private parsePayload(payload: Record<string, unknown>): ExactBsvPayloadV2 | string {
    if (!payload || typeof payload !== "object") {
      return "invalid_exact_bsv_payload_format";
    }

    const { transaction, derivationPrefix, derivationSuffix, senderIdentityKey, outputIndex } =
      payload as Partial<ExactBsvPayloadV2>;

    if (
      typeof transaction !== "string" ||
      transaction.length === 0 ||
      typeof derivationPrefix !== "string" ||
      derivationPrefix.length === 0 ||
      typeof derivationSuffix !== "string" ||
      derivationSuffix.length === 0 ||
      typeof senderIdentityKey !== "string" ||
      typeof outputIndex !== "number" ||
      !Number.isInteger(outputIndex) ||
      outputIndex < 0
    ) {
      return "invalid_exact_bsv_payload_format";
    }

    // BRC-29 requires the derivation prefix to be a fresh random nonce; the
    // spec sets a minimum of 8 bytes. Decode and enforce the length so a
    // low-entropy prefix cannot weaken per-payment key uniqueness.
    let prefixBytes: number[];
    try {
      prefixBytes = Utils.toArray(derivationPrefix, "base64");
    } catch {
      return "invalid_exact_bsv_payload_derivation_prefix";
    }
    if (prefixBytes.length < MIN_DERIVATION_PREFIX_BYTES) {
      return "invalid_exact_bsv_payload_derivation_prefix";
    }

    return { transaction, derivationPrefix, derivationSuffix, senderIdentityKey, outputIndex };
  }

  /**
   * Enforces BRC-121 timestamp freshness from the derivation suffix.
   *
   * The suffix must base64-decode to a decimal Unix-ms timestamp. At verify
   * time it must be within `paymentWindowMs` of the clock (symmetric). At
   * settle time the past-facing window is extended by `maxTimeoutSeconds`,
   * the server's advertised settlement budget, so payments that verified in
   * time cannot expire while the resource handler runs.
   *
   * @param derivationSuffix - Base64-encoded timestamp string
   * @param requirements - Payment requirements carrying maxTimeoutSeconds
   * @param phase - Which freshness window applies
   * @returns An invalidReason string, or null if fresh
   */
  private checkTimestamp(
    derivationSuffix: string,
    requirements: PaymentRequirements,
    phase: "verify" | "settle",
  ): string | null {
    let decoded: string;
    try {
      decoded = Utils.toUTF8(Utils.toArray(derivationSuffix, "base64"));
    } catch {
      return "invalid_exact_bsv_payload_timestamp";
    }

    if (!/^\d+$/.test(decoded)) {
      return "invalid_exact_bsv_payload_timestamp";
    }

    const timestamp = Number(decoded);
    if (!Number.isFinite(timestamp)) {
      return "invalid_exact_bsv_payload_timestamp";
    }

    const settleBudgetMs =
      phase === "settle" &&
      Number.isFinite(requirements.maxTimeoutSeconds) &&
      requirements.maxTimeoutSeconds > 0
        ? requirements.maxTimeoutSeconds * 1000
        : 0;

    const age = Date.now() - timestamp;
    // Future-dated beyond the window is rejected in both phases.
    if (age < -this.paymentWindowMs) {
      return "invalid_exact_bsv_payload_timestamp_out_of_window";
    }
    if (age > this.paymentWindowMs + settleBudgetMs) {
      return "invalid_exact_bsv_payload_timestamp_out_of_window";
    }

    return null;
  }

  /**
   * Checks the duplicate-settlement cache.
   *
   * @param txid - Subject transaction id
   * @returns True when this txid was settled within the cache TTL
   */
  private isRecentlySettled(txid: string): boolean {
    const now = Date.now();
    for (const [key, expiry] of this.settledTxids) {
      if (expiry <= now) this.settledTxids.delete(key);
    }
    const expiry = this.settledTxids.get(txid);
    return expiry !== undefined && expiry > now;
  }

  /**
   * Records a txid in the duplicate-settlement cache.
   *
   * The TTL covers the full settlement freshness window
   * (`paymentWindowMs + maxTimeoutSeconds`) plus a margin — the period over
   * which a replay could still pass re-verification — with a fixed floor.
   * This prevents a replay from surviving cache expiry while still being
   * re-verifiable when `maxTimeoutSeconds` is large.
   *
   * @param txid - Subject transaction id
   * @param requirements - Payment requirements carrying maxTimeoutSeconds
   */
  private markSettled(txid: string, requirements: PaymentRequirements): void {
    const settleBudgetMs =
      Number.isFinite(requirements.maxTimeoutSeconds) && requirements.maxTimeoutSeconds > 0
        ? requirements.maxTimeoutSeconds * 1000
        : 0;
    const windowMs = this.paymentWindowMs + settleBudgetMs + SETTLEMENT_CACHE_TTL_MARGIN_MS;
    const ttl = Math.max(SETTLEMENT_CACHE_TTL_FLOOR_MS, windowMs);
    this.settledTxids.set(txid, Date.now() + ttl);
  }

  /**
   * Builds a failed SettleResponse. Per the core v2 schema the
   * `transaction` field is always an empty string on failure.
   *
   * @param network - The blockchain network
   * @param payer - The payer identity key
   * @param errorReason - The reason for failure
   * @returns A failed SettleResponse
   */
  private failure(network: Network, payer: string, errorReason: string): SettleResponse {
    return { success: false, network, transaction: "", payer, errorReason };
  }
}
