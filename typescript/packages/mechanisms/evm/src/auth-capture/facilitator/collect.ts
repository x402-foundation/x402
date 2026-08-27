import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { PendingSettlementStore } from "@x402/core/facilitator";
import { encodeFunctionData, hexToBigInt, isAddressEqual, parseEventLogs, type Log } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import {
  ERC20_BALANCE_OF_ABI,
  escrowAbiWithErrorsForDeployment,
  escrowEventsAbiForDeployment,
  ESCROW_VIEW_ABI,
} from "../abi";
import {
  AUTH_CAPTURE_DEPLOYMENT_V1_1,
  AUTH_CAPTURE_SCHEME,
  DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT,
  type AuthCaptureDeployment,
} from "../constants";
import {
  computePayerAgnosticPaymentInfoHash,
  computePaymentInfoHash,
  deriveBoundSalt,
  isSaltBindingOn,
  verifyERC3009Signature,
  verifyPermit2Signature,
} from "../nonce";
import { appendDataSuffix, resolveDataSuffix } from "../../shared/extensions";
import {
  waitAndReturnSettleResponse,
  withPendingSettlementStore,
} from "../../shared/settleReceipt";
import { classifyErc6492Payer } from "../../shared/verifySignature";
import { getEvmChainId } from "../../utils";
import { paymentInfoToContractTuple, reconstructPaymentInfo, unpackForSettle } from "../utils";
import { verifyCharge } from "../authorizerSigner";
import type {
  AuthCaptureCollectPayload,
  AuthCaptureFacilitatorConfig,
  Eip3009Payload,
  PaymentInfoStruct,
  Permit2Payload,
} from "../types";
import { isEip3009Payload, isPermit2Payload } from "../types";
import * as Errors from "../errors";
import {
  chargeEscrowArgs,
  chargeFeeFromCollectPayload,
  defaultSubmittedFee,
  parseAuthCaptureExtra,
  resolveSettleTarget,
  submittedFeeAmount,
  validateSubmittedFee,
  verifyCommon,
  type NormalizedAuthCaptureExtra,
  type SubmittedFee,
} from "../extra";
import {
  collectPayer,
  facilitatorAddresses,
  normalizePaymentState,
  readPaymentStateForBalances,
  resolveSubmitter,
  simulateEscrowCall,
  writeEscrowCall,
  SAFETY_MARGIN_SECONDS,
} from "./utils";

/**
 * Bound-collect `saltNonce`, if present.
 *
 * @param payload - Collect envelope.
 * @returns The 32-byte nonce, or undefined when unbound.
 */
function collectSaltNonce(payload: AuthCaptureCollectPayload): `0x${string}` | undefined {
  return "saltNonce" in payload ? payload.saltNonce : undefined;
}

/**
 * Partial-charge amount from a charge-completion collect payload.
 *
 * @param payload - Collect envelope.
 * @returns Atomic amount, or undefined when the field is absent.
 */
function collectChargeAmount(payload: AuthCaptureCollectPayload): string | undefined {
  return "amount" in payload && typeof payload.amount === "string" ? payload.amount : undefined;
}

/**
 * Verify a collect (authorize / charge) payload.
 *
 * @param signers - Facilitator signer set.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Narrowed collect payload.
 * @param dataSuffix - Optional settlement suffix included in custom-operator simulation.
 * @param requireChargeCompletion - Require the server-authored fields present at settle time.
 * @returns VerifyResponse.
 */
