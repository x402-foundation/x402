import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import casperSdk from "casper-js-sdk";
import { CASPER_CAIP2_FAMILY, DEFAULT_PAYMENT_MOTES, SCHEME_EXACT } from "../../constants";
import type { ExactCasperPayload, FacilitatorCasperSigner } from "../../types";
import {
  buildTransferWithAuthorizationDigest,
  hexToBytes,
  isCanonicalSecp256k1Signature,
  isValidCasperAddress,
  isValidContractPackageHash,
} from "../../utils";

export const ErrInvalidScheme = "invalid_exact_casper_facilitator_invalid_scheme";
export const ErrNetworkMismatch = "invalid_exact_casper_facilitator_network_mismatch";
export const ErrInvalidAsset = "invalid_exact_casper_facilitator_invalid_asset";
export const ErrInvalidPayTo = "invalid_exact_casper_facilitator_invalid_payto";
export const ErrInvalidPayer = "invalid_exact_casper_facilitator_invalid_payer";
export const ErrAmountMismatch = "invalid_exact_casper_facilitator_amount_mismatch";
export const ErrPayToMismatch = "invalid_exact_casper_facilitator_payto_mismatch";
export const ErrExpired = "invalid_exact_casper_facilitator_expired";
export const ErrNotYetValid = "invalid_exact_casper_facilitator_not_yet_valid";
export const ErrInvalidSignature = "invalid_exact_casper_facilitator_invalid_signature";
export const ErrNonCanonicalSignature = "invalid_exact_casper_facilitator_non_canonical_signature";
export const ErrPublicKeyMismatch = "invalid_exact_casper_facilitator_publickey_mismatch";
export const ErrSettleFailed = "invalid_exact_casper_facilitator_settle_failed";
export const ErrMissingTokenName = "invalid_exact_casper_facilitator_missing_token_name";
export const ErrMissingTokenVersion = "invalid_exact_casper_facilitator_missing_token_version";
export const ErrFailedToHash = "invalid_exact_casper_facilitator_failed_to_hash";
export const ErrInsufficientBalance = "invalid_exact_casper_facilitator_insufficient_balance";
export const ErrAuthorizationUsed = "invalid_exact_casper_facilitator_authorization_used";
export const ErrUnsupportedAsset = "invalid_exact_casper_facilitator_unsupported_asset";
export const ErrSpeculativeExecutionFailed =
  "invalid_exact_casper_facilitator_speculative_execution_failed";

/**
 * Facilitator configuration for exact Casper.
 */
export type ExactCasperSchemeConfig = {
  limitedPaymentMotes?: number;
};

/**
 * Invalid verify response helper.
 *
 * @param invalidReason - Invalid reason.
 * @param payer - Optional payer.
 * @param invalidMessage - Optional message.
 * @returns Verify response.
 */
function invalid(invalidReason: string, payer?: string, invalidMessage?: string): VerifyResponse {
  return { isValid: false, invalidReason, invalidMessage, payer };
}

/**
 * Casper facilitator implementation for the exact payment scheme.
 */
