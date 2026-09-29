import {
  AccountAddress,
  Cbor,
  CborAccountAddress,
  CcdAmount,
  TokenAmount,
  Transaction,
} from "@concordium/web-sdk";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorConcordiumSigner } from "../../signer";
import {
  ExactConcordiumPayloadV2,
  SignableV1Transaction,
  SignableV1TransactionPayload,
  SimpleTransferPayload,
  SimpleTransferWithMemoPayload,
  TokenUpdatePayload,
} from "../../types";
import { MAX_EXPIRY_OFFSET_SECONDS, DEFAULT_FINALIZATION_TIMEOUT_MS } from "../../constants";

export interface ExactConcordiumSchemeConfig {
  /**
   * Facilitator signer — handles sponsor signing, submission, and finalization.
   * Create with `toConcordiumFacilitatorSigner(sponsorAccount, sponsorSigner, grpcClient)`.
   */
  signer: FacilitatorConcordiumSigner | FacilitatorConcordiumSigner[];

  /**
   * Whether settlement requires `finalized` status.
   * Set to false to accept `committed` (faster, less safe).
   *
   * @default true
   */
  requireFinalization?: boolean;

  /**
   * Finalization wait timeout in ms.
   *
   * @default 60000
   */
  finalizationTimeoutMs?: number;

  /**
   * Maximum seconds from now an expiry is allowed to be (Rule 7).
   *
   * @default 600
   */
  maxExpiryOffsetSeconds?: number;
}

/**
 * Concordium facilitator implementation for the `exact` payment scheme.
 */
