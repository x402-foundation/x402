import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Transaction,
} from "@solana/kit";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  InMemoryPendingSettlementStore,
  type PendingSettlementStore,
} from "@x402/core/facilitator";
import {
  DEFAULT_MAX_COMPUTE_UNITS,
  DEFAULT_MAX_REQUIRED_SIGNATURES,
  LIGHTHOUSE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MEMO_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM_ADDR_CONST,
} from "../../constants";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSvmSigner } from "../../signer";
import type { AuthCaptureSvmPayloadV2 } from "../types";
import {
  decodeTransactionFromPayload,
  getTokenPayerFromTransaction,
  isAcceptedTransactionVersion,
  normalizeAcceptedTransactionVersions,
  peekWireTransactionVersion,
  recordPendingOrTerminal,
  resolveBlockhash,
  transactionMessageHash,
  TransactionOnchainFailureError,
  createRpcClient,
} from "../../utils";
import {
  checkTransactionV1Budget,
  readTransactionV1Config,
  transactionSizeExceeded,
} from "../../transactionV1";
import * as Errors from "./errors";

const compiledMessageDecoder = getCompiledTransactionMessageDecoder();

const IX_TOKEN_APPROVE = 7;
const IX_TOKEN_TRANSFER_CHECKED = 12;

const DEFAULT_SMART_WALLET_ALLOWED_PROGRAMS = [
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
  "SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG",
  "SWiGmQedKzMz1tiTqoJCWeGDnGXfNBp2PkXLkpCAtQo",
  "swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB",
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
  LIGHTHOUSE_PROGRAM_ADDRESS,
];

type VerifyResult = {
  response: VerifyResponse;
  verificationPath: "static" | "smartWallet" | null;
};

const LAYOUT_RECOVERABLE_REASONS = new Set<string>([
  Errors.ErrTransactionInstructionsLength,
  Errors.ErrNoApproveInstruction,
  Errors.ErrUnknownOptionalInstruction,
  Errors.ErrComputeLimitInstruction,
  Errors.ErrComputePriceInstruction,
]);

export function staticApproveIndex(version: number | string): number {
  return version === 1 ? 0 : 2;
}

export type AuthCaptureSvmSchemeOptions = {
  enableSmartWalletVerification?: boolean;
  smartWalletMaxComputeUnits?: number;
  smartWalletMaxPriorityFeeMicroLamports?: number;
  smartWalletAllowedPrograms?: string[];
  maxPriorityFeeMicroLamports?: number;
  maxComputeUnits?: number;
  maxRequiredSignatures?: number;
  transactionVersions?: readonly (0 | 1)[];
  pendingSettlementStore?: PendingSettlementStore;
};

