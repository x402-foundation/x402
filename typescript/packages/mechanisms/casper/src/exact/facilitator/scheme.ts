import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  Args,
  CLTypeUInt8,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  Key,
  PublicKey,
  RpcClient,
  SpeculativeClient,
  Transaction,
} from "casper-js-sdk";
import { CASPER_CAIP2_FAMILY, DEFAULT_PAYMENT_MOTES, SCHEME_EXACT } from "../../constants";
import type { NetworkConfig } from "../../constants";
import type { ExactCasperPayload, FacilitatorCasperSigner } from "../../types";
import {
  buildTransferWithAuthorizationDigest,
  hexToBytes,
  isCanonicalSecp256k1Signature,
  isValidCasperAccountHash,
  isValidCasperAddress,
  isValidContractPackageHash,
} from "../../utils";
import {
  dictionaryKeyForAddress,
  dictionaryKeyForUsedNonces,
  getActiveContractForToken,
  isMissingDictionaryItem,
  readDictionaryBool,
  readDictionaryU256OrDefault,
} from "../../contracts";

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
export const ErrAuthorizationUsed =
  "invalid_exact_casper_facilitator_authorization_used_or_canceled";
export const ErrUnsupportedAsset = "invalid_exact_casper_facilitator_unsupported_asset";
export const ErrSpeculativeExecutionFailed =
  "invalid_exact_casper_facilitator_speculative_execution_failed";

