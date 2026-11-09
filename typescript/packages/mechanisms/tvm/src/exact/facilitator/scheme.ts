import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  ALLOWED_CLIENT_CODES,
  DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_SETTLEMENT_BATCH_FLUSH_INTERVAL_SECONDS,
  DEFAULT_SETTLEMENT_BATCH_FLUSH_SIZE,
  DEFAULT_TRACE_CONFIRMATION_TIMEOUT_SECONDS,
  DEFAULT_TVM_OUTER_GAS_BUFFER,
  ERR_EXACT_TVM_ACCOUNT_FROZEN,
  ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
  ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE,
  ERR_EXACT_TVM_INSUFFICIENT_BALANCE,
  ERR_EXACT_TVM_INVALID_AMOUNT,
  ERR_EXACT_TVM_INVALID_ASSET,
  ERR_EXACT_TVM_INVALID_CODE_HASH,
  ERR_EXACT_TVM_INVALID_EXTENSIONS_DICT,
  ERR_EXACT_TVM_INVALID_JETTON_TRANSFER,
  ERR_EXACT_TVM_INVALID_PAYLOAD,
  ERR_EXACT_TVM_INVALID_RECIPIENT,
  ERR_EXACT_TVM_INVALID_SEQNO,
  ERR_EXACT_TVM_INVALID_SIGNATURE,
  ERR_EXACT_TVM_INVALID_SIGNATURE_MODE,
  ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED,
  ERR_EXACT_TVM_INVALID_W5_MESSAGE,
  ERR_EXACT_TVM_INVALID_WALLET_ID,
  ERR_EXACT_TVM_NETWORK_MISMATCH,
  ERR_EXACT_TVM_SIMULATION_FAILED,
  ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH,
  ERR_EXACT_TVM_TRANSACTION_FAILED,
  ERR_EXACT_TVM_UNSUPPORTED_NETWORK,
  ERR_EXACT_TVM_UNSUPPORTED_SCHEME,
  ERR_EXACT_TVM_UNSUPPORTED_VERSION,
  ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR,
  MIN_FACILITATOR_TON_BALANCE,
  SCHEME_EXACT,
  SUPPORTED_NETWORKS,
} from "../../constants";
import { decodeBase64Boc, makeZeroBitCell, normalizeAddress } from "../../codecs/common";
import {
  parseActiveW5AccountState,
  parseW5InitData,
  stateInitAddressMatches,
  verifyW5Signature,
} from "../../codecs/w5";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorTvmSigner } from "../../signer";
import type { ExactTvmPayload, ParsedTvmSettlement, TvmRelayRequest } from "../../types";
import {
  messageBodyHashMatches,
  parseTraceTransactions,
  traceTransactionComputeFees,
  traceTransactionFwdFees,
  traceTransactionHashToHex,
  traceTransactionStorageFees,
  transactionSucceeded,
  type TvmTraceTransaction,
} from "../../trace-utils";
import { parseExactTvmPayload } from "../codec";
import { SettlementBatcher } from "../settlement-batcher";

export interface ExactTvmFacilitatorConfig {
  settlementCache?: SettlementCache;
  batchFlushIntervalSeconds?: number;
  batchFlushSize?: number;
  confirmationTimeoutSeconds?: number;
}