function assertLimit(name: string, value: number | undefined, min: number): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a safe integer >= ${min}, received ${value}`);
  }
}

export class AuthCaptureSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "auth-capture";
  readonly caipFamily = "solana:*";

  private readonly settlementCache: SettlementCache;
  private readonly pendingStore: PendingSettlementStore;
  private readonly transactionVersions: readonly (0 | 1)[];
  private readonly maxComputeUnits: number;
  private readonly maxRequiredSignatures: number;

  constructor(
    private readonly signer: FacilitatorSvmSigner,
    settlementCache?: SettlementCache,
    private readonly options?: AuthCaptureSvmSchemeOptions,
  ) {
    this.settlementCache = settlementCache ?? new SettlementCache();
    this.pendingStore =
      this.options?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();

    assertLimit("maxPriorityFeeMicroLamports", this.options?.maxPriorityFeeMicroLamports, 0);
    assertLimit("maxComputeUnits", this.options?.maxComputeUnits, 1);
    assertLimit("maxRequiredSignatures", this.options?.maxRequiredSignatures, 1);
    this.transactionVersions = normalizeAcceptedTransactionVersions(
      this.options?.transactionVersions,
    );
    this.maxComputeUnits = this.options?.maxComputeUnits ?? DEFAULT_MAX_COMPUTE_UNITS;
    this.maxRequiredSignatures =
      this.options?.maxRequiredSignatures ?? DEFAULT_MAX_REQUIRED_SIGNATURES;
  }

  getExtra(_: string): Record<string, unknown> | undefined {
    const addresses = this.signer.getAddresses();
    const randomIndex = Math.floor(Math.random() * addresses.length);
    const extra: Record<string, unknown> = {
      feePayer: addresses[randomIndex],
      transactionVersions: [...this.transactionVersions],
    };
    if (this.options?.enableSmartWalletVerification) {
      extra.features = { smartWalletSupported: true };
    }
    return extra;
  }

  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const { response } = await this._verify(payload, requirements);
    return response;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const authCapturePayload = payload.payload as AuthCaptureSvmPayloadV2;
    const operationType = authCapturePayload.type;

    let txKey: string | undefined;
    let decodedTransaction: Transaction | undefined;
    if (authCapturePayload.transaction) {
      try {
        decodedTransaction = decodeTransactionFromPayload({
          transaction: authCapturePayload.transaction,
        });
        txKey = transactionMessageHash(decodedTransaction);
      } catch {
        txKey = undefined;
      }
    }

    if (decodedTransaction) {
      try {
        const compiled = compiledMessageDecoder.decode(decodedTransaction.messageBytes);
        if (!isAcceptedTransactionVersion(compiled.version, this.transactionVersions)) {
          return {
            success: false,
            network: payload.accepted.network,
            transaction: "",
            errorReason: Errors.ErrUnsupportedTransactionVersion,
            payer: "",
          };
        }
      } catch {
        // Verification below owns the canonical malformed-message error
      }
    }

    const isCachedDuplicate = txKey ? this.settlementCache.isDuplicate(txKey) : false;

    if (txKey) {
      const cachedSignature = await this.pendingStore.get(txKey);
      if (cachedSignature) {
        await this.pendingStore.delete(txKey);
        let payer = "";
        try {
          payer = getTokenPayerFromTransaction(decodedTransaction!) ?? "";
        } catch {
          payer = "";
        }
        const isSettlementOp =
          operationType === "capture" || operationType === "void" || operationType === "refund";
        return this.reconcilePendingSettlement(
          txKey,
          cachedSignature,
          payer,
          requirements.network,
          isSettlementOp,
          requirements,
        );
      }
    }

    if (isCachedDuplicate) {
      let payer = "";
      try {
        payer = getTokenPayerFromTransaction(decodedTransaction!) || "";
      } catch {
        payer = "";
      }
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: Errors.ErrDuplicateSettlement,
        payer,
      };
    }

    const { response: valid, verificationPath } = await this._verify(payload, requirements);
    if (!valid.isValid) {
      if (txKey) {
        this.settlementCache.delete(txKey);
      }
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: valid.invalidReason ?? Errors.ErrVerificationFailed,
        errorMessage: valid.invalidMessage,
        payer: valid.payer || "",
      };
    }

    txKey ??= transactionMessageHash(
      decodeTransactionFromPayload({ transaction: authCapturePayload.transaction! }),
    );

    const isSmartWalletSettlement = verificationPath === "smartWallet";

    let signature: string;
    let balanceBefore: bigint | null = null;
    let knownDestinationAta: string | null = null;
    let balanceBeforeTokenProgram: string | null = null;

    try {
      const feePayer = requirements.extra.feePayer as Address;

      let fullySignedTransaction: string;

      if (operationType === "void") {
        if (!authCapturePayload.transaction) {
          return {
            success: false,
            errorReason: Errors.ErrVoidRequiresRevokeTransaction,
            transaction: "",
            network: payload.accepted.network,
            payer: valid.payer || "",
          };
        }
        fullySignedTransaction = await this.signer.signTransaction(
          authCapturePayload.transaction,
          feePayer,
          requirements.network,
        );
      } else if (operationType === "refund") {
        fullySignedTransaction = await this.buildRefundTransaction(
          authCapturePayload,
          requirements,
          feePayer,
        );
      } else {
        fullySignedTransaction = await this.buildCaptureTransaction(
          authCapturePayload,
          requirements,
          feePayer,
        );
      }

      signature = await this.signer.sendTransaction(fullySignedTransaction, requirements.network);
    } catch (error) {
      this.settlementCache.delete(txKey);
      console.error("Failed to send transaction:", error);
      return {
        success: false,
        errorReason: Errors.ErrTransactionFailed,
        transaction: "",
        network: payload.accepted.network,
        payer: valid.payer || "",
      };
    }

    try {
      await this.signer.confirmTransaction(signature, requirements.network);
    } catch (error) {
      if (error instanceof TransactionOnchainFailureError) {
        this.settlementCache.delete(txKey);
        console.error("Transaction failed onchain:", error);
        return {
          success: false,
          errorReason: Errors.ErrTransactionFailed,
          errorMessage: error.message,
          transaction: signature,
          network: payload.accepted.network,
          payer: valid.payer || "",
        };
      }
      console.error("Failed to confirm transaction:", error);
      return recordPendingOrTerminal(
        this.pendingStore,
        txKey,
        signature,
        valid.payer || "",
        payload.accepted.network,
        Errors.ErrSettlementPending,
        Errors.ErrTransactionFailed,
        error,
      );
    }

    try {
      await this.pendingStore.delete(txKey);
    } catch {
      // Best-effort cleanup
    }

    if (isSmartWalletSettlement) {
      const signerAddresses = this.signer.getAddresses().map(a => a.toString());
      const postVerify = await this.verifyPostSettlement(
        signature,
        requirements.network,
        requirements,
        signerAddresses,
        balanceBefore,
        balanceBeforeTokenProgram,
        knownDestinationAta,
        operationType,
      );
      if (!postVerify.verified) {
        return {
          success: false,
          errorReason: Errors.ErrPostSettlementTransferNotConfirmed,
          transaction: signature,
          network: payload.accepted.network,
          payer: valid.payer || "",
        };
      }
    }

    return {
      success: true,
      transaction: signature,
      network: payload.accepted.network,
      payer: valid.payer,
    };
  }

  private async reconcilePendingSettlement(
    txKey: string,
    cachedSignature: string,
    payer: string,
    network: PaymentRequirements["network"],
    isSettlementOp: boolean,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    try {
      await this.signer.confirmTransaction(cachedSignature, network);
    } catch (error) {
      if (error instanceof TransactionOnchainFailureError) {
        this.settlementCache.delete(txKey);
        console.error("Transaction failed onchain during reconciliation:", error);
        return {
          success: false,
          errorReason: Errors.ErrTransactionFailed,
          errorMessage: error.message,
          transaction: cachedSignature,
          network,
          payer,
        };
      }
      return recordPendingOrTerminal(
        this.pendingStore,
        txKey,
        cachedSignature,
        payer,
        network,
        Errors.ErrSettlementPending,
        Errors.ErrTransactionFailed,
        error,
      );
    }
    try {
      await this.pendingStore.delete(txKey);
    } catch {
      // Best-effort cleanup
    }

    if (isSettlementOp) {
      const signerAddresses = this.signer.getAddresses().map(a => a.toString());
      const postVerify = await this.verifyPostSettlement(
        cachedSignature,
        network,
        requirements,
        signerAddresses,
        null,
        null,
        null,
        undefined,
      );
      if (!postVerify.verified) {
        return {
          success: false,
          errorReason: Errors.ErrPostSettlementTransferNotConfirmed,
          transaction: cachedSignature,
          network,
          payer,
        };
      }
    }

    return {
      success: true,
      transaction: cachedSignature,
      network,
      payer,
    };
  }

  private async _verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResult> {
    const authCapturePayload = payload.payload as AuthCaptureSvmPayloadV2;

    if (payload.accepted.scheme !== "auth-capture" || requirements.scheme !== "auth-capture") {
      return {
        response: { isValid: false, invalidReason: Errors.ErrUnsupportedScheme, payer: "" },
        verificationPath: null,
      };
    }

    if (payload.accepted.network !== requirements.network) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrNetworkMismatch, payer: "" },
        verificationPath: null,
      };
    }

    if (!requirements.extra?.delegate || typeof requirements.extra.delegate !== "string") {
      return {
        response: { isValid: false, invalidReason: Errors.ErrMissingDelegate, payer: "" },
        verificationPath: null,
      };
    }

    if (!requirements.extra?.feePayer || typeof requirements.extra.feePayer !== "string") {
      return {
        response: { isValid: false, invalidReason: Errors.ErrMissingFeePayer, payer: "" },
        verificationPath: null,
      };
    }

    const signerAddresses = this.signer.getAddresses().map(addr => addr.toString());
    if (!signerAddresses.includes(requirements.extra.feePayer)) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrFeePayerNotManaged, payer: "" },
        verificationPath: null,
      };
    }

    if (!signerAddresses.includes(requirements.extra.delegate as string)) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrDelegateNotManaged, payer: "" },
        verificationPath: null,
      };
    }

    if (requirements.extra.delegate === requirements.extra.feePayer) {
      return {
        response: {
          isValid: false,
          invalidReason: Errors.ErrFeePayerTransferringFunds,
          payer: "",
        },
        verificationPath: null,
      };
    }

    const wireVersion = peekWireTransactionVersion(authCapturePayload.transaction ?? "");
    if (
      wireVersion !== undefined &&
      !isAcceptedTransactionVersion(wireVersion, this.transactionVersions)
    ) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrUnsupportedTransactionVersion, payer: "" },
        verificationPath: null,
      };
    }

    let transaction: Transaction;
    try {
      transaction = decodeTransactionFromPayload({ transaction: authCapturePayload.transaction ?? "" });
    } catch {
      return {
        response: { isValid: false, invalidReason: Errors.ErrTransactionCouldNotBeDecoded, payer: "" },
        verificationPath: null,
      };
    }

    let compiled;
    try {
      compiled = compiledMessageDecoder.decode(transaction.messageBytes);
    } catch {
      return {
        response: { isValid: false, invalidReason: Errors.ErrTransactionCouldNotBeDecoded, payer: "" },
        verificationPath: null,
      };
    }

    if (!isAcceptedTransactionVersion(compiled.version, this.transactionVersions)) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrUnsupportedTransactionVersion, payer: "" },
        verificationPath: null,
      };
    }

    if (
      transactionSizeExceeded(authCapturePayload.transaction ?? "", compiled.version)
    ) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrTransactionSizeExceeded, payer: "" },
        verificationPath: null,
      };
    }

    if (compiled.header.numSignerAccounts > this.maxRequiredSignatures) {
      return {
        response: { isValid: false, invalidReason: Errors.ErrExcessiveSigners, payer: "" },
        verificationPath: null,
      };
    }

    const signatureCheck = await this.verifyRequiredSignatures(
      transaction,
      compiled,
      requirements.extra.feePayer as string,
    );
    if (!signatureCheck.ok) {
      return {
        response: { isValid: false, invalidReason: signatureCheck.invalidReason, payer: "" },
        verificationPath: null,
      };
    }

    let lookupMap: Record<string, Address[]> | undefined;
    const lookups =
      "addressTableLookups" in compiled && Array.isArray(compiled.addressTableLookups)
        ? compiled.addressTableLookups
        : [];
    if (lookups.length > 0) {
      if (typeof this.signer.fetchAddressLookupTables !== "function") {
        return {
          response: {
            isValid: false,
            invalidReason: `${Errors.ErrSmartWalletAltResolutionUnavailable}: transaction uses Address Lookup Tables but signer does not implement fetchAddressLookupTables`,
            payer: "",
          },
          verificationPath: null,
        };
      }
      try {
        const altAddresses = lookups.map(
          l => (l as { lookupTableAddress: { toString(): string } }).lookupTableAddress.toString(),
        );
        const resolved = await this.signer.fetchAddressLookupTables(altAddresses, requirements.network);
        lookupMap = {};
        for (const [key, addresses] of Object.entries(resolved)) {
          lookupMap[key] = addresses.map(a => a as Address);
        }
      } catch (error) {
        return {
          response: {
            isValid: false,
            invalidReason: error instanceof Error ? error.message : Errors.ErrSmartWalletAltResolutionFailed,
            payer: "",
          },
          verificationPath: null,
        };
      }
    }

    let decompiled;
    try {
      decompiled = lookupMap
        ? decompileTransactionMessage(compiled, { addressesByLookupTableAddress: lookupMap })
        : decompileTransactionMessage(compiled);
    } catch {
      return {
        response: { isValid: false, invalidReason: Errors.ErrTransactionCouldNotBeDecoded, payer: "" },
        verificationPath: null,
      };
    }

    const staticResult = await this.verifyStaticPath(
      transaction,
      compiled,
      decompiled,
      authCapturePayload,
      requirements,
      signerAddresses,
    );

    if (staticResult.isValid) {
      return { response: staticResult, verificationPath: "static" };
    }

    const defaultCapExceeded =
      staticResult.invalidReason === Errors.ErrComputeLimitInstructionTooHigh &&
      this.options?.maxComputeUnits === undefined;
    const staticReasonRecoverable =
      defaultCapExceeded ||
      (typeof staticResult.invalidReason === "string" &&
        LAYOUT_RECOVERABLE_REASONS.has(staticResult.invalidReason));

    if (this.options?.enableSmartWalletVerification && staticReasonRecoverable) {
      const allowedPrograms = new Set(
        this.options.smartWalletAllowedPrograms ?? DEFAULT_SMART_WALLET_ALLOWED_PROGRAMS,
      );
      const rawInstructions = (decompiled.instructions ?? []) as ReadonlyArray<{
        programAddress: { toString(): string };
      }>;
      const topLevelPrograms: string[] = [];
      for (const ix of rawInstructions) {
        const addr = ix.programAddress.toString();
        if (addr === "ComputeBudget111111111111111111111111111111" || addr === MEMO_PROGRAM_ADDRESS) {
          continue;
        }
        topLevelPrograms.push(addr);
      }

      const disallowedProgram = topLevelPrograms.find(addr => !allowedPrograms.has(addr));
      if (defaultCapExceeded && (disallowedProgram || topLevelPrograms.length === 0)) {
        return { response: staticResult, verificationPath: null };
      }
      if (disallowedProgram) {
        return {
          response: {
            isValid: false,
            invalidReason: `${Errors.ErrSmartWalletProgramNotAllowed}: ${disallowedProgram}`,
            payer: "",
          },
          verificationPath: null,
        };
      }

      const feePayer = requirements.extra.feePayer as string;
      const smartWalletResult = await this.verifySmartWalletTx(
        authCapturePayload.transaction ?? "",
        requirements,
        feePayer,
        signerAddresses,
        {
          enabled: true,
          maxComputeUnits: this.options.smartWalletMaxComputeUnits,
          maxPriorityFeeMicroLamports: this.options.smartWalletMaxPriorityFeeMicroLamports,
        },
        { transaction, compiled, decompiled, resolvedAccountKeys: [] as string[] },
      );
      return {
        response: smartWalletResult,
        verificationPath: smartWalletResult.isValid ? "smartWallet" : null,
      };
    }

    return { response: staticResult, verificationPath: null };
  }

  private async verifyStaticPath(
    transaction: Transaction,
    compiled: { version: number | string; header: { numSignerAccounts: number }; staticAccounts?: readonly { toString(): string }[] },
    decompiled: { instructions?: ReadonlyArray<{ programAddress: { toString(): string }; accounts?: ReadonlyArray<{ address: { toString(): string } }>; data?: { readonly [index: number]: number; readonly length: number; buffer: ArrayBufferLike; byteOffset: number; byteLength: number } }> },
    authCapturePayload: AuthCaptureSvmPayloadV2,
    requirements: PaymentRequirements,
    signerAddresses: string[],
  ): Promise<VerifyResponse> {
    const instructions = decompiled.instructions ?? [];
    const approveIndex = staticApproveIndex(compiled.version);

    if (compiled.version === 1) {
      const violation = checkTransactionV1Budget(
        readTransactionV1Config(compiled as never),
        (instructions as ReadonlyArray<{ programAddress: Address }>).map(ix =>
          ix.programAddress.toString(),
        ),
        {
          maxComputeUnits: this.maxComputeUnits,
          maxPriceMicroLamports:
            this.options?.maxPriorityFeeMicroLamports ?? MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
        },
      );
      if (violation) {
        return {
          isValid: false,
          invalidReason: Errors.TRANSACTION_V1_BUDGET_REASONS[violation],
          payer: "",
        };
      }
    }

    if (instructions.length < approveIndex + 1 || instructions.length > approveIndex + 5) {
      return {
        isValid: false,
        invalidReason: Errors.ErrTransactionInstructionsLength,
        payer: "",
      };
    }

    if (approveIndex === 2) {
      try {
        this.verifyComputeLimitInstruction(instructions[0] as never);
        this.verifyComputePriceInstruction(instructions[1] as never);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isValid: false,
          invalidReason: errorMessage,
          payer: "",
        };
      }
    }

    const payer = getTokenPayerFromTransaction(transaction);
    if (!payer) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoApproveInstruction,
        payer: "",
      };
    }

    const approveIx = instructions[approveIndex];
    const programAddress = approveIx.programAddress.toString();

    if (
      programAddress !== TOKEN_PROGRAM_ADDR_CONST.toString() &&
      programAddress !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoApproveInstruction,
        payer,
      };
    }

    const ixData = approveIx.data;
    if (!ixData || ixData.length < 10 || ixData[0] !== IX_TOKEN_APPROVE) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoApproveInstruction,
        payer,
      };
    }

    const accounts = approveIx.accounts ?? [];
    if (accounts.length < 3) {
      return {
        isValid: false,
        invalidReason: Errors.ErrNoApproveInstruction,
        payer,
      };
    }

    const sourceAddress = accounts[0].address.toString();
    const delegateAddress = accounts[1].address.toString();
    const authorityAddress = accounts[2].address.toString();

    if (authorityAddress !== payer) {
      return {
        isValid: false,
        invalidReason: Errors.ErrApproveAuthorityMismatch,
        payer,
      };
    }

    const expectedDelegate = requirements.extra.delegate as string;
    if (delegateAddress !== expectedDelegate) {
      return {
        isValid: false,
        invalidReason: Errors.ErrDelegateMismatch,
        payer,
      };
    }

    const feePayer = requirements.extra.feePayer as string;
    if (feePayer === delegateAddress || feePayer === sourceAddress || feePayer === authorityAddress) {
      return {
        isValid: false,
        invalidReason: Errors.ErrFeePayerTransferringFunds,
        payer,
      };
    }

    const amount = new DataView(ixData.buffer, ixData.byteOffset, ixData.byteLength).getBigUint64(1, true);
    const requiredAmount = BigInt(requirements.amount);
    if (amount !== requiredAmount) {
      return {
        isValid: false,
        invalidReason: Errors.ErrAmountMismatch,
        payer,
      };
    }

    const tokenProgram = programAddress === TOKEN_PROGRAM_ADDR_CONST.toString()
      ? (TOKEN_PROGRAM_ADDR_CONST as Address)
      : (TOKEN_2022_PROGRAM_ADDRESS as Address);
    try {
      const [expectedSourceATA] = await findAssociatedTokenPda({
        mint: requirements.asset as Address,
        owner: payer as Address,
        tokenProgram,
      });
      if (sourceAddress !== expectedSourceATA.toString()) {
        return {
          isValid: false,
          invalidReason: Errors.ErrApproveSourceMismatch,
          payer,
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: Errors.ErrApproveSourceMismatch,
        payer,
      };
    }

    const optionalInstructions = instructions.slice(approveIndex + 1);
    const invalidReasonByIndex = [
      Errors.ErrUnknownFourthInstruction,
      Errors.ErrUnknownFifthInstruction,
      Errors.ErrUnknownSixthInstruction,
      Errors.ErrUnknownSeventhInstruction,
    ];

    for (let i = 0; i < optionalInstructions.length; i += 1) {
      const progAddr = optionalInstructions[i].programAddress.toString();
      if (progAddr === LIGHTHOUSE_PROGRAM_ADDRESS || progAddr === MEMO_PROGRAM_ADDRESS) {
        continue;
      }
      return {
        isValid: false,
        invalidReason: invalidReasonByIndex[i] ?? Errors.ErrUnknownOptionalInstruction,
        payer,
      };
    }

    const expectedMemo = requirements.extra?.memo as string | undefined;
    if (expectedMemo) {
      const memoInstructions = optionalInstructions.filter(
        ix => ix.programAddress.toString() === MEMO_PROGRAM_ADDRESS,
      );
      if (memoInstructions.length !== 1) {
        return {
          isValid: false,
          invalidReason: Errors.ErrMemoCount,
          payer,
        };
      }
      const memoData = memoInstructions[0].data;
      const actualMemo = memoData ? new TextDecoder().decode(new Uint8Array(memoData)) : "";
      if (actualMemo !== expectedMemo) {
        return {
          isValid: false,
          invalidReason: Errors.ErrMemoMismatch,
          payer,
        };
      }
    }

    try {
      await this.signer.simulateTransaction(authCapturePayload.transaction ?? "", requirements.network);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isValid: false,
        invalidReason: Errors.ErrTransactionSimulationFailed,
        invalidMessage: errorMessage,
        payer,
      };
    }

    return {
      isValid: true,
      invalidReason: undefined,
      payer,
    };
  }

  private verifyComputeLimitInstruction(instruction: { programAddress: Address; data?: Readonly<Uint8Array> }): void {
    const data = instruction.data;
    if (!data || data.length < 5) {
      throw new Error(Errors.ErrComputeLimitInstruction);
    }
    if (data[0] !== 2) {
      throw new Error(Errors.ErrComputeLimitInstruction);
    }
    const units = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, true);
    if (units > this.maxComputeUnits) {
      throw new Error(Errors.ErrComputeLimitInstructionTooHigh);
    }
  }

  private verifyComputePriceInstruction(instruction: { programAddress: Address; data?: Readonly<Uint8Array> }): void {
    const data = instruction.data;
    if (!data || data.length < 9) {
      throw new Error(Errors.ErrComputePriceInstruction);
    }
    if (data[0] !== 3) {
      throw new Error(Errors.ErrComputePriceInstruction);
    }
    const microLamports = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true);
    const maxPrice = BigInt(this.options?.maxPriorityFeeMicroLamports ?? MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS);
    if (microLamports > maxPrice) {
      throw new Error(Errors.ErrComputePriceInstructionTooHigh);
    }
  }

  private async verifyRequiredSignatures(
    transaction: Transaction,
    compiled: { header: { numSignerAccounts: number }; staticAccounts?: readonly { toString(): string }[] },
    expectedFeePayer: string,
  ): Promise<{ ok: true } | { ok: false; invalidReason: string }> {
    const feePayerAccount = compiled.staticAccounts?.[0]?.toString();
    if (!feePayerAccount || feePayerAccount !== expectedFeePayer) {
      return { ok: false, invalidReason: Errors.ErrFeePayerMismatch };
    }

    const numSigners = compiled.header.numSignerAccounts;
    for (let i = 1; i < numSigners; i++) {
      const address = compiled.staticAccounts?.[i]?.toString();
      if (!address) {
        return { ok: false, invalidReason: Errors.ErrSignatureInvalid };
      }
      const signature = transaction.signatures[address as Address];
      if (!signature || signature.length !== 64) {
        return { ok: false, invalidReason: Errors.ErrSignatureInvalid };
      }
    }
    return { ok: true };
  }

  private async buildCaptureTransaction(
    authCapturePayload: AuthCaptureSvmPayloadV2,
    requirements: PaymentRequirements,
    feePayer: Address,
  ): Promise<string> {
    const tokenProgram = TOKEN_PROGRAM_ADDR_CONST as Address;
    const transactionVersion = 0;

    // Derive payer from the original Approve transaction
    let payer = "";
    try {
      const decoded = decodeTransactionFromPayload({ transaction: authCapturePayload.transaction! });
      payer = getTokenPayerFromTransaction(decoded);
    } catch {
      payer = requirements.payTo as string;
    }

    const [sourceATA] = await findAssociatedTokenPda({
      mint: requirements.asset as Address,
      owner: payer as Address,
      tokenProgram,
    });
    const [destinationATA] = await findAssociatedTokenPda({
      mint: requirements.asset as Address,
      owner: requirements.payTo as Address,
      tokenProgram,
    });

    const delegate = requirements.extra.delegate as Address;
    const amount = BigInt(authCapturePayload.amount ?? requirements.amount);

    const transferIx = getTransferCheckedInstruction(
      {
        source: sourceATA,
        mint: requirements.asset as Address,
        destination: destinationATA,
        authority: delegate,
        amount,
        decimals: 6,
      },
      { programAddress: tokenProgram },
    );

    const latestBlockhash = await this.resolveBlockhash(requirements);

    const tx = pipe(
      createTransactionMessage({ version: transactionVersion }),
      tx => setTransactionMessageFeePayer(feePayer, tx),
      tx => appendTransactionMessageInstructions([transferIx], tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );

    const delegateSigner = this.signer.getSigner?.(delegate);
    if (!delegateSigner) {
      throw new Error(`No signer available for delegate ${delegate}`);
    }

    const signedTx = await partiallySignTransactionMessageWithSigners(
      tx,
      delegateSigner as never,
    );
    const base64 = getBase64EncodedWireTransaction(signedTx);

    return this.signer.signTransaction(base64, feePayer, requirements.network);
  }

  private async buildRefundTransaction(
    authCapturePayload: AuthCaptureSvmPayloadV2,
    requirements: PaymentRequirements,
    feePayer: Address,
  ): Promise<string> {
    const tokenProgram = TOKEN_PROGRAM_ADDR_CONST as Address;
    const transactionVersion = 0;

    // Refund: transfer from merchant's ATA back to payer's ATA
    // The payer address is derived from the original Approve transaction
    let payer = "";
    try {
      const decoded = decodeTransactionFromPayload({ transaction: authCapturePayload.transaction! });
      payer = getTokenPayerFromTransaction(decoded);
    } catch {
      payer = requirements.payTo as string;
    }

    const [sourceATA] = await findAssociatedTokenPda({
      mint: requirements.asset as Address,
      owner: requirements.payTo as Address,
      tokenProgram,
    });
    const [destinationATA] = await findAssociatedTokenPda({
      mint: requirements.asset as Address,
      owner: payer as Address,
      tokenProgram,
    });

    const amount = BigInt(authCapturePayload.amount ?? requirements.amount);

    const transferIx = getTransferCheckedInstruction(
      {
        source: sourceATA,
        mint: requirements.asset as Address,
        destination: destinationATA,
        authority: requirements.payTo as Address,
        amount,
        decimals: 6,
      },
      { programAddress: tokenProgram },
    );

    const latestBlockhash = await this.resolveBlockhash(requirements);

    const tx = pipe(
      createTransactionMessage({ version: transactionVersion }),
      tx => setTransactionMessageFeePayer(feePayer, tx),
      tx => appendTransactionMessageInstructions([transferIx], tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );

    const base64 = getBase64EncodedWireTransaction(tx);
    return this.signer.signTransaction(base64, feePayer, requirements.network);
  }

  private async verifyPostSettlement(
    signature: string,
    network: string,
    requirements: PaymentRequirements,
    signerAddresses: string[],
    balanceBefore: bigint | null,
    balanceBeforeTokenProgram: string | null,
    knownDestinationAta: string | null,
    operationType: "capture" | "void" | "refund" | undefined,
  ): Promise<{ verified: boolean; method: string }> {
    if (typeof this.signer.getConfirmedTransactionInnerInstructions !== "function") {
      return { verified: false, method: "unverified" };
    }

    let confirmed;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        confirmed = await this.signer.getConfirmedTransactionInnerInstructions(signature, network);
        if (confirmed?.innerInstructions) break;
      } catch {
        // Retry
      }
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }

    if (confirmed?.innerInstructions) {
      const transfers = this.extractTransfersFromInnerInstructions(confirmed.innerInstructions, []);
      const requiredAmount = BigInt(requirements.amount);
      const expectedATAs = new Set<string>();
      if (knownDestinationAta) {
        expectedATAs.add(knownDestinationAta);
      } else {
        for (const prog of [TOKEN_PROGRAM_ADDR_CONST, TOKEN_2022_PROGRAM_ADDRESS]) {
          try {
            const [ata] = await findAssociatedTokenPda({
              mint: requirements.asset as Address,
              owner: requirements.payTo as Address,
              tokenProgram: prog as unknown as Address,
            });
            expectedATAs.add(ata.toString());
          } catch {
            // skip
          }
        }
      }

      const matching = transfers.filter(
        t =>
          t.mint === requirements.asset &&
          expectedATAs.has(t.destination) &&
          t.amount >= requiredAmount &&
          !signerAddresses.includes(t.authority),
      );

      if (matching.length >= 1) {
        return { verified: true, method: "innerInstructions" };
      }
      return { verified: false, method: "innerInstructions" };
    }

    if (balanceBefore !== null && typeof this.signer.getTokenAccountBalance === "function" && knownDestinationAta) {
      try {
        const balanceAfter = await this.signer.getTokenAccountBalance(knownDestinationAta, network);
        if (balanceAfter !== null) {
          if (balanceAfter - balanceBefore >= BigInt(requirements.amount)) {
            return { verified: true, method: "balanceDelta" };
          }
          return { verified: false, method: "balanceDelta" };
        }
      } catch {
        // fall through
      }
      return { verified: false, method: "unverified" };
    }

    return { verified: false, method: "unverified" };
  }

  private extractTransfersFromInnerInstructions(
    innerInstructions: Array<{ instructions: Array<Record<string, unknown>> }>,
    accountKeys: readonly string[],
  ): Array<{ programId: string; amount: bigint; mint: string; destination: string; authority: string }> {
    const transfers: Array<{ programId: string; amount: bigint; mint: string; destination: string; authority: string }> = [];
    const TOKEN_PROGRAMS = new Set([
      TOKEN_PROGRAM_ADDR_CONST.toString(),
      TOKEN_2022_PROGRAM_ADDRESS.toString(),
    ]);

    for (const group of innerInstructions) {
      for (const ix of group.instructions) {
        const ixAny = ix as Record<string, unknown>;
        const parsed = ixAny.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
        if (parsed && parsed.type === "transferChecked" && parsed.info && TOKEN_PROGRAMS.has(String(ixAny.programId ?? ""))) {
          const info = parsed.info;
          const tokenAmount = info.tokenAmount as { amount?: string } | undefined;
          const amountStr = tokenAmount?.amount ?? String(info.amount ?? "0");
          transfers.push({
            programId: String(ixAny.programId),
            amount: BigInt(amountStr),
            mint: String(info.mint ?? ""),
            destination: String(info.destination ?? ""),
            authority: String(info.authority ?? info.owner ?? ""),
          });
        }
      }
    }
    return transfers;
  }

  private async verifySmartWalletTx(
    transactionBase64: string,
    requirements: PaymentRequirements,
    feePayerAddress: string,
    signerAddresses: readonly string[],
    options: { enabled: boolean; maxComputeUnits?: number; maxPriorityFeeMicroLamports?: number },
    decoded: { transaction: Transaction; compiled: unknown; decompiled: unknown; resolvedAccountKeys: readonly string[] },
  ): Promise<VerifyResponse> {
    const { assertFeePayerIsolatedFromInstructions } = await import(
      "../../exact/facilitator/smartWalletVerification"
    );

    try {
      const instructions = (decoded.decompiled as { instructions?: ReadonlyArray<{ programAddress: { toString(): string }; accounts?: ReadonlyArray<{ address: { toString(): string } }> }> }).instructions ?? [];
      assertFeePayerIsolatedFromInstructions(instructions, feePayerAddress);
    } catch (error) {
      return {
        isValid: false,
        invalidReason: error instanceof Error ? error.message : Errors.ErrSmartWalletFeePayerNotIsolated,
        payer: "",
      };
    }

    return {
      isValid: false,
      invalidReason: Errors.ErrSmartWalletVerificationUnavailable,
      payer: "",
    };
  }

  private async resolveBlockhash(requirements: PaymentRequirements): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const rpc = createRpcClient(requirements.network as never);
    return resolveBlockhash(rpc, requirements);
  }
}