export async function verifyCollect(
  signers: readonly FacilitatorEvmSigner[],
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureCollectPayload,
  dataSuffix?: `0x${string}`,
  requireChargeCompletion = false,
): Promise<VerifyResponse> {
  const payer = collectPayer(wirePayload);
  const common = verifyCommon(
    payload.accepted.scheme,
    payload.accepted.network,
    requirements,
    AUTH_CAPTURE_SCHEME,
    facilitatorAddresses(signers),
    config,
    false,
  );
  if ("error" in common) {
    return { isValid: false, invalidReason: common.error, payer };
  }
  const extra = common.extra;
  const submitter = resolveSubmitter(signers, extra);
  if (!submitter) {
    return { isValid: false, invalidReason: Errors.ErrOperatorNotAdmitted, payer };
  }
  const bindOn = isSaltBindingOn(extra);
  const saltNonce = collectSaltNonce(wirePayload);

  if (bindOn && saltNonce === undefined) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }
  if (!bindOn && saltNonce !== undefined) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }

  const hasChargeCompletion =
    "authorizerSignature" in wirePayload && wirePayload.authorizerSignature !== undefined;
  const isCharge = extra.paymentFlow === "authorization";

  if (
    (!isCharge && hasChargeCompletion) ||
    (isCharge && requireChargeCompletion && !hasChargeCompletion)
  ) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }

  if (extra.assetTransferMethod === "eip3009" && !isEip3009Payload(wirePayload)) {
    return { isValid: false, invalidReason: Errors.ErrPayloadMethodMismatch, payer };
  }
  if (extra.assetTransferMethod === "permit2" && !isPermit2Payload(wirePayload)) {
    return { isValid: false, invalidReason: Errors.ErrPayloadMethodMismatch, payer };
  }

  const now = Math.floor(Date.now() / 1000);
  if (extra.captureDeadline <= now + SAFETY_MARGIN_SECONDS) {
    return { isValid: false, invalidReason: Errors.ErrCaptureDeadlineExpired, payer };
  }
  if (extra.refundDeadline < extra.captureDeadline) {
    return { isValid: false, invalidReason: Errors.ErrInvalidDeadlineOrdering, payer };
  }
  if (now + requirements.maxTimeoutSeconds > extra.captureDeadline) {
    return { isValid: false, invalidReason: Errors.ErrInvalidDeadlineOrdering, payer };
  }

  const chainId = getEvmChainId(requirements.network);
  const unpacked = unpackForSettle(wirePayload, extra.assetTransferMethod, extra.deployment);

  if (unpacked.preApprovalExpiry <= now + SAFETY_MARGIN_SECONDS) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizationExpired, payer };
  }
  if (unpacked.preApprovalExpiry > extra.captureDeadline) {
    return { isValid: false, invalidReason: Errors.ErrInvalidDeadlineOrdering, payer };
  }

  if (extra.assetTransferMethod === "eip3009") {
    const eipPayload = wirePayload as Eip3009Payload;
    if (Number(eipPayload.authorization.validAfter) > now) {
      return { isValid: false, invalidReason: Errors.ErrAuthorizationNotYetValid, payer };
    }
    if (
      eipPayload.authorization.to.toLowerCase() !== extra.deployment.eip3009Collector.toLowerCase()
    ) {
      return { isValid: false, invalidReason: Errors.ErrTokenCollectorMismatch, payer };
    }
  } else {
    const permitPayload = wirePayload as Permit2Payload;
    if (
      permitPayload.permit2Authorization.spender.toLowerCase() !==
      extra.deployment.permit2Collector.toLowerCase()
    ) {
      return { isValid: false, invalidReason: Errors.ErrTokenCollectorMismatch, payer };
    }
    if (
      permitPayload.permit2Authorization.permitted.token.toLowerCase() !==
      requirements.asset.toLowerCase()
    ) {
      return { isValid: false, invalidReason: Errors.ErrTokenMismatch, payer };
    }
  }

  // The canonical collectors strip the ERC-6492 wrapper onchain, so pre-verify checks the
  // inner signature while settlement forwards the wrapper untouched.
  const { isCounterfactual, innerSignature, eip6492Deployment } = await classifyErc6492Payer(
    submitter,
    wirePayload.signature,
    payer,
  );

  if (isCounterfactual) {
    // An undeployed wallet has no isValidSignature to call, so the simulation below is the
    // only sound check: the collector deploys the wallet before the token validates the
    // inner signature. Gate the preparation target on the allowlist first.
    const factory = eip6492Deployment?.factoryAddress;
    const factoryAllowed =
      !!factory &&
      (config?.eip6492AllowedFactories ?? []).some(
        allowed => allowed.trim().toLowerCase() === factory.toLowerCase(),
      );
    if (!factoryAllowed) {
      return { isValid: false, invalidReason: Errors.ErrErc6492FactoryNotAllowed, payer };
    }
  } else {
    const signatureValid =
      extra.assetTransferMethod === "eip3009"
        ? await verifyERC3009Signature(
            submitter,
            (wirePayload as Eip3009Payload).authorization,
            innerSignature,
            { ...extra, chainId },
            requirements.asset as `0x${string}`,
          )
        : await verifyPermit2Signature(
            submitter,
            (wirePayload as Permit2Payload).permit2Authorization,
            innerSignature,
            chainId,
          );

    if (!signatureValid) {
      return { isValid: false, invalidReason: Errors.ErrInvalidAuthCaptureSignature, payer };
    }
  }

  const originalMax = payload.accepted.amount;
  if (unpacked.amount !== BigInt(originalMax)) {
    return { isValid: false, invalidReason: Errors.ErrAmountMismatch, payer };
  }

  let settleAmount = unpacked.amount;
  let fee = defaultSubmittedFee(extra, settleAmount);

  if (hasChargeCompletion) {
    const chargeAmount = collectChargeAmount(wirePayload);
    if (chargeAmount === undefined) {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
    }
    settleAmount = BigInt(chargeAmount);
    if (settleAmount <= 0n || settleAmount > unpacked.amount) {
      return { isValid: false, invalidReason: Errors.ErrAmountMismatch, payer };
    }
    const chargeFee = chargeFeeFromCollectPayload(extra, wirePayload as Record<string, unknown>);
    if (!chargeFee) {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
    }
    fee = chargeFee;
    const feeError = validateSubmittedFee(extra, settleAmount, fee);
    if (feeError) {
      return { isValid: false, invalidReason: feeError, payer };
    }
  }

  if (bindOn && saltNonce !== undefined) {
    const expectedSalt = deriveBoundSalt(extra.receiverAuthorizer, extra.policy, saltNonce);
    if (BigInt(wirePayload.salt) !== BigInt(expectedSalt)) {
      return { isValid: false, invalidReason: Errors.ErrSaltBindingMismatch, payer };
    }
  }

  const paymentInfo = reconstructPaymentInfo(
    payer,
    unpacked.preApprovalExpiry,
    wirePayload.salt,
    { ...requirements, amount: originalMax },
    extra,
    originalMax,
  );
  const expectedNonce = computePayerAgnosticPaymentInfoHash(
    chainId,
    paymentInfo,
    extra.deployment.escrow,
  );

  if (extra.assetTransferMethod === "eip3009") {
    const wireNonce = (wirePayload as Eip3009Payload).authorization.nonce;
    if (wireNonce.toLowerCase() !== expectedNonce.toLowerCase()) {
      return { isValid: false, invalidReason: Errors.ErrNonceMismatch, payer };
    }
  } else {
    const wireNonce = BigInt((wirePayload as Permit2Payload).permit2Authorization.nonce);
    if (wireNonce !== hexToBigInt(expectedNonce)) {
      return { isValid: false, invalidReason: Errors.ErrNonceMismatch, payer };
    }
  }

  if (hasChargeCompletion) {
    const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo, extra.deployment.escrow);
    const chargeDigest =
      fee.version === "v1.0"
        ? {
            paymentInfoHash,
            amount: settleAmount,
            tokenCollector: unpacked.tokenCollector,
            collectorData: unpacked.collectorData,
            feeBps: fee.feeBps,
            feeReceiver: fee.feeReceiver,
          }
        : {
            paymentInfoHash,
            amount: settleAmount,
            tokenCollector: unpacked.tokenCollector,
            collectorData: unpacked.collectorData,
            feeAmount: fee.feeAmount,
            feeReceiver: fee.feeReceiver,
          };
    const ok = await verifyCharge(
      submitter,
      extra.receiverAuthorizer,
      chainId,
      extra.captureAuthorizer,
      extra.deployment,
      chargeDigest,
      wirePayload.authorizerSignature as `0x${string}`,
    );
    if (!ok) {
      return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
    }
  }

  const simulateResult = await simulateCollect(
    submitter,
    config,
    extra,
    paymentInfo,
    settleAmount,
    unpacked.tokenCollector,
    unpacked.collectorData,
    fee,
    chainId,
    dataSuffix,
  );
  if (simulateResult !== "ok") {
    try {
      const balance = (await submitter.readContract({
        address: requirements.asset as `0x${string}`,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [payer],
      })) as bigint;
      if (balance < unpacked.amount) {
        return { isValid: false, invalidReason: Errors.ErrInsufficientBalance, payer };
      }
    } catch {
      /* ignore: fall through */
    }
    return { isValid: false, invalidReason: simulateResult, payer };
  }

  return { isValid: true, payer };
}