export class ExactConcordiumScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "ccd:*";

  private readonly signers: readonly FacilitatorConcordiumSigner[];
  private readonly requireFinalization: boolean;
  private readonly finalizationTimeoutMs: number;
  private readonly maxExpiryOffsetSeconds: number;

  /**
   * Creates a new ExactConcordiumScheme facilitator instance.
   *
   * @param config - Facilitator scheme configuration
   */
  constructor(config: ExactConcordiumSchemeConfig) {
    this.signers = normalizeSigners(config.signer);
    this.requireFinalization = config.requireFinalization ?? true;
    this.finalizationTimeoutMs = config.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_TIMEOUT_MS;
    this.maxExpiryOffsetSeconds = config.maxExpiryOffsetSeconds ?? MAX_EXPIRY_OFFSET_SECONDS;
  }

  /**
   * Returns extra metadata for the /supported endpoint.
   *
   * @param _ - Network identifier (unused, same config for all networks)
   * @returns Randomly selected fee payer metadata
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    const feePayer = this.selectFeePayer(_);
    if (!feePayer) {
      return undefined;
    }

    return {
      feePayer,
    };
  }

  /**
   * Returns signer addresses for the /supported endpoint.
   *
   * @param _ - Network identifier (unused, same signer for all networks)
   * @returns Array of sponsor account addresses
   */
  getSigners(_: string): string[] {
    return [...getSignerAddresses(this.signersFor(_ as Network))];
  }

  /**
   * Validates the partially-signed transaction against all 9 MUST rules.
   *
   * @param payload - The x402 payment payload containing the signed transaction
   * @param requirements - The payment requirements from the resource server
   * @returns Verification result indicating validity and payer address
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    if (payload.accepted.scheme !== this.scheme || requirements.scheme !== this.scheme) {
      return this.invalid("unsupported_scheme", "");
    }

    if (payload.accepted.network !== requirements.network) {
      return this.invalid("network_mismatch", "");
    }

    const concordiumPayload = payload.payload as unknown as ExactConcordiumPayloadV2;
    const payer = "";

    if (!concordiumPayload || typeof concordiumPayload !== "object") {
      return this.invalid("missing_payload", payer);
    }

    let tx: SignableV1Transaction;
    try {
      tx = this.parseTransaction(concordiumPayload);
    } catch (err) {
      return this.invalid(
        `invalid_transaction_format: ${err instanceof Error ? err.message : String(err)}`,
        payer,
      );
    }

    const resolvedPayer = tx.header.sender ?? "";

    if (tx.version !== 1) {
      return this.invalid(
        `invalid_transaction_version: expected 1, got ${tx.version}`,
        resolvedPayer,
      );
    }

    if (!resolvedPayer) {
      return this.invalid("missing_sender", resolvedPayer);
    }

    if (!isValidBase58Address(resolvedPayer)) {
      return this.invalid("invalid_sender_address", resolvedPayer);
    }

    const feePayer = requirements.extra?.feePayer;
    if (typeof feePayer !== "string" || !feePayer) {
      return this.invalid("missing_fee_payer", resolvedPayer);
    }
    const sponsorSigner = this.resolveSigner(feePayer, requirements.network);
    if (!sponsorSigner) {
      return this.invalid("fee_payer_not_managed_by_facilitator", resolvedPayer);
    }

    const sponsorAddressInHeader = tx.header.sponsor?.address ?? tx.header.sponsor?.account;
    if (!sponsorAddressInHeader) {
      return this.invalid("missing_sponsor_in_header", resolvedPayer);
    }

    if (sponsorAddressInHeader !== feePayer) {
      return this.invalid("sponsor_mismatch", resolvedPayer);
    }

    // Checked early to fast-reject stale / far-future transactions
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (typeof tx.header.expiry !== "number" || !Number.isFinite(tx.header.expiry)) {
      return this.invalid("invalid_expiry_field", resolvedPayer);
    }

    if (tx.header.expiry <= nowSeconds) {
      return this.invalid("transaction_expired", resolvedPayer);
    }

    const maxExpiryOffsetSeconds = Math.min(
      this.maxExpiryOffsetSeconds,
      Math.max(0, requirements.maxTimeoutSeconds ?? this.maxExpiryOffsetSeconds),
    );

    if (tx.header.expiry > nowSeconds + maxExpiryOffsetSeconds) {
      return this.invalid(
        `expiry_too_far_in_future: max offset is ${maxExpiryOffsetSeconds}s`,
        resolvedPayer,
      );
    }

    let decodedPayload: DecodedPayload;
    try {
      const decoded = this.decodePayload(tx.payload);
      if (typeof decoded === "string") {
        return this.invalid(decoded, resolvedPayer);
      }
      decodedPayload = decoded;
    } catch (err) {
      return this.invalid(err instanceof Error ? err.message : String(err), resolvedPayer);
    }
    const safetyError = this.checkPayloadSafety(tx, decodedPayload);
    if (safetyError !== null) return this.invalid(safetyError, resolvedPayer);

    const expectedAsset = (requirements.asset ?? "CCD").toUpperCase();
    const assetError = this.checkAssetType(tx.payload, expectedAsset);
    if (assetError !== null) return this.invalid(assetError, resolvedPayer);

    const recipientError = this.checkRecipient(
      tx.payload,
      requirements.payTo,
      expectedAsset,
      decodedPayload,
    );
    if (recipientError !== null) return this.invalid(recipientError, resolvedPayer);

    const amountError = await this.checkAmount(
      tx.payload,
      requirements,
      expectedAsset,
      decodedPayload,
      sponsorSigner,
    );
    if (amountError !== null) return this.invalid(amountError, resolvedPayer);

    if (!hasSenderSignature(tx)) {
      return this.invalid("missing_sender_signature", resolvedPayer);
    }

    try {
      const signable = Transaction.signableFromJSON(tx);

      if (signable.version !== 1) {
        return this.invalid("unexpected_transaction_version_after_parse", resolvedPayer);
      }

      const accountInfo = await sponsorSigner.getAccountInfo(resolvedPayer);

      const signatureValid = await Transaction.verifySignature(
        signable,
        signable.signatures.sender,
        accountInfo,
      );

      if (!signatureValid) {
        return this.invalid("invalid_sender_signature", resolvedPayer);
      }

      // Preflight/simulation: ensure the transaction is likely to succeed on-chain.
      // At minimum we validate nonce/sequence and sufficient sender balance for CCD transfers.
      const preflightError = await this.preflightLikelyToSucceed(
        tx,
        requirements,
        expectedAsset,
        accountInfo,
        sponsorSigner,
        decodedPayload,
      );
      if (preflightError !== null) {
        return this.invalid(preflightError, resolvedPayer);
      }
    } catch (err) {
      return this.invalid(
        `signature_verification_failed: ${err instanceof Error ? err.message : String(err)}`,
        resolvedPayer,
      );
    }

    return { isValid: true, payer: resolvedPayer };
  }

  /**
   * Sponsors and submits the transaction, then waits for finalization.
   *
   * @param payload - The x402 payment payload containing the signed transaction
   * @param requirements - The payment requirements from the resource server
   * @returns Settlement result with transaction hash and network
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const concordiumPayload = payload.payload as unknown as ExactConcordiumPayloadV2;
    const network = payload.accepted.network as Network;
    const payer = "";

    const valid = await this.verify(payload, requirements);
    if (!valid.isValid) {
      return {
        success: false,
        network,
        transaction: "",
        errorReason: valid.invalidReason ?? "verification_failed",
        payer: valid.payer || payer,
      };
    }
    const verifiedPayer = valid.payer ?? "";
    if (!verifiedPayer) {
      return this.failure(network, "", payer, "missing_payer");
    }

    let tx: SignableV1Transaction;
    try {
      tx = this.parseTransaction(concordiumPayload);
    } catch {
      return this.failure(network, "", verifiedPayer, "invalid_transaction_format");
    }

    const feePayer = requirements.extra?.feePayer;
    if (typeof feePayer !== "string" || !feePayer) {
      return this.failure(network, "", verifiedPayer, "missing_fee_payer");
    }
    const sponsorSigner = this.resolveSigner(feePayer, requirements.network);
    if (!sponsorSigner) {
      return this.failure(network, "", verifiedPayer, "fee_payer_not_managed_by_facilitator");
    }

    let signedTxJSON: Awaited<ReturnType<FacilitatorConcordiumSigner["addSponsorSignature"]>>;
    try {
      signedTxJSON = await sponsorSigner.addSponsorSignature(tx);
    } catch (err) {
      return this.failure(
        network,
        "",
        verifiedPayer,
        `sponsor_signing_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let txHash: string;
    try {
      txHash = await sponsorSigner.submitTransaction(signedTxJSON);
    } catch (err) {
      return this.failure(
        network,
        "",
        verifiedPayer,
        `submission_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let txInfo;
    try {
      txInfo = await sponsorSigner.waitForFinalization(txHash, this.finalizationTimeoutMs);
    } catch (err) {
      // waitForFinalization throws on on-chain failure or timeout
      return this.failure(
        network,
        txHash,
        verifiedPayer,
        `finalization_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (this.requireFinalization && txInfo.status !== "finalized") {
      return this.failure(network, txHash, verifiedPayer, "finalization_timeout");
    }

    if (txInfo.sender && txInfo.sender !== verifiedPayer) {
      return this.failure(network, txHash, verifiedPayer, "on_chain_sender_mismatch");
    }

    if (!txInfo.recipient || txInfo.recipient !== requirements.payTo) {
      return this.failure(network, txHash, verifiedPayer, "on_chain_recipient_mismatch");
    }

    return { success: true, network, transaction: txHash, payer: verifiedPayer };
  }

  /**
   * Parses and validates the raw transaction from the payload.
   *
   * @param concordiumPayload - The Concordium-specific payment payload
   * @returns A validated SignableV1Transaction
   */
  private parseTransaction(concordiumPayload: ExactConcordiumPayloadV2): SignableV1Transaction {
    if (!concordiumPayload.signedTransaction) {
      throw new Error("missing_signed_transaction");
    }

    const tx = concordiumPayload.signedTransaction;

    if (typeof tx !== "object" || tx === null) {
      throw new Error("signed_transaction_must_be_object");
    }
    if (typeof tx.version !== "number") {
      throw new Error("missing_or_invalid_version_field");
    }
    if (!tx.header || typeof tx.header !== "object") {
      throw new Error("missing_header");
    }
    if (typeof tx.header.sender !== "string") {
      throw new Error("missing_header_sender");
    }
    if (typeof tx.header.expiry !== "number") {
      throw new Error("missing_header_expiry");
    }
    if (!tx.header.sponsor || typeof tx.header.sponsor !== "object") {
      throw new Error("missing_header_sponsor");
    }
    if (!tx.payload || typeof tx.payload !== "object") {
      throw new Error("missing_payload_field");
    }
    if (!tx.signatures || typeof tx.signatures !== "object") {
      throw new Error("missing_signatures");
    }

    return tx as SignableV1Transaction;
  }

  /**
   * Rule 9 — checks transaction payload safety constraints.
   *
   * @param tx - The V1 sponsored transaction to check
   * @param _ - Decoded payload (reserved, currently unused in safety checks)
   * @returns An invalidReason string, or null if safe
   */
  private checkPayloadSafety(tx: SignableV1Transaction, _: DecodedPayload): string | null {
    const sponsorAddresses = getSignerAddresses(this.signers);

    if (sponsorAddresses.includes(tx.header.sender)) {
      return "sponsor_as_sender";
    }

    // Note: sponsor_as_recipient is intentionally NOT checked.
    // In standard x402 deployments the service provider runs both the
    // facilitator (sponsoring gas) and the server (receiving payment),
    // so the sponsor being the recipient is a legitimate flow.

    return null;
  }

  /**
   * Rule 6 — validates asset type matches requirements.
   *
   * @param payload - The transaction payload to check
   * @param expectedAsset - Expected asset identifier (empty for CCD)
   * @returns An invalidReason string, or null if valid
   */
  private checkAssetType(
    payload: SignableV1TransactionPayload,
    expectedAsset: string,
  ): string | null {
    const isCcd = expectedAsset.toUpperCase() === "CCD";

    if (isCcd) {
      if (payload.type !== "transfer" && payload.type !== "transferWithMemo") {
        return `asset_type_mismatch: expected SimpleTransfer for CCD, got ${payload.type}`;
      }
      return null;
    }

    if (payload.type !== "tokenUpdate") {
      return `asset_type_mismatch: expected TokenUpdate for ${expectedAsset}, got ${payload.type}`;
    }

    const tokenPayload = payload as TokenUpdatePayload;
    if (!tokenPayload.tokenId) return "missing_token_id";

    if (tokenPayload.tokenId.toUpperCase() !== expectedAsset.toUpperCase()) {
      return `token_id_mismatch: expected ${expectedAsset}, got ${tokenPayload.tokenId}`;
    }

    return null;
  }

  /**
   * Rule 4 — validates transfer recipient matches payTo.
   *
   * @param payload - The transaction payload to check
   * @param payTo - Expected recipient address
   * @param expectedAsset - Expected asset identifier (empty for CCD)
   * @param decodedPayload - Decoded transfer details extracted from the payload
   * @returns An invalidReason string, or null if valid
   */
  private checkRecipient(
    payload: SignableV1TransactionPayload,
    payTo: string,
    expectedAsset: string,
    decodedPayload: DecodedPayload,
  ): string | null {
    if (expectedAsset.toUpperCase() === "CCD") {
      const ccdPayload = payload as SimpleTransferPayload | SimpleTransferWithMemoPayload;
      if (!ccdPayload.toAddress) return "missing_recipient";
      if (ccdPayload.toAddress !== payTo) return "recipient_mismatch";
      return null;
    }

    if (decodedPayload.recipient === null) return "missing_recipient";
    if (decodedPayload.recipient !== payTo) return "recipient_mismatch";

    return null;
  }

  /**
   * Rule 5 — validates transfer amount matches requirements (strict equality).
   *
   * @param payload - The transaction payload to check
   * @param requirements - The payment requirements with the expected amount
   * @param expectedAsset - Expected asset identifier (empty for CCD)
   * @param decodedPayload - Decoded transfer details extracted from the payload
   * @param signer - Facilitator signer used for token metadata lookups
   * @returns An invalidReason string, or null if valid
   */
  private async checkAmount(
    payload: SignableV1TransactionPayload,
    requirements: PaymentRequirements,
    expectedAsset: string,
    decodedPayload: DecodedPayload,
    signer: FacilitatorConcordiumSigner,
  ): Promise<string | null> {
    const requiredAmount = getRequiredAmount(requirements);
    if (!/^\d+$/.test(requiredAmount)) return "invalid_required_amount";
    const required = BigInt(requiredAmount);

    if (expectedAsset.toUpperCase() !== "CCD") {
      if (decodedPayload.amount === null) return "invalid_amount_format";
      if (decodedPayload.tokenDecimals === null || decodedPayload.tokenId === null) {
        return "invalid_token_amount";
      }

      let expectedDecimals: number;
      try {
        expectedDecimals = await signer.getTokenDecimals(decodedPayload.tokenId);
      } catch {
        return "token_decimals_lookup_failed";
      }

      if (decodedPayload.tokenDecimals !== expectedDecimals) {
        return "invalid_token_amount_decimals";
      }

      return decodedPayload.amount === required
        ? null
        : `amount_mismatch: required ${required}, got ${decodedPayload.amount}`;
    }

    let actual: bigint;
    try {
      actual = BigInt((payload as SimpleTransferPayload).amount ?? "0");
    } catch {
      return "invalid_amount_format";
    }

    if (actual !== required) {
      return `amount_mismatch: required ${required}, got ${actual}`;
    }

    return null;
  }

  /**
   * Ensures the transaction is likely to succeed on-chain.
   *
   * This is a lightweight preflight check used as a stand-in for full simulation:
   * - Nonce/sequence validity for the sender account
   * - Sufficient sender balance for native CCD transfers
   *
   * @param tx - Parsed V1 sponsored transaction (client-signed)
   * @param requirements - Payment requirements to validate against
   * @param expectedAsset - Expected asset identifier (e.g. "CCD" or a PLT symbol)
   * @param accountInfo - On-chain account info (SDK shape) for sender
   * @param sponsorSigner - Facilitator signer selected by the fee payer
   * @param decodedPayload - Decoded transfer details extracted from the payload
   * @returns An invalidReason string, or null if likely to succeed
   */
  private async preflightLikelyToSucceed(
    tx: SignableV1Transaction,
    requirements: PaymentRequirements,
    expectedAsset: string,
    accountInfo: unknown,
    sponsorSigner: FacilitatorConcordiumSigner,
    decodedPayload: DecodedPayload,
  ): Promise<string | null> {
    const onChainNonceRaw =
      (accountInfo as { accountNonce?: unknown } | null | undefined)?.accountNonce ??
      (accountInfo as { nonce?: unknown } | null | undefined)?.nonce;

    if (onChainNonceRaw === undefined || onChainNonceRaw === null) {
      return "preflight_missing_account_nonce";
    }

    let onChainNonce: bigint;
    try {
      onChainNonce = BigInt(onChainNonceRaw as number | string | bigint);
    } catch {
      return "preflight_invalid_account_nonce";
    }

    if (BigInt(tx.header.nonce) !== onChainNonce) {
      return "preflight_nonce_mismatch";
    }

    if (expectedAsset.toUpperCase() !== "CCD") {
      if (decodedPayload.amount === null || decodedPayload.tokenId === null) {
        return "preflight_invalid_token_amount";
      }

      return this.preflightTokenBalance(
        sponsorSigner,
        tx.header.sender,
        decodedPayload.tokenId,
        decodedPayload.amount,
      );
    }

    const amountRequired = BigInt(getRequiredAmount(requirements));

    const amountRaw =
      (accountInfo as { accountAmount?: unknown } | null | undefined)?.accountAmount ??
      (accountInfo as { amount?: unknown } | null | undefined)?.amount;

    if (amountRaw === undefined || amountRaw === null) {
      return "preflight_missing_account_amount";
    }

    let availableMicroCcd: bigint;
    try {
      // AccountAmount in the Concordium SDK is typically a CcdAmount.Type.
      // We treat it as an opaque value and attempt to use CcdAmount.toMicroCcd first.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const micro = CcdAmount.toMicroCcd(amountRaw as any) as unknown;
      availableMicroCcd =
        typeof micro === "bigint"
          ? micro
          : BigInt(typeof micro === "string" ? micro : String(micro));
    } catch {
      try {
        availableMicroCcd = BigInt(amountRaw as number | string | bigint);
      } catch {
        return "preflight_invalid_account_amount";
      }
    }

    if (availableMicroCcd < amountRequired) {
      return "preflight_insufficient_funds";
    }

    return null;
  }

  /**
   * Checks that the payer has enough balance for the requested PLT transfer.
   *
   * @param sponsorSigner - Facilitator signer used for chain queries
   * @param payer - Sender account address
   * @param tokenId - PLT token identifier
   * @param requiredAmount - Required token amount in smallest units
   * @returns An invalidReason string, or null if the balance is sufficient
   */
  private async preflightTokenBalance(
    sponsorSigner: FacilitatorConcordiumSigner,
    payer: string,
    tokenId: string,
    requiredAmount: bigint,
  ): Promise<string | null> {
    let balance: bigint | undefined;
    try {
      balance = await sponsorSigner.getTokenBalance(payer, tokenId);
    } catch {
      return "preflight_token_balance_lookup_failed";
    }

    if (balance === undefined) {
      return "preflight_missing_token_balance";
    }

    if (balance < requiredAmount) {
      return "preflight_insufficient_token_funds";
    }

    return null;
  }

  /**
   * Selects a fee payer address from the configured facilitator signers.
   *
   * @param network - CAIP-2 network identifier
   * @returns Selected fee payer address, or undefined when no signers exist
   */
  private selectFeePayer(network: Network): string | undefined {
    const addresses = getSignerAddresses(this.signersFor(network));
    if (addresses.length === 0) {
      return undefined;
    }

    const randomIndex = Math.floor(Math.random() * addresses.length);
    return addresses[randomIndex];
  }

  /**
   * Resolves the facilitator signer responsible for a fee payer address.
   *
   * @param address - Fee payer address
   * @param network - CAIP-2 network identifier
   * @returns Matching facilitator signer, or undefined if unmanaged
   */
  private resolveSigner(
    address: string,
    network: Network,
  ): FacilitatorConcordiumSigner | undefined {
    return this.signersFor(network).find(signer => signer.getAddress() === address);
  }

  /**
   * Returns signers connected to the requested network.
   *
   * @param network - CAIP-2 network identifier
   * @returns Signers for that network, or wildcard signers
   */
  private signersFor(network: Network): readonly FacilitatorConcordiumSigner[] {
    return this.signers.filter(signer => {
      const signerNetwork = signer.getNetwork();
      return signerNetwork === network || signerNetwork === "ccd:*";
    });
  }

  /**
   * Decodes transaction payload details needed for facilitator-side validation.
   *
   * @param payload - The raw transaction payload
   * @returns Decoded payload details, or an invalidReason string on failure
   */
  private decodePayload(payload: SignableV1TransactionPayload): DecodedPayload | string {
    switch (payload.type) {
      case "transfer":
      case "transferWithMemo":
        if (!payload.toAddress) return "missing_recipient";
        return {
          recipient: payload.toAddress,
          amount: parseBigIntValue(payload.amount, "invalid_amount_format"),
          tokenId: null,
          tokenDecimals: null,
        };
      case "tokenUpdate":
        return decodeTokenUpdatePayload(payload);
      default:
        return `unexpected_transaction_type: ${(payload as { type?: unknown }).type}`;
    }
  }

  /**
   * Builds an invalid VerifyResponse.
   *
   * @param reason - The reason for invalidity
   * @param payer - The payer address
   * @returns An invalid VerifyResponse
   */
  private invalid(reason: string, payer: string): VerifyResponse {
    return { isValid: false, invalidReason: reason, payer };
  }

  /**
   * Builds a failed SettleResponse.
   *
   * @param network - The blockchain network
   * @param transaction - The transaction hash (empty if not yet submitted)
   * @param payer - The payer address
   * @param errorReason - The reason for failure
   * @returns A failed SettleResponse
   */
  private failure(
    network: Network,
    transaction: string,
    payer: string,
    errorReason: string,
  ): SettleResponse {
    return { success: false, network, transaction, payer, errorReason };
  }
}

