import {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import type { TransactionRequest } from "../../exact/extensions";
import { BatchSettlementAssetTransferMethod, BatchSettlementDepositPayload } from "../types";
import { batchSettlementABI, erc20BalanceOfABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import { getEvmChainId } from "../../utils";
import { multicall } from "../../multicall";
import * as Errors from "../errors";
import {
  readChannelState,
  toContractChannelConfig,
  validateChannelConfig,
  verifyBatchSettlementVoucherTypedData,
} from "./utils";
import {
  buildEip3009DepositCollectorData,
  getEip3009DepositCollectorAddress,
  verifyEip3009DepositAuthorization,
} from "./deposit-eip3009";
import {
  buildDepositTransaction,
  getPermit2DepositCollectorAddress,
  resolvePermit2DepositBranch,
  verifyPermit2DepositAuthorization,
} from "./deposit-permit2";

/**
 * Verifies a deposit payload (authorization + voucher) without executing any
 * onchain transaction.
 *
 * Performs the following validations:
 * - Token in channelConfig matches the payment requirements asset.
 * - Deposit authorization is valid for the selected transfer method.
 * - Accompanying voucher signature is valid (ECDSA or ERC-1271).
 * - Payer has sufficient token balance for the deposit.
 * - Resulting `maxClaimableAmount` does not exceed effective balance (existing + deposit).
 *
 * @param signer - Facilitator signer for onchain reads and signature verification.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - The full deposit payload including channelConfig, amount, authorization, and voucher.
 * @param requirements - Server payment requirements (asset, EIP-712 domain info, timeout, etc.).
 * @param context - Optional facilitator extension context.
 * @returns A {@link VerifyResponse} with channel state in `extra` on success.
 */
export async function verifyDeposit(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<VerifyResponse> {
  const payer = payload.channelConfig.payer;
  const chainId = getEvmChainId(requirements.network);
  const configErr = validateChannelConfig(
    payload.channelConfig,
    payload.voucher.channelId,
    requirements,
  );
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer };
  }

  const transferMethod = resolveDepositTransferMethod(payload, requirements);
  if (transferMethod === "permit2" && !payload.deposit.authorization.permit2Authorization) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType, payer };
  }

  const methodErr =
    transferMethod === "permit2"
      ? await verifyPermit2DepositAuthorization(
          signer,
          payment,
          payload,
          requirements,
          chainId,
          context,
        )
      : await verifyEip3009DepositAuthorization(signer, payload, requirements, chainId);

  if (methodErr) {
    return methodErr;
  }

  const shared = await verifySharedDepositState(signer, payload, requirements);
  if (!shared.ok) {
    return shared.response;
  }

  const { depositAmount, chBalance, chTotalClaimed, wdInitiatedAt, refundNonceVal } = shared;

  const execution = await resolveDepositExecution(signer, payment, payload, requirements, context);
  if ("isValid" in execution) {
    return execution;
  }

  if (!execution.skipDirectSimulation) {
    try {
      await signer.readContract({
        address: getAddress(BATCH_SETTLEMENT_ADDRESS),
        abi: batchSettlementABI,
        functionName: "deposit",
        args: [
          toContractChannelConfig(payload.channelConfig),
          depositAmount,
          execution.collector,
          execution.collectorData,
        ],
      });
    } catch (e) {
      return {
        isValid: false,
        invalidReason: Errors.ErrDepositSimulationFailed,
        invalidMessage: e instanceof Error ? e.message : String(e),
        payer,
      };
    }
  }

  return {
    isValid: true,
    payer,
    extra: {
      channelId: payload.voucher.channelId,
      balance: chBalance.toString(),
      totalClaimed: chTotalClaimed.toString(),
      withdrawRequestedAt: Number(wdInitiatedAt),
      refundNonce: refundNonceVal.toString(),
    },
  };
}

/**
 * Verifies channel, voucher, balance, and cumulative amount invariants.
 *
 * @param signer - Facilitator signer for reads and voucher verification.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @returns Shared channel state on success, or a verification failure.
 */
async function verifySharedDepositState(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): Promise<
  | {
      ok: true;
      chainId: number;
      depositAmount: bigint;
      payer: `0x${string}`;
      chBalance: bigint;
      chTotalClaimed: bigint;
      wdInitiatedAt: bigint;
      refundNonceVal: bigint;
    }
  | { ok: false; response: VerifyResponse }