type CollectBalanceCheck = {
  before: CollectBalanceSnapshot;
  tokenStore: `0x${string}`;
  facilitator: `0x${string}`;
};

type CollectSettleExecution = {
  submitter: FacilitatorEvmSigner;
  extra: NormalizedAuthCaptureExtra;
  payer: `0x${string}`;
  network: Network;
  paymentInfo: PaymentInfoStruct;
  paymentInfoHash: `0x${string}`;
  functionName: "authorize" | "charge";
  settleAmount: bigint;
  fee: SubmittedFee;
  tokenCollector: `0x${string}`;
};

/**
 * Waits for a collect broadcast receipt and runs post-confirm checks, with
 * pending-settlement store bookkeeping.
 *
 * @param store - Pending-settlement store keyed by the collect signature.
 * @param pendingKey - Store lookup key (the collect signature).
 * @param tx - Broadcast transaction hash to await.
 * @param execution - Parsed collect execution context.
 * @param customBalanceCheck - Pre-broadcast balance snapshot for custom operators.
 * @param isReconcile - True on a cache-hit retry (skips balance-delta checks).
 * @returns SettleResponse after receipt confirmation or a retryable pending failure.
 */
async function awaitCollectSettlement(
  store: PendingSettlementStore,
  pendingKey: string | undefined,
  tx: `0x${string}`,
  execution: CollectSettleExecution,
  customBalanceCheck: CollectBalanceCheck | undefined,
  isReconcile: boolean,
): Promise<SettleResponse> {
  const {
    submitter,
    extra,
    payer,
    network,
    paymentInfo,
    paymentInfoHash,
    functionName,
    settleAmount,
    fee,
    tokenCollector,
  } = execution;
  const expectedCapturable = functionName === "authorize" ? settleAmount : 0n;
  const expectedRefundable = functionName === "charge" ? settleAmount : 0n;

  return withPendingSettlementStore(
    store,
    pendingKey,
    () =>
      waitAndReturnSettleResponse(submitter, tx, network, payer, {
        failedStatusReason: Errors.ErrTransactionReverted,
        validateReceipt: receipt => {
          if (extra.operatorType !== "custom") {
            return undefined;
          }
          const eventOk =
            functionName === "charge"
              ? verifyPaymentChargedEvent(receipt.logs, extra.deployment, {
                  paymentInfoHash,
                  amount: settleAmount,
                  tokenCollector,
                  operator: extra.captureAuthorizer,
                  fee,
                })
              : verifyPaymentAuthorizedEvent(receipt.logs, extra.deployment.escrow, {
                  paymentInfoHash,
                  amount: settleAmount,
                  tokenCollector,
                  operator: extra.captureAuthorizer,
                });
          if (!eventOk) {
            return {
              success: false,
              errorReason: Errors.ErrSimulationFailed,
              transaction: tx,
              network,
              payer,
            };
          }
          return undefined;
        },
        onSuccess: async () => {
          const { state, readFailed } = await readPaymentStateForBalances(
            submitter,
            paymentInfoHash,
            expectedCapturable,
            expectedRefundable,
            extra.deployment.escrow,
          );
          if (readFailed) {
            throw new Error("payment state read failed after confirmed collect transaction");
          }
          if (
            !state ||
            !state.hasCollectedPayment ||
            state.capturableAmount !== expectedCapturable ||
            state.refundableAmount !== expectedRefundable
          ) {
            return {
              success: false,
              errorReason: Errors.ErrUnexpectedPaymentState,
              transaction: tx,
              network,
              payer,
            };
          }

          // Cache-hit reconcile has no pre-broadcast balance snapshot; still require escrow
          // events (above) and post-confirm paymentState, but skip the delta check.
          if (customBalanceCheck && !isReconcile) {
            const after = await readCollectBalanceSnapshot(
              submitter,
              paymentInfo.token,
              payer,
              customBalanceCheck.tokenStore,
              customBalanceCheck.facilitator,
              functionName,
              paymentInfo.receiver,
              fee.feeReceiver,
            );
            if (!after) {
              throw new Error("balance read failed after confirmed collect transaction");
            }
            if (
              !hasExpectedCollectBalanceChanges(
                customBalanceCheck.before,
                after,
                functionName,
                settleAmount,
                fee,
              )
            ) {
              return {
                success: false,
                errorReason: Errors.ErrSimulationFailed,
                transaction: tx,
                network,
                payer,
              };
            }
          }

          return {
            success: true,
            transaction: tx,
            network,
            payer,
            amount: settleAmount.toString(),
          };
        },
      }),
    Errors.ErrTransactionReverted,
  );
}