/**
 * Checks whether the sender has at least one credential signature.
 *
 * @param tx - The V1 sponsored transaction to check
 * @returns True if at least one sender signature is present
 */
function hasSenderSignature(tx: SignableV1Transaction): boolean {
  const sender = tx.signatures?.sender;
  if (!sender || typeof sender !== "object") return false;

  return Object.values(sender).some(
    keyMap =>
      typeof keyMap === "object" &&
      keyMap !== null &&
      Object.values(keyMap).some(sig => typeof sig === "string" && sig.length > 0),
  );
}

/**
 * Resolves the required amount from payment requirements.
 *
 * @param requirements - The payment requirements
 * @returns The required amount as a string
 */
function getRequiredAmount(requirements: PaymentRequirements): string {
  return requirements.amount;
}

/**
 * Structural guard for Concordium base58check account addresses.
 * For strict validation use `AccountAddress.fromBase58(address)` from the SDK.
 *
 * @param address - The address string to validate
 * @returns True if the address matches base58check format
 */
function isValidBase58Address(address: string): boolean {
  try {
    AccountAddress.fromBase58(address);
    return true;
  } catch {
    return false;
  }
}

type DecodedPayload = {
  recipient: string | null;
  amount: bigint | null;
  tokenId: string | null;
  tokenDecimals: number | null;
};