> {
  const { deposit, voucher } = payload;
  const config = payload.channelConfig;
  const payer = config.payer;
  const chainId = getEvmChainId(requirements.network);

  const configErr = validateChannelConfig(config, voucher.channelId, requirements);
  if (configErr) {
    return { ok: false, response: { isValid: false, invalidReason: configErr, payer } };
  }

  const voucherOk = await verifyBatchSettlementVoucherTypedData(
    signer,
    {
      channelId: voucher.channelId,
      maxClaimableAmount: voucher.maxClaimableAmount,
      payerAuthorizer: config.payerAuthorizer,
      payer: config.payer,
      signature: voucher.signature,
    },
    chainId,
  );
  if (!voucherOk) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrInvalidVoucherSignature, payer },
    };
  }

  const mcResults = await multicall(signer.readContract.bind(signer), [
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "channels",
      args: [voucher.channelId],
    },
    {
      address: getAddress(requirements.asset),
      abi: erc20BalanceOfABI,
      functionName: "balanceOf",
      args: [getAddress(payer)],
    },
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "pendingWithdrawals",
      args: [voucher.channelId],
    },
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "refundNonce",
      args: [voucher.channelId],
    },
  ]);

  const [chRes, balRes, wdRes, rnRes] = mcResults;
  if (
    chRes.status === "failure" ||
    balRes.status === "failure" ||
    wdRes.status === "failure" ||
    rnRes.status === "failure"
  ) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrRpcReadFailed, payer },
    };
  }

  const [chBalance, chTotalClaimed] = chRes.result as [bigint, bigint];
  const payerBalance = balRes.result as bigint;
  const [, wdInitiatedAt] = wdRes.result as [bigint, bigint];
  const refundNonceVal = rnRes.result as bigint;
  const depositAmount = BigInt(deposit.amount);

  if (payerBalance < depositAmount) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrInsufficientBalance, payer },
    };
  }

  const effectiveBalance = chBalance + depositAmount;
  const maxClaimableAmount = BigInt(voucher.maxClaimableAmount);

  if (maxClaimableAmount > effectiveBalance) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrCumulativeExceedsBalance, payer },
    };
  }

  if (maxClaimableAmount <= chTotalClaimed) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: Errors.ErrCumulativeAmountBelowClaimed, payer },
    };
  }

  return {
    ok: true,
    chainId,
    depositAmount,
    payer,
    chBalance,
    chTotalClaimed,
    wdInitiatedAt,
    refundNonceVal,
  };
}

/**
 * Executes a deposit onchain through the collector for the selected transfer method.
 *
 * The deposit is first verified via {@link verifyDeposit}; if invalid the returned
 * {@link SettleResponse} will have `success: false` with the verification reason.
 *
 * @param signer - Facilitator signer used to submit the onchain transaction.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - The deposit payload (channelConfig, amount, authorization, voucher).
 * @param requirements - Server payment requirements.
 * @param context - Optional facilitator extension context.
 * @returns A {@link SettleResponse} with the transaction hash and updated channel state in `extra`.
 */