const TRANSFER_WITH_AUTHORIZATION_ENTRY_POINT = "transfer_with_authorization";
const BALANCES_DICTIONARY = "balances";
const AUTHORIZATION_STATE_DICTIONARY = "authorization_state";

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
  private readonly rpcClients = new Map<string, InstanceType<typeof RpcClient>>();
  private readonly speculativeClients = new Map<
    string,
    ReturnType<typeof SpeculativeClient.newSpeculativeClient>
  >();

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
  ): Promise<Transaction> {
    const facilitatorPublicKey = PublicKey.fromHex(
      this.signer.getPublicKeyHex(requirements.network),
    );
    const networkConfig = await this.signer.getNetworkConfig(requirements.network);
    const builder = new ContractCallBuilder()
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
    if (!isValidCasperAccountHash(payer)) {
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
    // Verify validAfter is not in the future
    if (validAfter > now) {
      return invalid(ErrNotYetValid, payer, `validAfter=${validAfter} now=${now}`);
    }
    // Verify validBefore is in the future (with 8 second buffer for block time)
    if (now + 8 >= validBefore) {
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
    try {
      if (payload.publicKey.slice(0, 2) !== payload.signature.slice(0, 2)) {
        return invalid(
          ErrInvalidSignature,
          payer,
          "public key and signature algorithm tags do not match",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrInvalidSignature, payer, message);
    }
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

    let publicKey: PublicKey;
    try {
      publicKey = PublicKey.fromHex(payload.publicKey);
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
   * Get or create a cached RPC client for the given URL.
   *
   * @param rpcUrl - RPC node URL.
   * @returns RPC client.
   */
  private getRpcClient(rpcUrl: string): InstanceType<typeof RpcClient> {
    const existing = this.rpcClients.get(rpcUrl);
    if (existing) {
      return existing;
    }
    const client = new RpcClient(new HttpHandler(rpcUrl));
    this.rpcClients.set(rpcUrl, client);
    return client;
  }

  /**
   * Get or create a cached speculative execution client for the given URL.
   *
   * @param speculativeRpcUrl - Speculative RPC node URL.
   * @returns Speculative execution client.
   */
  private getSpeculativeClient(
    speculativeRpcUrl: string,
  ): ReturnType<typeof SpeculativeClient.newSpeculativeClient> {
    const existing = this.speculativeClients.get(speculativeRpcUrl);
    if (existing) {
      return existing;
    }
    const client = SpeculativeClient.newSpeculativeClient(new HttpHandler(speculativeRpcUrl));
    this.speculativeClients.set(speculativeRpcUrl, client);
    return client;
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
    let networkConfig: NetworkConfig;
    try {
      networkConfig = await this.signer.getNetworkConfig(requirements.network);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrNetworkMismatch, payer, message);
    }

    const speculativeRpcUrl = this.signer.getSpeculativeRpcUrl(requirements.network);
    if (speculativeRpcUrl) {
      return this.validateSpeculativeExecution(payload, requirements, speculativeRpcUrl);
    }

    return this.validateTargetedPreflight(payload, requirements, networkConfig.rpcUrl);
  }

  /**
   * Validate live preflight requirements via targeted RPC reads.
   *
   * @param payload - Exact Casper payload.
   * @param requirements - Payment requirements.
   * @param rpcUrl - RPC node URL.
   * @returns Invalid response or undefined.
   */
  private async validateTargetedPreflight(
    payload: ExactCasperPayload,
    requirements: PaymentRequirements,
    rpcUrl: string,
  ): Promise<VerifyResponse | undefined> {
    const payer = payload.authorization.from;
    const rpcClient = this.getRpcClient(rpcUrl);
    let tokenContractHash: string;

    try {
      const tokenContract = await getActiveContractForToken(rpcClient, requirements.asset);
      tokenContractHash = tokenContract.contractHash;
      const supportsTransferWithAuthorization = (tokenContract.entryPoints ?? []).some(
        entryPoint => entryPoint.name === TRANSFER_WITH_AUTHORIZATION_ENTRY_POINT,
      );
      if (!supportsTransferWithAuthorization) {
        return invalid(
          ErrUnsupportedAsset,
          payer,
          `missing ${TRANSFER_WITH_AUTHORIZATION_ENTRY_POINT}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrUnsupportedAsset, payer, message);
    }

    try {
      const balance = await readDictionaryU256OrDefault(
        rpcClient,
        tokenContractHash,
        BALANCES_DICTIONARY,
        dictionaryKeyForAddress(payer),
      );
      if (balance < BigInt(requirements.amount)) {
        return invalid(ErrInsufficientBalance, payer);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrInsufficientBalance, payer, message);
    }

    try {
      const usedNonce = await readDictionaryBool(
        rpcClient,
        tokenContractHash,
        AUTHORIZATION_STATE_DICTIONARY,
        dictionaryKeyForUsedNonces(payer, payload.authorization.nonce),
      );
      if (usedNonce) {
        return invalid(ErrAuthorizationUsed, payer, "authorization used or cancelled");
      }
    } catch (error) {
      if (!isMissingDictionaryItem(error)) {
        const message = error instanceof Error ? error.message : String(error);
        return invalid(ErrAuthorizationUsed, payer, message);
      }
    }

    return undefined;
  }

  /**
   * Validate the authorization with optional speculative execution.
   *
   * @param payload - Exact Casper payload.
   * @param requirements - Payment requirements.
   * @param speculativeRpcUrl - Speculative RPC node URL.
   * @returns Invalid response or undefined.
   */
  private async validateSpeculativeExecution(
    payload: ExactCasperPayload,
    requirements: PaymentRequirements,
    speculativeRpcUrl: string,
  ): Promise<VerifyResponse | undefined> {
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
      const result = await this.getSpeculativeClient(speculativeRpcUrl).speculativeExec(
        "1",
        deploy,
      );
      const v2ErrorMessage = result.executionResult?.errorMessage;
      if (v2ErrorMessage) {
        throw new Error(`speculative execution failed: ${v2ErrorMessage}`);
      }
      if (result.executionResult) {
        return undefined;
      }

      const rawJSON = result.rawJSON === undefined ? "" : `: ${JSON.stringify(result.rawJSON)}`;
      throw new Error(`speculative execution returned an unrecognized response: ${rawJSON}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return invalid(ErrSpeculativeExecutionFailed, payer, message);
    }
  }
}

/**
 * Build runtime args for the transfer_with_authorization entry point.
 *
 * @param payload - Exact Casper payload.
 * @returns Casper runtime args.
 */
function buildTransferWithAuthorizationArgs(payload: ExactCasperPayload) {
  const fromKey = Key.fromBytes(hexToBytes(payload.authorization.from)).result;
  const toKey = Key.fromBytes(hexToBytes(payload.authorization.to)).result;
  const signatureBytes = hexToBytes(payload.signature);
  const nonceBytes = hexToBytes(payload.authorization.nonce);
  const publicKey = PublicKey.fromHex(payload.publicKey);

  return Args.fromMap({
    from: CLValue.newCLKey(fromKey),
    to: CLValue.newCLKey(toKey),
    value: CLValue.newCLUInt256(payload.authorization.value),
    valid_after: CLValue.newCLUint64(Number(payload.authorization.validAfter)),
    valid_before: CLValue.newCLUint64(Number(payload.authorization.validBefore)),
    nonce: CLValue.newCLList(
      CLTypeUInt8,
      Array.from(nonceBytes).map(byte => CLValue.newCLUint8(byte)),
    ),
    public_key: CLValue.newCLPublicKey(publicKey),
    signature: CLValue.newCLList(
      CLTypeUInt8,
      Array.from(signatureBytes).map(byte => CLValue.newCLUint8(byte)),
    ),
  });
}