/**
 * Build collect execution context from a verified or reconciled payload.
 *
 * @param signers - Facilitator signer set.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Narrowed collect payload.
 * @param payerOverride - Payer when verify was skipped (cache-hit reconcile).
 * @returns Execution context or a terminal SettleResponse.
 */
async function buildCollectSettleExecution(
  signers: readonly FacilitatorEvmSigner[],
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureCollectPayload,
  payerOverride?: string,
): Promise<CollectSettleExecution | SettleResponse> {
  const parsed = parseAuthCaptureExtra(requirements.extra);
  if ("error" in parsed) {
    return {
      success: false,
      errorReason: parsed.error,
      transaction: "",
      network: requirements.network,
      payer: payerOverride ?? collectPayer(wirePayload),
    };
  }
  const extra = parsed.extra;
  const submitter = resolveSubmitter(signers, extra);
  if (!submitter) {
    return {
      success: false,
      errorReason: Errors.ErrOperatorNotAdmitted,
      transaction: "",
      network: requirements.network,
      payer: payerOverride ?? collectPayer(wirePayload),
    };
  }

  const payer = (payerOverride ?? collectPayer(wirePayload)) as `0x${string}`;
  const unpacked = unpackForSettle(wirePayload, extra.assetTransferMethod, extra.deployment);
  const originalMax = payload.accepted.amount;
  const paymentInfo = reconstructPaymentInfo(
    payer,
    unpacked.preApprovalExpiry,
    wirePayload.salt,
    { ...requirements, amount: originalMax },
    extra,
    originalMax,
  );

  const needsChargeCompletion = extra.paymentFlow === "authorization";
  const functionName = extra.paymentFlow === "authorization" ? "charge" : "authorize";
  let settleAmount = unpacked.amount;
  let fee = defaultSubmittedFee(extra, settleAmount);
  if (needsChargeCompletion) {
    settleAmount = BigInt(collectChargeAmount(wirePayload) ?? originalMax);
    const chargeFee = chargeFeeFromCollectPayload(extra, wirePayload as Record<string, unknown>);
    if (chargeFee) {
      fee = chargeFee;
    }
  }

  const chainId = getEvmChainId(requirements.network);
  const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo, extra.deployment.escrow);

  return {
    submitter,
    extra,
    payer,
    network: requirements.network,
    paymentInfo,
    paymentInfoHash,
    functionName,
    settleAmount,
    fee,
    tokenCollector: unpacked.tokenCollector,
  };
}

/**
 * Snapshot payment-token balances before a custom-operator collect broadcast.
 *
 * @param submitter - Facilitator submitter.
 * @param execution - Parsed collect execution context.
 * @returns Balance snapshot context or a terminal SettleResponse.
 */