/**
 * Normalizes the facilitator signer config into a non-empty array.
 *
 * @param signer - One or more facilitator signers
 * @returns Normalized facilitator signer array
 */
function normalizeSigners(
  signer: FacilitatorConcordiumSigner | FacilitatorConcordiumSigner[],
): readonly FacilitatorConcordiumSigner[] {
  const signers = Array.isArray(signer) ? signer : [signer];
  if (signers.length === 0) {
    throw new Error("At least one facilitator signer is required");
  }
  return signers;
}

/**
 * Returns the distinct sponsor addresses managed by the facilitator.
 *
 * @param signers - Facilitator signers
 * @returns Unique signer addresses
 */
function getSignerAddresses(signers: readonly FacilitatorConcordiumSigner[]): string[] {
  return Array.from(new Set(signers.map(signer => signer.getAddress())));
}

/**
 * Parses an integer-like value into bigint.
 *
 * @param value - Value to parse
 * @param invalidReason - Error reason to use when parsing fails
 * @returns Parsed bigint value
 */
function parseBigIntValue(value: unknown, invalidReason: string): bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(invalidReason);
  }

  try {
    return BigInt(value);
  } catch {
    throw new Error(invalidReason);
  }
}

/**
 * Decodes and validates a Concordium PLT token-update payload.
 *
 * @param payload - Token update payload from the client transaction
 * @returns Decoded payload details, or an invalidReason string on failure
 */