export class ExactTvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME_EXACT;
  readonly caipFamily = "tvm:*";
  private readonly settlementCache: SettlementCache;
  private readonly batcher: SettlementBatcher;

  constructor(
    private readonly signer: FacilitatorTvmSigner,
    config: ExactTvmFacilitatorConfig = {},
  ) {
    this.settlementCache = config.settlementCache ?? new SettlementCache();
    this.batcher = new SettlementBatcher(this.signer, this.settlementCache, {
      flushIntervalSeconds:
        config.batchFlushIntervalSeconds ?? DEFAULT_SETTLEMENT_BATCH_FLUSH_INTERVAL_SECONDS,
      batchFlushSize: config.batchFlushSize ?? DEFAULT_SETTLEMENT_BATCH_FLUSH_SIZE,
      confirmationTimeoutSeconds:
        config.confirmationTimeoutSeconds ?? DEFAULT_TRACE_CONFIRMATION_TIMEOUT_SECONDS,
      settlementVerifier: (traceData, settlement, _relayRequest) =>
        ExactTvmScheme.verifyFinalizedTraceSettlement(traceData, {
          settlement,
        }) as string,
    });
  }

  getExtra(network: string): Record<string, unknown> | undefined {
    if (!SUPPORTED_NETWORKS.has(network)) {
      return undefined;
    }
    return { areFeesSponsored: true };
  }

  getSigners(network: string): string[] {
    return this.signer.getAddressesForNetwork(network);
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    let tvmPayload: ExactTvmPayload;
    try {
      tvmPayload = exactTvmPayloadFromUnknown(payload.payload);
    } catch (error) {
      return {
        isValid: false,
        invalidReason: ERR_EXACT_TVM_INVALID_PAYLOAD,
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: "",
      };
    }

    try {
      const settlement = parseExactTvmPayload(tvmPayload.settlementBoc);
      const [verification] = await this.verifyParsed(payload, requirements, tvmPayload, settlement);
      return verification;
    } catch (error) {
      return {
        isValid: false,
        invalidReason:
          error instanceof Error && error.message ? error.message : ERR_EXACT_TVM_SIMULATION_FAILED,
        payer: "",
      };
    }
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    let tvmPayload: ExactTvmPayload;
    try {
      tvmPayload = exactTvmPayloadFromUnknown(payload.payload);
    } catch (error) {
      return {
        success: false,
        errorReason: ERR_EXACT_TVM_INVALID_PAYLOAD,
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: "",
        transaction: "",
        network: requirements.network,
      };
    }

    let settlement: ParsedTvmSettlement;
    let verification: VerifyResponse;
    let relayRequest: TvmRelayRequest | null;
    try {
      settlement = parseExactTvmPayload(tvmPayload.settlementBoc);
      const verified = await this.verifyParsed(payload, requirements, tvmPayload, settlement);
      verification = verified[0];
      relayRequest = verified[1];
    } catch (error) {
      return {
        success: false,
        errorReason:
          error instanceof Error && error.message ? error.message : ERR_EXACT_TVM_SIMULATION_FAILED,
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: "",
        transaction: "",
        network: requirements.network,
      };
    }

    if (!verification.isValid || !relayRequest) {
      return {
        success: false,
        errorReason: verification.invalidReason,
        errorMessage: verification.invalidMessage,
        payer: verification.payer,
        transaction: "",
        network: requirements.network,
      };
    }

    if (
      this.settlementCache.isDuplicate(
        settlement.settlementHash,
        requirements.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
      )
    ) {
      return {
        success: false,
        errorReason: ERR_EXACT_TVM_DUPLICATE_SETTLEMENT,
        payer: settlement.payer,
        transaction: "",
        network: requirements.network,
      };
    }

    try {
      const result = await this.batcher.enqueue({
        network: String(requirements.network),
        settlementHash: settlement.settlementHash,
        settlement,
        relayRequest,
      });
      return {
        success: result.success,
        errorReason: result.errorReason,
        errorMessage: result.errorMessage,
        payer: settlement.payer,
        transaction: result.transaction ?? "",
        network: requirements.network,
      };
    } catch (error) {
      this.settlementCache.release(settlement.settlementHash);
      return {
        success: false,
        errorReason: ERR_EXACT_TVM_TRANSACTION_FAILED,
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: settlement.payer,
        transaction: "",
        network: requirements.network,
      };
    } finally {
      void context;
    }
  }

  private async verifyParsed(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    tvmPayload: ExactTvmPayload,
    settlement: ParsedTvmSettlement,
  ): Promise<[VerifyResponse, TvmRelayRequest | null]> {
    const payer = settlement.payer;
    const invalid = (reason: string): [VerifyResponse, null] => [
      { isValid: false, invalidReason: reason, payer },
      null,
    ];

    if (payload.x402Version !== 2) return invalid(ERR_EXACT_TVM_UNSUPPORTED_VERSION);
    if (payload.accepted.scheme !== SCHEME_EXACT || requirements.scheme !== SCHEME_EXACT) {
      return invalid(ERR_EXACT_TVM_UNSUPPORTED_SCHEME);
    }
    if (!SUPPORTED_NETWORKS.has(String(requirements.network))) {
      return invalid(ERR_EXACT_TVM_UNSUPPORTED_NETWORK);
    }
    if (String(payload.accepted.network) !== String(requirements.network)) {
      return invalid(ERR_EXACT_TVM_NETWORK_MISMATCH);
    }

    const facilitatorAddresses = this.signer.getAddressesForNetwork(String(requirements.network));
    for (const facilitatorAddress of facilitatorAddresses) {
      const state = await this.signer.getAccountState(
        facilitatorAddress,
        String(requirements.network),
      );
      if (state.balance < MIN_FACILITATOR_TON_BALANCE) {
        return [
          {
            isValid: false,
            invalidReason: ERR_EXACT_TVM_FACILITATOR_INSUFFICIENT_BALANCE,
            invalidMessage: `Facilitator wallet ${facilitatorAddress} balance ${state.balance} nanotons is below required ${MIN_FACILITATOR_TON_BALANCE} nanotons`,
            payer,
          },
          null,
        ];
      }
    }

    if (BigInt(payload.accepted.amount) !== BigInt(requirements.amount)) {
      return invalid(ERR_EXACT_TVM_INVALID_AMOUNT);
    }
    if (normalizeAddress(payload.accepted.asset) !== normalizeAddress(requirements.asset)) {
      return invalid(ERR_EXACT_TVM_INVALID_ASSET);
    }
    if (normalizeAddress(payload.accepted.payTo) !== normalizeAddress(requirements.payTo)) {
      return invalid(ERR_EXACT_TVM_INVALID_RECIPIENT);
    }

    const acceptedExtra = (payload.accepted.extra ?? {}) as Record<string, unknown>;
    const requirementsExtra = (requirements.extra ?? {}) as Record<string, unknown>;
    if (acceptedExtra.areFeesSponsored !== true || requirementsExtra.areFeesSponsored !== true) {
      return invalid(ERR_EXACT_TVM_UNSUPPORTED_SCHEME);
    }
    if (normalizeAddress(tvmPayload.asset) !== normalizeAddress(requirements.asset)) {
      return invalid(ERR_EXACT_TVM_INVALID_ASSET);
    }

    const expectedResponseDestination = effectiveResponseDestination(requirementsExtra);
    if (effectiveResponseDestination(acceptedExtra) !== expectedResponseDestination) {
      return invalid(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
    }
    const expectedForwardTonAmount = effectiveForwardTonAmount(requirementsExtra);
    if (effectiveForwardTonAmount(acceptedExtra) !== expectedForwardTonAmount) {
      return invalid(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
    }
    const expectedForwardPayload = effectiveForwardPayload(requirementsExtra);
    if (!effectiveForwardPayload(acceptedExtra).hash().equals(expectedForwardPayload.hash())) {
      return invalid(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
    }

    if (settlement.transfer.destination !== normalizeAddress(requirements.payTo)) {
      return invalid(ERR_EXACT_TVM_INVALID_RECIPIENT);
    }
    if (settlement.transfer.jettonAmount !== BigInt(requirements.amount)) {
      return invalid(ERR_EXACT_TVM_INVALID_AMOUNT);
    }
    if (settlement.transfer.forwardTonAmount !== expectedForwardTonAmount) {
      return invalid(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
    }
    if (settlement.transfer.responseDestination !== expectedResponseDestination) {
      return invalid(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
    }
    if (!settlement.transfer.forwardPayload.hash().equals(expectedForwardPayload.hash())) {
      return invalid(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
    }
    const maxAttachedTonAmount =
      settlement.transfer.forwardTonAmount + DEFAULT_JETTON_WALLET_MESSAGE_AMOUNT;
    if (settlement.transfer.attachedTonAmount > maxAttachedTonAmount) {
      return invalid(ERR_EXACT_TVM_TON_AMOUNT_TOO_HIGH);
    }

    const now = Math.floor(Date.now() / 1000);
    if (settlement.validUntil <= now) return invalid(ERR_EXACT_TVM_INVALID_UNTIL_EXPIRED);
    if (
      settlement.validUntil >
      now + (requirements.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS)
    ) {
      return invalid(ERR_EXACT_TVM_VALID_UNTIL_TOO_FAR);
    }

    const account = await this.signer.getAccountState(payer, String(requirements.network));
    if (account.isFrozen) return invalid(ERR_EXACT_TVM_ACCOUNT_FROZEN);

    let initDataParsed;
    if (settlement.stateInit && account.isUninitialized) {
      if (
        !settlement.stateInit.code ||
        !ALLOWED_CLIENT_CODES.has(settlement.stateInit.code.hash().toString("hex"))
      ) {
        return invalid(ERR_EXACT_TVM_INVALID_CODE_HASH);
      }
      if (!stateInitAddressMatches(settlement.stateInit, payer)) {
        return invalid(ERR_EXACT_TVM_INVALID_W5_MESSAGE);
      }
      initDataParsed = parseW5InitData(settlement.stateInit);
      if (initDataParsed.seqno !== 0) return invalid(ERR_EXACT_TVM_INVALID_SEQNO);
      if (initDataParsed.extensionsDict) return invalid(ERR_EXACT_TVM_INVALID_EXTENSIONS_DICT);
    } else {
      try {
        initDataParsed = parseActiveW5AccountState(account);
      } catch {
        return invalid(ERR_EXACT_TVM_INVALID_CODE_HASH);
      }
    }

    if (!initDataParsed.signatureAllowed) return invalid(ERR_EXACT_TVM_INVALID_SIGNATURE_MODE);
    if (initDataParsed.seqno !== settlement.seqno) return invalid(ERR_EXACT_TVM_INVALID_SEQNO);
    if (initDataParsed.walletId !== settlement.walletId) {
      return invalid(ERR_EXACT_TVM_INVALID_WALLET_ID);
    }
    if (
      !verifyW5Signature(initDataParsed.publicKey, settlement.signedSliceHash, settlement.signature)
    ) {
      return invalid(ERR_EXACT_TVM_INVALID_SIGNATURE);
    }

    const canonicalSourceWallet = normalizeAddress(
      await this.signer.getJettonWallet(requirements.asset, payer, String(requirements.network)),
    );
    if (normalizeAddress(settlement.transfer.sourceWallet) !== canonicalSourceWallet) {
      return invalid(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
    }
    const jettonWalletData = await this.signer.getJettonWalletData(
      settlement.transfer.sourceWallet,
      String(requirements.network),
    );
    if (normalizeAddress(jettonWalletData.owner) !== payer) {
      return invalid(ERR_EXACT_TVM_INVALID_RECIPIENT);
    }
    if (normalizeAddress(jettonWalletData.jettonMinter) !== normalizeAddress(requirements.asset)) {
      return invalid(ERR_EXACT_TVM_INVALID_ASSET);
    }
    if (jettonWalletData.balance < settlement.transfer.jettonAmount) {
      return invalid(ERR_EXACT_TVM_INSUFFICIENT_BALANCE);
    }

    try {
      const provisionalRelayRequest: TvmRelayRequest = {
        destination: settlement.payer,
        body: settlement.body,
        stateInit: settlement.stateInit,
        forwardTonAmount: settlement.transfer.forwardTonAmount,
      };
      const externalBoc = await this.signer.buildRelayExternalBoc(
        String(requirements.network),
        provisionalRelayRequest,
        { forEmulation: true },
      );
      const emulation = await this.signer.emulateExternalMessage(
        String(requirements.network),
        externalBoc,
      );
      const payerTransaction = ExactTvmScheme.verifyFinalizedTraceSettlement(emulation, {
        settlement,
        returnTransaction: true,
      }) as TvmTraceTransaction;
      const actualInner = settlement.transfer.attachedTonAmount;
      const requiredOuter =
        actualInner +
        traceTransactionStorageFees(payerTransaction) +
        traceTransactionComputeFees(payerTransaction) +
        traceTransactionFwdFees(payerTransaction) +
        DEFAULT_TVM_OUTER_GAS_BUFFER;
      return [
        { isValid: true, payer },
        {
          destination: settlement.payer,
          body: settlement.body,
          stateInit: settlement.stateInit,
          forwardTonAmount: settlement.transfer.forwardTonAmount,
          relayAmount: requiredOuter,
        },
      ];
    } catch (error) {
      return [
        {
          isValid: false,
          invalidReason: ERR_EXACT_TVM_SIMULATION_FAILED,
          invalidMessage: error instanceof Error ? error.message : String(error),
          payer,
        },
        null,
      ];
    }
  }

  static verifyFinalizedTraceSettlement(
    traceData: Record<string, unknown>,
    {
      settlement,
      returnTransaction = false,
    }: {
      settlement: ParsedTvmSettlement;
      returnTransaction?: boolean;
    },
  ): string | TvmTraceTransaction {
    const transactions = parseTraceTransactions(traceData);
    const expectedSourceWallet = normalizeAddress(settlement.transfer.sourceWallet);

    let payerTransaction: TvmTraceTransaction | null = null;
    for (const transaction of transactions) {
      if (normalizeAddressOrNull(transaction.account) !== settlement.payer) continue;
      if (!transactionSucceeded(transaction)) continue;
      if (!messageBodyHashMatches(transaction.in_msg, settlement.body.hash())) continue;
      payerTransaction = transaction;
      break;
    }
    if (!payerTransaction) {
      throw new Error("Trace does not contain the expected payer wallet transaction");
    }

    const outMsgs = Array.isArray(payerTransaction.out_msgs) ? payerTransaction.out_msgs : [];
    let payerOutHash: unknown;
    for (const outMsg of outMsgs) {
      const message = outMsg as Record<string, unknown>;
      if (normalizeAddressOrNull(message.destination) !== expectedSourceWallet) continue;
      if (!messageBodyHashMatches(message, settlement.transfer.bodyHash)) continue;
      payerOutHash = message.hash;
      break;
    }
    if (!payerOutHash) {
      throw new Error("Trace payer wallet transaction is missing out message hash");
    }

    let sourceWalletTransaction: TvmTraceTransaction | null = null;
    for (const transaction of transactions) {
      if (normalizeAddressOrNull(transaction.account) !== expectedSourceWallet) continue;
      if (!transactionSucceeded(transaction)) continue;
      const inMsg = transaction.in_msg as Record<string, unknown> | undefined;
      if (!inMsg) continue;
      if (inMsg.hash === payerOutHash) {
        sourceWalletTransaction = transaction;
        break;
      }
    }
    if (!sourceWalletTransaction) {
      throw new Error("Trace does not contain the expected source jetton wallet transaction");
    }

    const transactionHash = payerTransaction.hash_norm ?? payerTransaction.hash;
    if (!transactionHash) {
      throw new Error("Trace payer wallet transaction is missing transaction hash");
    }
    return returnTransaction
      ? payerTransaction
      : traceTransactionHashToHex(String(transactionHash));
  }
}

function exactTvmPayloadFromUnknown(value: unknown): ExactTvmPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Exact TVM payload field 'settlementBoc' is required");
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.settlementBoc !== "string" || !payload.settlementBoc.trim()) {
    throw new Error("Exact TVM payload field 'settlementBoc' is required");
  }
  if (typeof payload.asset !== "string" || !payload.asset.trim()) {
    throw new Error("Exact TVM payload field 'asset' is required");
  }
  return { settlementBoc: payload.settlementBoc, asset: payload.asset };
}

function effectiveResponseDestination(extra: Record<string, unknown>): string | null {
  return typeof extra.responseDestination === "string"
    ? normalizeAddress(extra.responseDestination)
    : null;
}

function effectiveForwardTonAmount(extra: Record<string, unknown>): bigint {
  return BigInt(String(extra.forwardTonAmount ?? "0"));
}

function effectiveForwardPayload(extra: Record<string, unknown>) {
  return typeof extra.forwardPayload === "string"
    ? decodeBase64Boc(extra.forwardPayload)
    : makeZeroBitCell();
}

function normalizeAddressOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return normalizeAddress(value);
  } catch {
    return null;
  }
}