async function snapshotCustomOperatorBalances(
  submitter: FacilitatorEvmSigner,
  execution: CollectSettleExecution,
): Promise<CollectBalanceCheck | SettleResponse | undefined> {
  if (execution.extra.operatorType !== "custom") {
    return undefined;
  }

  const { extra, payer, paymentInfo, functionName, fee } = execution;
  const facilitator = submitter.getAddresses()[0];
  if (!facilitator) {
    return {
      success: false,
      errorReason: Errors.ErrSimulationFailed,
      transaction: "",
      network: execution.network,
      payer,
    };
  }

  let tokenStore: `0x${string}`;
  try {
    tokenStore = (await submitter.readContract({
      address: extra.deployment.escrow,
      abi: ESCROW_VIEW_ABI,
      functionName: "getTokenStore",
      args: [extra.captureAuthorizer],
    })) as `0x${string}`;
  } catch {
    return {
      success: false,
      errorReason: Errors.ErrSimulationFailed,
      transaction: "",
      network: execution.network,
      payer,
    };
  }

  const before = await readCollectBalanceSnapshot(
    submitter,
    paymentInfo.token,
    payer,
    tokenStore,
    facilitator,
    functionName,
    paymentInfo.receiver,
    fee.feeReceiver,
  );
  if (!before) {
    return {
      success: false,
      errorReason: Errors.ErrSimulationFailed,
      transaction: "",
      network: execution.network,
      payer,
    };
  }

  return { before, tokenStore, facilitator };
}

/**
 * Re-verify and settle a collect payload.
 *
 * @param signers - Facilitator signer set.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Narrowed collect payload.
 * @param store - Pending-settlement store keyed by the collect signature.
 * @param context - Optional facilitator context for extension hooks.
 * @returns SettleResponse, including the settled amount.
 */
export async function settleCollect(
  signers: readonly FacilitatorEvmSigner[],
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureCollectPayload,
  store: PendingSettlementStore,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const pendingKey = wirePayload.signature;
  const payer = collectPayer(wirePayload);

  if (pendingKey) {
    const cachedTx = await store.get(pendingKey);
    if (cachedTx) {
      const execution = await buildCollectSettleExecution(
        signers,
        payload,
        requirements,
        wirePayload,
        payer,
      );
      if ("success" in execution) {
        return {
          success: false,
          errorReason: Errors.ErrSettlementPending,
          transaction: cachedTx,
          network: requirements.network,
          payer,
        };
      }
      await store.delete(pendingKey);
      return awaitCollectSettlement(
        store,
        pendingKey,
        cachedTx as `0x${string}`,
        execution,
        undefined,
        true,
      );
    }
  }

  const dataSuffix = await resolveDataSuffix(context, {
    paymentPayload: payload,
    paymentRequirements: requirements,
  });
  const verification = await verifyCollect(
    signers,
    config,
    payload,
    requirements,
    wirePayload,
    dataSuffix,
    true,
  );
  if (!verification.isValid) {
    return {
      success: false,
      errorReason: verification.invalidReason ?? Errors.ErrVerificationFailed,
      transaction: "",
      network: requirements.network,
      payer: verification.payer,
    };
  }

  const execution = await buildCollectSettleExecution(
    signers,
    payload,
    requirements,
    wirePayload,
    verification.payer,
  );
  if ("success" in execution) {
    return execution;
  }

  const customBalanceSnapshot = await snapshotCustomOperatorBalances(
    execution.submitter,
    execution,
  );
  if (customBalanceSnapshot && "success" in customBalanceSnapshot) {
    return customBalanceSnapshot;
  }

  const tuple = paymentInfoToContractTuple(execution.paymentInfo);
  const unpackedSettle = unpackForSettle(
    wirePayload,
    execution.extra.assetTransferMethod,
    execution.extra.deployment,
  );
  const args =
    execution.functionName === "charge"
      ? chargeEscrowArgs(
          tuple,
          execution.settleAmount,
          execution.tokenCollector,
          unpackedSettle.collectorData,
          execution.fee,
        )
      : ([
          tuple,
          execution.settleAmount,
          execution.tokenCollector,
          unpackedSettle.collectorData,
        ] as const);

  const settleTarget = resolveSettleTarget(execution.extra);
  const customGasLimit =
    execution.extra.operatorType === "custom"
      ? (config?.customOperatorAuthorizeGasLimit ?? DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT)
      : undefined;

  const written = await writeEscrowCall(
    execution.submitter,
    settleTarget,
    execution.functionName,
    args,
    execution.extra.deployment,
    {
      gas: customGasLimit,
      dataSuffix,
    },
  );
  if ("error" in written) {
    return {
      success: false,
      errorReason: written.error,
      transaction: "",
      network: requirements.network,
      payer: execution.payer,
    };
  }

  return awaitCollectSettlement(
    store,
    pendingKey,
    written.txHash,
    execution,
    customBalanceSnapshot,
    false,
  );
}

/**
 * Simulate authorize or charge against the resolved settle target.
 *
 * @param signer - Facilitator signer.
 * @param config - Facilitator config.
 * @param extra - Normalized extra.
 * @param paymentInfo - Reconstructed PaymentInfo.
 * @param amount - Amount to collect.
 * @param tokenCollector - Canonical collector for the asset-transfer method.
 * @param collectorData - Raw signature bytes.
 * @param fee - Submitted fee for charge (`feeBps` or `feeAmount` per deployment); ignored for authorize.
 * @param chainId - EVM chain id for paymentInfoHash.
 * @param dataSuffix - Optional settlement suffix appended to the simulated calldata.
 * @returns `"ok"` or a stable invalidReason.
 */