function decodeTokenUpdatePayload(payload: TokenUpdatePayload): DecodedPayload | string {
  if (!payload.tokenId) return "missing_token_id";
  if (!payload.operations) return "missing_token_operations";

  let operations: unknown;
  try {
    operations = Cbor.decode(Cbor.fromJSON(payload.operations), "TokenOperation[]");
  } catch {
    return "invalid_token_operations";
  }

  if (!Array.isArray(operations) || operations.length !== 1) {
    return "unexpected_token_operations_count";
  }

  const [operation] = operations;
  if (!operation || typeof operation !== "object" || !("transfer" in operation)) {
    return "unexpected_token_operation";
  }

  const transfer = (operation as { transfer?: unknown }).transfer;
  if (!transfer || typeof transfer !== "object") {
    return "invalid_token_transfer";
  }

  const recipient = (transfer as { recipient?: unknown }).recipient;
  if (!CborAccountAddress.instanceOf(recipient)) {
    return "invalid_token_recipient";
  }

  const amount = (transfer as { amount?: unknown }).amount;
  if (!TokenAmount.instanceOf(amount)) {
    return "invalid_token_amount";
  }

  return {
    recipient: recipient.address.toString(),
    amount: amount.value,
    tokenId: payload.tokenId,
    tokenDecimals: amount.decimals,
  };
}