export class ExactCasperScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_EXACT;
  readonly caipFamily = CASPER_CAIP2_FAMILY;

  /**
   * Create an exact Casper facilitator scheme.
   *
   * @param signer - Facilitator signer.
   * @param config - Optional config.
   */
  constructor(
    private readonly signer: FacilitatorCasperSigner,
    private readonly config: ExactCasperSchemeConfig = {},
  ) {}

  /**
   * Get supported endpoint extra data.
   *
   * @param _network - Network identifier.
   * @returns Extra data.
   */
  getExtra(_network: Network): Record<string, unknown> {
    return {};
  }

  /**
   * Get signer addresses.
   *
   * @param network - Network identifier.
   * @returns Signer addresses.
   */
  getSigners(network: string): string[] {
    return this.signer.getAddresses(network as Network);
  }

  /**
   * Verify an exact Casper payment payload.
   *
   * @param payload - Payment payload.
   * @param requirements - Payment requirements.
   * @param _context - Facilitator context.
   * @returns Verify response.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    if (payload.accepted.scheme !== SCHEME_EXACT || requirements.scheme !== SCHEME_EXACT) {
      return invalid(ErrInvalidScheme);
    }
    if (payload.accepted.network !== requirements.network) {
      return invalid(
        ErrNetworkMismatch,
        undefined,
        `payload=${payload.accepted.network} requirements=${requirements.network}`,
      );
    }

    const exactPayload = this.extractPayload(payload);
    if (!exactPayload) {
      return invalid(ErrInvalidScheme, undefined, "malformed payload");
    }
    const payer = exactPayload.authorization.from;

    const authorizationValidation = this.validateAuthorization(exactPayload, requirements);
    if (authorizationValidation) {
      return authorizationValidation;
    }

    const signatureValidation = await this.validateSignature(exactPayload, requirements);
    if (signatureValidation) {
      return signatureValidation;
    }

    const preflightValidation = await this.validatePreflight(exactPayload, requirements);
    if (preflightValidation) {
      return preflightValidation;
    }

    const simulationValidation = await this.validateSpeculativeExecution(
      exactPayload,
      requirements,
    );
    if (simulationValidation) {
      return simulationValidation;
    }

    return { isValid: true, payer };
  }

  /**
   * Settle an exact Casper payment.
   *
   * @param payload - Payment payload.
   * @param requirements - Payment requirements.
   * @param context - Facilitator context.
   * @returns Settlement response.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const verifyResp = await this.verify(payload, requirements, context);
    if (!verifyResp.isValid) {
      return {
        success: false,
        errorReason: verifyResp.invalidReason,
        errorMessage: verifyResp.invalidMessage,
        payer: verifyResp.payer,
        transaction: "",
        network: requirements.network,
      };
    }

    try {
      const exactPayload = payload.payload as unknown as ExactCasperPayload;
      const transaction = await this.buildTransferWithAuthorizationTransaction(
        exactPayload,
        requirements,
      );

      await this.signer.signTransaction(transaction, requirements.network);
      const transactionHash = await this.signer.putTransaction(requirements.network, transaction);
      await this.signer.waitForTransaction(requirements.network, transactionHash);

      return {
        success: true,
        transaction: transactionHash,
        network: requirements.network,
        payer: verifyResp.payer,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errorReason: ErrSettleFailed,
        errorMessage: message,
        payer: verifyResp.payer,
        transaction: "",
        network: requirements.network,
      };
    }
  }

  /**
   * Build a transfer_with_authorization transaction.
   *
   * @param payload - Exact Casper payload.
   * @param requirements - Payment requirements.
   * @param mode - Transaction build mode.
   * @returns Casper transaction.
   */
  private async buildTransferWithAuthorizationTransaction(
    payload: ExactCasperPayload,
    requirements: PaymentRequirements,
    mode: "transaction-v1" | "deploy" = "transaction-v1",
  ): Promise<casperSdk.Transaction> {
    const facilitatorPublicKey = casperSdk.PublicKey.fromHex(
      this.signer.getPublicKeyHex(requirements.network),
    );
    const networkConfig = await this.signer.getNetworkConfig(requirements.network);
    const builder = new casperSdk.ContractCallBuilder()
      .from(facilitatorPublicKey)
      .byPackageHash(requirements.asset)
      .entryPoint("transfer_with_authorization")
      .runtimeArgs(buildTransferWithAuthorizationArgs(payload))
      .chainName(networkConfig.chainName)
      .payment(this.config.limitedPaymentMotes ?? DEFAULT_PAYMENT_MOTES);

    return mode === "deploy" ? builder.buildFor1_5() : builder.build();
  }

  /**
   * Extract and validate basic payload shape.
   *
   * @param payload - Payment payload.
   * @returns Exact payload or undefined.
   */
  private extractPayload(payload: PaymentPayload): ExactCasperPayload | undefined {
    const maybePayload = payload.payload as Partial<ExactCasperPayload> | undefined;
    const authorization = maybePayload?.authorization;
    if (
      !maybePayload ||
      typeof maybePayload.signature !== "string" ||
      typeof maybePayload.publicKey !== "string" ||
      !authorization ||
      typeof authorization.from !== "string" ||
      typeof authorization.to !== "string" ||
      typeof authorization.value !== "string" ||
      typeof authorization.validAfter !== "string" ||
      typeof authorization.validBefore !== "string" ||
      typeof authorization.nonce !== "string"
    ) {
      return undefined;
    }
    return maybePayload as ExactCasperPayload;
  }

  /**
   * Validate authorization values against requirements.
   *
   * @param payload - Exact Casper payload.
   * @param requirements - Payment requirements.
   * @returns Invalid response or undefined.
   */
  private validateAuthorization(
    payload: ExactCasperPayload,
    requirements: PaymentRequirements,
  ): VerifyResponse | undefined {
    const payer = payload.authorization.from;
    if (payload.authorization.to !== requirements.payTo) {
      return invalid(
        ErrPayToMismatch,
        payer,
        `authorization.to=${payload.authorization.to} requirements.payTo=${requirements.payTo}`,
      );
    }
    if (payload.authorization.value !== requirements.amount) {
      return invalid(
        ErrAmountMismatch,
        payer,
        `authorization.value=${payload.authorization.value} requirements.amount=${requirements.amount}`,
      );
    }
    if (!isValidContractPackageHash(requirements.asset)) {
      return invalid(ErrInvalidAsset, payer, requirements.asset);
    }
    if (
      !isValidCasperAddress(requirements.payTo) ||
      !isValidCasperAddress(payload.authorization.to)
    ) {
      return invalid(ErrInvalidPayTo, payer);
    }
    if (!isValidCasperAddress(payer)) {
      return invalid(ErrInvalidPayer, payer);
    }
    if (
      !/^[1-9]\d*$/.test(requirements.amount) ||
      !/^[1-9]\d*$/.test(payload.authorization.value)
    ) {
      return invalid(ErrAmountMismatch, payer, "amount must be non-zero decimal string");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(payload.authorization.nonce)) {
      return invalid(ErrInvalidSignature, payer, "nonce must be 32 bytes");
    }

    const validAfter = Number(payload.authorization.validAfter);
    const validBefore = Number(payload.authorization.validBefore);
    if (!Number.isSafeInteger(validAfter) || !Number.isSafeInteger(validBefore)) {
      return invalid(ErrInvalidScheme, payer, "invalid validAfter/validBefore");
    }
    const now = Math.floor(Date.now() / 1000);
    if (validAfter >= now) {
      return invalid(ErrNotYetValid, payer, `validAfter=${validAfter} now=${now}`);
    }
    if (now >= validBefore) {
      return invalid(ErrExpired, payer, `validBefore=${validBefore} now=${now}`);
    }

    const name = requirements.extra?.name;
    const version = requirements.extra?.version;
    if (typeof name !== "string" || name === "") {
      return invalid(ErrMissingTokenName, payer);
    }
    if (typeof version !== "string" || version === "") {
      return invalid(ErrMissingTokenVersion, payer);
    }
    return undefined;
  }

  /**
   * Validate public key and signature.
   *
   * @param payload - Exact Casper payload.
   * @param requirements - Payment requirements.
   * @returns Invalid response or undefined.
   */
  private async validateSignature(
    payload: ExactCasperPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse | undefined> {
    const payer = payload.authorization.from;
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = hexToBytes(payload.signature);
      if (signatureBytes.length !== 65) {
        return invalid(ErrInvalidSignature, payer, "signature must be 65 bytes");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrInvalidSignature, payer, message);
    }

    if (!isCanonicalSecp256k1Signature(signatureBytes)) {
      return invalid(ErrNonCanonicalSignature, payer);
    }

    let publicKey: casperSdk.PublicKey;
    try {
      publicKey = casperSdk.PublicKey.fromHex(payload.publicKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrInvalidSignature, payer, message);
    }

    if (publicKey.accountHash().toHex() !== payer.slice(2)) {
      return invalid(ErrPublicKeyMismatch, payer, "public key does not match authorization.from");
    }

    const name = requirements.extra?.name as string;
    const version = requirements.extra?.version as string;
    let digest: Uint8Array;
    try {
      digest = buildTransferWithAuthorizationDigest({
        name,
        version,
        network: requirements.network,
        asset: requirements.asset,
        authorization: payload.authorization,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrFailedToHash, payer, message);
    }

    try {
      if (!publicKey.verifySignature(digest, signatureBytes)) {
        return invalid(ErrInvalidSignature, payer, "signature verification failed");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrInvalidSignature, payer, message);
    }

    return undefined;
  }

  /**
   * Validate live preflight requirements.
   *
   * @param payload - Exact Casper payload.
   * @param requirements - Payment requirements.
   * @returns Invalid response or undefined.
   */
  private async validatePreflight(
    payload: ExactCasperPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse | undefined> {
    const payer = payload.authorization.from;
    try {
      await this.signer.getNetworkConfig(requirements.network);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrNetworkMismatch, payer, message);
    }

    try {
      const balance = await this.signer.getBalance({
        network: requirements.network,
        asset: requirements.asset,
        account: payer,
      });
      if (balance < BigInt(requirements.amount)) {
        return invalid(ErrInsufficientBalance, payer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrInsufficientBalance, payer, message);
    }

    try {
      const state = await this.signer.getAuthorizationState({
        network: requirements.network,
        asset: requirements.asset,
        payer,
        nonce: payload.authorization.nonce,
      });
      if (state !== "unused") {
        return invalid(ErrAuthorizationUsed, payer, state);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrAuthorizationUsed, payer, message);
    }

    try {
      await this.signer.assertTransferWithAuthorizationSupported({
        network: requirements.network,
        asset: requirements.asset,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrUnsupportedAsset, payer, message);
    }

    return undefined;
  }

  /**
   * Validate the authorization with optional speculative execution.
   *
   * @param payload - Exact Casper payload.
   * @param requirements - Payment requirements.
   * @returns Invalid response or undefined.
   */
  private async validateSpeculativeExecution(
    payload: ExactCasperPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse | undefined> {
    if (!this.signer.simulateTransferWithAuthorization) {
      return undefined;
    }

    const payer = payload.authorization.from;
    try {
      const transaction = await this.buildTransferWithAuthorizationTransaction(
        payload,
        requirements,
        "deploy",
      );
      await this.signer.signTransaction(transaction, requirements.network);
      const deploy = transaction.getDeploy();
      if (!deploy) {
        return invalid(
          ErrSpeculativeExecutionFailed,
          payer,
          "buildFor1_5 did not produce a deploy",
        );
      }
      await this.signer.simulateTransferWithAuthorization({
        network: requirements.network,
        asset: requirements.asset,
        deploy,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrSpeculativeExecutionFailed, payer, message);
    }

    return undefined;
  }
}

/**
 * Build runtime args for the transfer_with_authorization entry point.
 *
 * @param payload - Exact Casper payload.
 * @returns Casper runtime args.
 */
function buildTransferWithAuthorizationArgs(payload: ExactCasperPayload) {
  const fromKey = casperSdk.Key.fromBytes(hexToBytes(payload.authorization.from)).result;
  const toKey = casperSdk.Key.fromBytes(hexToBytes(payload.authorization.to)).result;
  const signatureBytes = hexToBytes(payload.signature);
  const nonceBytes = hexToBytes(payload.authorization.nonce);
  const publicKey = casperSdk.PublicKey.fromHex(payload.publicKey);

  return casperSdk.Args.fromMap({
    from: casperSdk.CLValue.newCLKey(fromKey),
    to: casperSdk.CLValue.newCLKey(toKey),
    value: casperSdk.CLValue.newCLUInt256(payload.authorization.value),
    valid_after: casperSdk.CLValue.newCLUint64(Number(payload.authorization.validAfter)),
    valid_before: casperSdk.CLValue.newCLUint64(Number(payload.authorization.validBefore)),
    nonce: casperSdk.CLValue.newCLList(
      casperSdk.CLTypeUInt8,
      Array.from(nonceBytes).map(byte => casperSdk.CLValue.newCLUint8(byte)),
    ),
    public_key: casperSdk.CLValue.newCLPublicKey(publicKey),
    signature: casperSdk.CLValue.newCLList(
      casperSdk.CLTypeUInt8,
      Array.from(signatureBytes).map(byte => casperSdk.CLValue.newCLUint8(byte)),
    ),
  });
}