async function simulateCollect(
  signer: FacilitatorEvmSigner,
  config: AuthCaptureFacilitatorConfig | undefined,
  extra: NormalizedAuthCaptureExtra,
  paymentInfo: PaymentInfoStruct,
  amount: bigint,
  tokenCollector: `0x${string}`,
  collectorData: `0x${string}`,
  fee: SubmittedFee,
  chainId: number,
  dataSuffix?: `0x${string}`,
): Promise<"ok" | string> {
  const functionName = extra.paymentFlow === "authorization" ? "charge" : "authorize";
  const tuple = paymentInfoToContractTuple(paymentInfo);
  const args =
    functionName === "charge"
      ? chargeEscrowArgs(tuple, amount, tokenCollector, collectorData, fee)
      : ([tuple, amount, tokenCollector, collectorData] as const);

  if (extra.operatorType === "delegated") {
    // Delegated collect calls the escrow directly; eth_call success is sufficient preflight.
    const settleTarget = resolveSettleTarget(extra);
    return simulateEscrowCall(
      signer,
      settleTarget,
      functionName,
      args,
      extra.captureAuthorizer,
      extra.deployment,
    );
  }

  // Custom operators relay through captureAuthorizer — require eth_simulateV1 outcome checks.
  if (!signer.simulateCalls) {
    return Errors.ErrSimulationFailed;
  }

  const gasLimit =
    config?.customOperatorAuthorizeGasLimit ?? DEFAULT_CUSTOM_OPERATOR_AUTHORIZE_GAS_LIMIT;
  const facilitator = signer.getAddresses()[0]!;
  const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo, extra.deployment.escrow);
  const operator = extra.captureAuthorizer;
  const token = paymentInfo.token;
  const payer = paymentInfo.payer;
  const receiver = paymentInfo.receiver;
  const feeReceiver = fee.feeReceiver;
  const escrowAddress = extra.deployment.escrow;

  // Token store is CREATE2-predictable from the operator even before deployment.
  let tokenStore: `0x${string}`;
  try {
    tokenStore = (await signer.readContract({
      address: escrowAddress,
      abi: ESCROW_VIEW_ABI,
      functionName: "getTokenStore",
      args: [operator],
    })) as `0x${string}`;
  } catch {
    return Errors.ErrSimulationFailed;
  }

  const balanceCall = (account: `0x${string}`) =>
    ({
      to: token,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [account],
    }) as const;

  const paymentStateCall = () =>
    ({
      to: escrowAddress,
      abi: ESCROW_VIEW_ABI,
      functionName: "paymentState",
      args: [paymentInfoHash],
    }) as const;

  const preCalls = [
    paymentStateCall(),
    balanceCall(payer),
    balanceCall(tokenStore),
    balanceCall(facilitator),
    ...(functionName === "charge" ? [balanceCall(receiver), balanceCall(feeReceiver)] : []),
  ];

  const forwardedData = appendDataSuffix(
    encodeFunctionData({
      abi: escrowAbiWithErrorsForDeployment(extra.deployment),
      functionName,
      args: args as never,
    }),
    dataSuffix,
  );

  // One batch: snapshot pre-state, simulate the operator relay (gas-capped), then re-read deltas.
  const forwardedCall = {
    to: operator,
    data: forwardedData,
    gas: gasLimit,
  } as const;

  const postCalls = [
    paymentStateCall(),
    balanceCall(payer),
    balanceCall(tokenStore),
    balanceCall(facilitator),
    ...(functionName === "charge" ? [balanceCall(receiver), balanceCall(feeReceiver)] : []),
  ];

  const calls = [...preCalls, forwardedCall, ...postCalls];
  const forwardedIndex = preCalls.length;

  let results: Awaited<ReturnType<NonNullable<FacilitatorEvmSigner["simulateCalls"]>>>["results"];
  try {
    ({ results } = await signer.simulateCalls({ account: facilitator, calls }));
  } catch {
    return Errors.ErrSimulationFailed;
  }

  if (results.length !== calls.length) {
    return Errors.ErrSimulationFailed;
  }

  // Every view call in the batch must succeed so deltas are readable.
  for (let i = 0; i < results.length; i++) {
    if (i === forwardedIndex) continue;
    if (results[i]?.status !== "success") {
      return Errors.ErrSimulationFailed;
    }
  }

  const forwarded = results[forwardedIndex];
  if (!forwarded || forwarded.status !== "success") {
    return Errors.ErrSimulationFailed;
  }
  // Reject over-limit gas even when the call returns success under the sim cap.
  if (forwarded.gasUsed !== undefined && forwarded.gasUsed > gasLimit) {
    return Errors.ErrSimulationFailed;
  }

  // Top-level operator success is not enough — require a canonical escrow event
  // (operator-emitted logs are ignored by filtering on escrow address).
  const eventOk =
    functionName === "charge"
      ? verifyPaymentChargedEvent(forwarded.logs, extra.deployment, {
          paymentInfoHash,
          amount,
          tokenCollector,
          operator,
          fee,
        })
      : verifyPaymentAuthorizedEvent(forwarded.logs, escrowAddress, {
          paymentInfoHash,
          amount,
          tokenCollector,
          operator,
        });
  if (!eventOk) {
    return Errors.ErrSimulationFailed;
  }

  const preState = normalizePaymentState(results[0]?.result);
  const postState = normalizePaymentState(results[forwardedIndex + 1]?.result);
  // Payment must start uncollected; a non-zero pre-state means reuse or stale sim state.
  if (
    !preState ||
    !postState ||
    preState.hasCollectedPayment ||
    preState.capturableAmount !== 0n ||
    preState.refundableAmount !== 0n
  ) {
    return Errors.ErrSimulationFailed;
  }

  const readBalance = (index: number): bigint | undefined => {
    const result = results[index]?.result;
    if (result === undefined || result === null) return undefined;
    return BigInt(result as bigint | number | string);
  };

  const prePayer = readBalance(1);
  const preTokenStore = readBalance(2);
  const preFacilitator = readBalance(3);
  const postPayer = readBalance(forwardedIndex + 2);
  const postTokenStore = readBalance(forwardedIndex + 3);
  const postFacilitator = readBalance(forwardedIndex + 4);

  if (
    prePayer === undefined ||
    preTokenStore === undefined ||
    preFacilitator === undefined ||
    postPayer === undefined ||
    postTokenStore === undefined ||
    postFacilitator === undefined
  ) {
    return Errors.ErrSimulationFailed;
  }

  const beforeBalances: CollectBalanceSnapshot = {
    payer: prePayer,
    tokenStore: preTokenStore,
    facilitator: preFacilitator,
  };
  const afterBalances: CollectBalanceSnapshot = {
    payer: postPayer,
    tokenStore: postTokenStore,
    facilitator: postFacilitator,
  };
  if (functionName === "authorize") {
    // Authorize: escrow hold (capturable=amount); payer debited into the operator token store.
    if (
      !postState.hasCollectedPayment ||
      postState.capturableAmount !== amount ||
      postState.refundableAmount !== 0n ||
      !hasExpectedCollectBalanceChanges(beforeBalances, afterBalances, functionName, amount, fee)
    ) {
      return Errors.ErrSimulationFailed;
    }
    return "ok";
  }

  const preReceiver = readBalance(4);
  const preFeeReceiver = readBalance(5);
  const postReceiver = readBalance(forwardedIndex + 5);
  const postFeeReceiver = readBalance(forwardedIndex + 6);

  if (
    preReceiver === undefined ||
    preFeeReceiver === undefined ||
    postReceiver === undefined ||
    postFeeReceiver === undefined
  ) {
    return Errors.ErrSimulationFailed;
  }

  beforeBalances.receiver = preReceiver;
  beforeBalances.feeReceiver = preFeeReceiver;
  afterBalances.receiver = postReceiver;
  afterBalances.feeReceiver = postFeeReceiver;

  // Charge: payer debited, token store net zero, receiver/feeReceiver split matches _distributeTokens.
  if (
    !postState.hasCollectedPayment ||
    postState.capturableAmount !== 0n ||
    postState.refundableAmount !== amount ||
    !hasExpectedCollectBalanceChanges(beforeBalances, afterBalances, functionName, amount, fee)
  ) {
    return Errors.ErrSimulationFailed;
  }

  return "ok";
}