export async function settleDeposit(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const { deposit, voucher } = payload;
  const config = payload.channelConfig;
  const payer = config.payer;

  const verified = await verifyDeposit(signer, payment, payload, requirements, context);
  if (!verified.isValid) {
    const reason = verified.invalidReason ?? Errors.ErrInvalidPayloadType;
    return {
      success: false,
      errorReason: reason,
      errorMessage: verified.invalidMessage ?? reason,
      transaction: "",
      network: requirements.network,
      payer: verified.payer,
    };
  }

  try {
    const execution = await resolveDepositExecution(
      signer,
      payment,
      payload,
      requirements,
      context,
    );
    if ("isValid" in execution) {
      const reason = execution.invalidReason ?? Errors.ErrInvalidPayloadType;
      return {
        success: false,
        errorReason: reason,
        errorMessage: execution.invalidMessage ?? reason,
        transaction: "",
        network: requirements.network,
        payer: execution.payer,
      };
    }

    const depositTx = buildDepositTransaction(payload, execution.collectorData);
    const tx =
      execution.kind === "erc20Approval"
        ? (
            await execution.extensionSigner.sendTransactions([
              execution.signedTransaction,
              depositTx,
            ])
          )[1]
        : await signer.writeContract({
            address: getAddress(BATCH_SETTLEMENT_ADDRESS),
            abi: batchSettlementABI,
            functionName: "deposit",
            args: [
              toContractChannelConfig(config),
              BigInt(deposit.amount),
              execution.collector,
              execution.collectorData,
            ],
          });

    const receipt = await signer.waitForTransactionReceipt({ hash: tx });

    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: Errors.ErrDepositTransactionFailed,
        errorMessage: `transaction reverted (receipt status ${receipt.status})`,
        transaction: tx,
        network: requirements.network,
        payer,
      };
    }

    const optimisticExtra = {
      channelState: {
        channelId: voucher.channelId,
        balance: (
          BigInt(String(verified.extra?.balance ?? "0")) + BigInt(deposit.amount)
        ).toString(),
        totalClaimed: String(verified.extra?.totalClaimed ?? "0"),
        withdrawRequestedAt: Number(verified.extra?.withdrawRequestedAt ?? 0),
        refundNonce: String(verified.extra?.refundNonce ?? "0"),
      },
    };

    // Poll the RPC until it reflects the just-confirmed deposit, so subsequent verify reads are guaranteed to see this balance
    const expectedMinBalance = BigInt(optimisticExtra.channelState.balance);
    const rpcDeadline = Date.now() + 2_000;
    let postState = await readChannelState(signer, voucher.channelId);
    while (postState.balance < expectedMinBalance && Date.now() < rpcDeadline) {
      await new Promise(resolve => setTimeout(resolve, 150));
      postState = await readChannelState(signer, voucher.channelId);
    }

    const rpcCaughtUp = postState.balance >= expectedMinBalance;

    return {
      success: true,
      transaction: tx,
      network: requirements.network,
      payer,
      amount: deposit.amount,
      extra: rpcCaughtUp
        ? {
            ...optimisticExtra,
            channelState: {
              channelId: voucher.channelId,
              balance: postState.balance.toString(),
              totalClaimed: postState.totalClaimed.toString(),
              withdrawRequestedAt: postState.withdrawRequestedAt,
              refundNonce: postState.refundNonce.toString(),
            },
          }
        : optimisticExtra,
    };
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrDepositTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network: requirements.network,
      payer,
    };
  }
}

type DepositExecution =
  | {
      kind: "direct";
      collector: `0x${string}`;
      collectorData: `0x${string}`;
      skipDirectSimulation?: false;
    }
  | {
      kind: "erc20Approval";
      collector: `0x${string}`;
      collectorData: `0x${string}`;
      signedTransaction: `0x${string}`;
      extensionSigner: {
        sendTransactions(transactions: TransactionRequest[]): Promise<`0x${string}`[]>;
      };
      skipDirectSimulation: true;
    };

/**
 * Resolves the collector address and collector data for a deposit payload.
 *
 * @param signer - Facilitator signer for Permit2 allowance reads.
 * @param payment - Full payment envelope containing optional extensions.
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @param context - Optional facilitator extension context.
 * @returns Execution details, or a verification failure response.
 */
async function resolveDepositExecution(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<DepositExecution | VerifyResponse> {
  const transferMethod = resolveDepositTransferMethod(payload, requirements);
  if (transferMethod === "eip3009") {
    return {
      kind: "direct",
      collector: getEip3009DepositCollectorAddress(),
      collectorData: buildEip3009DepositCollectorData(payload),
    };
  }

  const branch = await resolvePermit2DepositBranch(signer, payment, payload, requirements, context);
  if ("isValid" in branch) {
    return branch;
  }

  if (branch.kind === "erc20Approval") {
    return {
      kind: "erc20Approval",
      collector: getPermit2DepositCollectorAddress(),
      collectorData: branch.collectorData,
      signedTransaction: branch.signedTransaction,
      extensionSigner: branch.extensionSigner,
      skipDirectSimulation: true,
    };
  }

  return {
    kind: "direct",
    collector: getPermit2DepositCollectorAddress(),
    collectorData: branch.collectorData,
  };
}

/**
 * Selects the transfer method from requirements, falling back to payload shape.
 *
 * @param payload - Batch deposit payload.
 * @param requirements - Payment requirements for the request.
 * @returns Selected batch-settlement transfer method.
 */
function resolveDepositTransferMethod(
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
): BatchSettlementAssetTransferMethod {
  const hinted = (
    requirements.extra as { assetTransferMethod?: BatchSettlementAssetTransferMethod }
  )?.assetTransferMethod;
  if (hinted) {
    return hinted;
  }
  return payload.deposit.authorization.permit2Authorization ? "permit2" : "eip3009";
}