type CollectBalanceSnapshot = {
  payer: bigint;
  tokenStore: bigint;
  facilitator: bigint;
  receiver?: bigint;
  feeReceiver?: bigint;
};

/**
 * Read the payment-token balances used to verify a custom collect outcome.
 *
 * @param signer - Facilitator signer used for reads.
 * @param token - Payment token.
 * @param payer - Payer address.
 * @param tokenStore - Operator's escrow token store.
 * @param facilitator - Facilitator submitter address.
 * @param functionName - Collect operation.
 * @param receiver - Payment receiver.
 * @param feeReceiver - Charge fee recipient.
 * @returns A balance snapshot, or undefined when any read fails.
 */
async function readCollectBalanceSnapshot(
  signer: FacilitatorEvmSigner,
  token: `0x${string}`,
  payer: `0x${string}`,
  tokenStore: `0x${string}`,
  facilitator: `0x${string}`,
  functionName: "authorize" | "charge",
  receiver: `0x${string}`,
  feeReceiver: `0x${string}`,
): Promise<CollectBalanceSnapshot | undefined> {
  const readBalance = async (account: `0x${string}`): Promise<bigint> =>
    BigInt(
      (await signer.readContract({
        address: token,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [account],
        account: facilitator,
      })) as bigint | number | string,
    );

  try {
    const common = await Promise.all([
      readBalance(payer),
      readBalance(tokenStore),
      readBalance(facilitator),
    ]);
    if (functionName === "authorize") {
      return { payer: common[0], tokenStore: common[1], facilitator: common[2] };
    }
    const [receiverBalance, feeReceiverBalance] = await Promise.all([
      readBalance(receiver),
      readBalance(feeReceiver),
    ]);
    return {
      payer: common[0],
      tokenStore: common[1],
      facilitator: common[2],
      receiver: receiverBalance,
      feeReceiver: feeReceiverBalance,
    };
  } catch {
    return undefined;
  }
}

/**
 * Check actual payment-token balance changes against the simulated collect invariants.
 *
 * @param before - Balances immediately before submission.
 * @param after - Balances after the transaction confirms.
 * @param functionName - Collect operation.
 * @param amount - Settled amount.
 * @param fee - Submitted fee for charge (`feeBps` or `feeAmount` per deployment).
 * @returns True when all expected deltas match.
 */
function hasExpectedCollectBalanceChanges(
  before: CollectBalanceSnapshot,
  after: CollectBalanceSnapshot,
  functionName: "authorize" | "charge",
  amount: bigint,
  fee: SubmittedFee,
): boolean {
  if (after.facilitator < before.facilitator || after.payer !== before.payer - amount) {
    return false;
  }
  if (functionName === "authorize") {
    return after.tokenStore === before.tokenStore + amount;
  }
  if (
    before.receiver === undefined ||
    before.feeReceiver === undefined ||
    after.receiver === undefined ||
    after.feeReceiver === undefined
  ) {
    return false;
  }
  const feeAmount = submittedFeeAmount(fee, amount);
  return (
    after.tokenStore === before.tokenStore &&
    after.receiver === before.receiver + (amount - feeAmount) &&
    after.feeReceiver === before.feeReceiver + feeAmount
  );
}

/**
 * Filter receipt or simulation logs down to the canonical escrow address.
 *
 * @param logs - Logs from the forwarded call or mined receipt.
 * @param escrowAddress - Canonical AuthCaptureEscrow address.
 * @returns Logs emitted by the escrow.
 */
function escrowEventLogs(logs: readonly Log[] | undefined, escrowAddress: `0x${string}`): Log[] {
  return (logs ?? []).filter(log => isAddressEqual(log.address, escrowAddress));
}

/**
 * Whether logs contain a PaymentAuthorized event matching the expected collect.
 *
 * @param logs - Logs from the forwarded call or mined receipt.
 * @param escrowAddress - Canonical AuthCaptureEscrow address.
 * @param expected - Expected event fields.
 * @param expected.paymentInfoHash - Escrow payment identifier.
 * @param expected.amount - Authorized amount.
 * @param expected.tokenCollector - Collector used for the collect.
 * @param expected.operator - PaymentInfo.operator.
 * @returns True when a matching event is present.
 */
function verifyPaymentAuthorizedEvent(
  logs: readonly Log[] | undefined,
  escrowAddress: `0x${string}`,
  expected: {
    paymentInfoHash: `0x${string}`;
    amount: bigint;
    tokenCollector: `0x${string}`;
    operator: `0x${string}`;
  },
): boolean {
  const parsed = parseEventLogs({
    abi: escrowEventsAbiForDeployment(AUTH_CAPTURE_DEPLOYMENT_V1_1),
    eventName: "PaymentAuthorized",
    logs: escrowEventLogs(logs, escrowAddress),
  });
  return parsed.some(
    event =>
      event.args.paymentInfoHash?.toLowerCase() === expected.paymentInfoHash.toLowerCase() &&
      event.args.amount === expected.amount &&
      isAddressEqual(event.args.tokenCollector, expected.tokenCollector) &&
      isAddressEqual(event.args.paymentInfo.operator, expected.operator),
  );
}

/**
 * Whether logs contain a PaymentCharged event matching the expected collect.
 *
 * @param logs - Logs from the forwarded call or mined receipt.
 * @param deployment - Resolved AuthCaptureEscrow deployment.
 * @param expected - Expected event fields.
 * @param expected.paymentInfoHash - Escrow payment identifier.
 * @param expected.amount - Charged amount.
 * @param expected.tokenCollector - Collector used for the collect.
 * @param expected.operator - PaymentInfo.operator.
 * @param expected.fee - Submitted fee (`feeBps` or `feeAmount` per deployment).
 * @returns True when a matching event is present.
 */
function verifyPaymentChargedEvent(
  logs: readonly Log[] | undefined,
  deployment: AuthCaptureDeployment,
  expected: {
    paymentInfoHash: `0x${string}`;
    amount: bigint;
    tokenCollector: `0x${string}`;
    operator: `0x${string}`;
    fee: SubmittedFee;
  },
): boolean {
  const parsed = parseEventLogs({
    abi: escrowEventsAbiForDeployment(deployment),
    eventName: "PaymentCharged",
    logs: escrowEventLogs(logs, deployment.escrow),
  });
  return parsed.some(event => {
    const eventArgs = event.args as {
      paymentInfoHash?: `0x${string}`;
      amount?: bigint;
      tokenCollector?: `0x${string}`;
      paymentInfo?: { operator?: `0x${string}` };
      feeReceiver?: `0x${string}`;
      feeBps?: number;
      feeAmount?: bigint;
    };
    const feeMatches =
      expected.fee.version === "v1.0"
        ? eventArgs.feeBps === expected.fee.feeBps
        : eventArgs.feeAmount === BigInt(expected.fee.feeAmount);
    return (
      eventArgs.paymentInfoHash?.toLowerCase() === expected.paymentInfoHash.toLowerCase() &&
      eventArgs.amount === expected.amount &&
      eventArgs.tokenCollector !== undefined &&
      isAddressEqual(eventArgs.tokenCollector, expected.tokenCollector) &&
      eventArgs.paymentInfo?.operator !== undefined &&
      isAddressEqual(eventArgs.paymentInfo.operator, expected.operator) &&
      feeMatches &&
      eventArgs.feeReceiver !== undefined &&
      isAddressEqual(eventArgs.feeReceiver, expected.fee.feeReceiver)
    );
  });
}
