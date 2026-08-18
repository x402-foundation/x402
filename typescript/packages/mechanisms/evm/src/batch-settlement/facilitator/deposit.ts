import {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
} from "@x402/core/types";
import { getAddress, parseErc6492Signature, isAddressEqual } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import type { Erc20ApprovalGasSponsoringSigner } from "../../exact/extensions";
import { BatchSettlementAssetTransferMethod, BatchSettlementDepositPayload } from "../types";
import { batchSettlementABI, erc20BalanceOfABI } from "../abi";
import {
  BATCH_SETTLEMENT_ADDRESS,
  CHANNEL_STATE_POLL_MS,
  CHANNEL_STATE_POLL_INTERVAL_MS,
} from "../constants";
import { finalHashFromTwoRequestSend, getEvmChainId, truncateErrorMessage } from "../../utils";
import { multicall } from "../../multicall";
import * as Errors from "../errors";
import { ErrSettlementPending } from "../../exact/facilitator/errors";
import { waitAndReturnSettleResponse } from "../../shared/settleReceipt";
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
  type Erc3009CounterfactualDeployment,
} from "./deposit-eip3009";
import {
  buildDepositTransaction,
  getPermit2DepositCollectorAddress,
  resolvePermit2DepositBranch,
  verifyPermit2DepositAuthorization,
} from "./deposit-permit2";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses for counterfactual deposits.
 * @returns A {@link VerifyResponse} with channel state in `extra` on success.
 */
export async function verifyDeposit(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
  allowedFactories: string[] = [],
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

  // erc3009Counterfactual is non-null when the ERC-3009 deposit is from an undeployed
  // ERC-6492 wallet with an allowlisted factory; its inner signature is validated by the
  // deploy+deposit simulation below rather than a direct (no-code) signature check.
  let erc3009Counterfactual: Erc3009CounterfactualDeployment | null = null;
  if (transferMethod === "permit2") {
    const methodErr = await verifyPermit2DepositAuthorization(
      signer,
      payment,
      payload,
      requirements,
      chainId,
      context,
    );
    if (methodErr) {
      return methodErr;
    }
  } else {
    const result = await verifyEip3009DepositAuthorization(
      signer,
      payload,
      requirements,
      chainId,
      allowedFactories,
    );
    if (result.response) {
      return result.response;
    }
    erc3009Counterfactual = result.counterfactual;
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

  if (erc3009Counterfactual) {
    // Counterfactual ERC-6492 wallet: the payer has no code yet, so a plain deposit()
    // eth_call would revert (no code → isValidSignature reverts). Simulate factory-deploy +
    // deposit atomically in one Multicall3 eth_call so the inner signature is validated
    // against the just-deployed wallet — mirroring how settle deploys then deposits.
    const simulationSucceeded = await simulateCounterfactualErc3009Deposit(
      signer,
      erc3009Counterfactual,
      payload,
      depositAmount,
      execution,
    );
    if (!simulationSucceeded) {
      return { isValid: false, invalidReason: Errors.ErrDepositSimulationFailed, payer };
    }
  } else if (!execution.skipDirectSimulation) {
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
 * @param dataSuffix - Optional hex suffix appended to the deposit transaction.
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses for counterfactual deposits.
 * @returns A {@link SettleResponse} with the transaction hash and updated channel state in `extra`.
 */
export async function settleDeposit(
  signer: FacilitatorEvmSigner,
  payment: PaymentPayload,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
  dataSuffix?: `0x${string}`,
  allowedFactories: string[] = [],
): Promise<SettleResponse> {
  const { deposit, voucher } = payload;
  const config = payload.channelConfig;
  const payer = config.payer;

  const verified = await verifyDeposit(
    signer,
    payment,
    payload,
    requirements,
    context,
    allowedFactories,
  );
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

    // ERC-6492 counterfactual deposit: deploy the undeployed wallet (gated by the factory
    // allowlist) before the deposit, then simulate with the inner signature to catch wallets
    // whose validator is installed lazily.
    if (resolveDepositTransferMethod(payload, requirements) === "eip3009") {
      const deployErr = await deployErc3009CounterfactualIfNeeded(
        signer,
        payload,
        requirements,
        allowedFactories,
      );
      if (deployErr) {
        return deployErr;
      }
    }

    const depositTx = buildDepositTransaction(payload, execution.collectorData, dataSuffix);

    let tx: `0x${string}`;
    let receiptSigner: FacilitatorEvmSigner;
    // A single hash from the two-request (approve + deposit) send means the signer bundled
    // them atomically, but a non-conforming signer could return one hash after broadcasting
    // only the approve. Its receipt then proves some transaction didn't revert, not that the
    // deposit ran, so success requires the balance check below.
    let unconfirmedBundleHash = false;
    if (execution.kind === "erc20Approval") {
      const txHashes = await execution.extensionSigner.sendTransactions([
        execution.signedTransaction,
        depositTx,
      ]);
      const finalHash = finalHashFromTwoRequestSend(txHashes);
      if (finalHash === undefined) {
        throw new Error(
          `expected 1 (atomic bundle) or 2 (sequential) tx hashes from extension signer, got ${txHashes.length}`,
        );
      }
      tx = finalHash;
      receiptSigner = execution.extensionSigner;
      unconfirmedBundleHash = txHashes.length === 1;
    } else {
      tx = await signer.writeContract({
        address: getAddress(BATCH_SETTLEMENT_ADDRESS),
        abi: batchSettlementABI,
        functionName: "deposit",
        args: [
          toContractChannelConfig(config),
          BigInt(deposit.amount),
          execution.collector,
          execution.collectorData,
        ],
        dataSuffix,
      });
      receiptSigner = signer;
    }

    return await waitAndReturnSettleResponse(receiptSigner, tx, requirements.network, payer, {
      failedStatusReason: Errors.ErrDepositTransactionFailed,
      onSuccess: async () => {
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

        // Poll until RPC reflects the confirmed deposit so later verify reads see this balance.
        const expectedMinBalance = BigInt(optimisticExtra.channelState.balance);
        const rpcDeadline = Date.now() + CHANNEL_STATE_POLL_MS;
        let balanceConfirmed = false;
        // Set only when a read succeeds and shows the deposit missing, as opposed to a read
        // that failed outright and leaves the balance unknown.
        let balanceReadWithoutConfirmation = false;
        try {
          let postState = await readChannelState(signer, voucher.channelId);
          while (postState.balance < expectedMinBalance && Date.now() < rpcDeadline) {
            await new Promise(resolve => setTimeout(resolve, CHANNEL_STATE_POLL_INTERVAL_MS));
            postState = await readChannelState(signer, voucher.channelId);
          }

          if (postState.balance >= expectedMinBalance) {
            balanceConfirmed = true;
            optimisticExtra.channelState = {
              channelId: voucher.channelId,
              balance: postState.balance.toString(),
              totalClaimed: postState.totalClaimed.toString(),
              withdrawRequestedAt: postState.withdrawRequestedAt,
              refundNonce: postState.refundNonce.toString(),
            };
          } else {
            balanceReadWithoutConfirmation = true;
          }
        } catch {
          // Keep optimistic channel state when post-deposit reads fail.
        }

        if (unconfirmedBundleHash && !balanceConfirmed) {
          // A read showing the deposit missing is terminal; a failed read leaves it
          // unconfirmed, so report settlement_pending for the caller to reconcile.
          return balanceReadWithoutConfirmation
            ? {
                success: false,
                errorReason: Errors.ErrDepositTransactionFailed,
                errorMessage:
                  "extension signer returned a single transaction hash for the erc20 approval + " +
                  "deposit bundle, but the resulting channel balance does not reflect the deposit",
                transaction: tx,
                network: requirements.network,
                payer,
              }
            : {
                success: false,
                errorReason: ErrSettlementPending,
                errorMessage:
                  "extension signer returned a single transaction hash for the erc20 approval + " +
                  "deposit bundle and the post-deposit balance read failed, so the deposit could not be confirmed",
                transaction: tx,
                network: requirements.network,
                payer,
              };
        }

        return {
          success: true,
          transaction: tx,
          network: requirements.network,
          payer,
          amount: deposit.amount,
          extra: optimisticExtra,
        };
      },
    });
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrDepositTransactionFailed,
      errorMessage: truncateErrorMessage(e instanceof Error ? e.message : String(e)),
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
      skipDirectSimulation?: boolean;
    }
  | {
      kind: "erc20Approval";
      collector: `0x${string}`;
      collectorData: `0x${string}`;
      signedTransaction: `0x${string}`;
      extensionSigner: Erc20ApprovalGasSponsoringSigner;
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
    // collectorData carries the inner signature (ERC-6492 wrapper stripped). For a deployed
    // wallet the direct deposit() simulation routes to ERC-1271; for an undeployed
    // counterfactual wallet verifyDeposit runs the deploy+deposit Multicall3 simulation
    // instead (see simulateCounterfactualErc3009Deposit).
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
 * Simulates the factory deploy + deposit atomically via a single Multicall3 eth_call.
 *
 * The deposit succeeds only if, after the wallet is deployed in the first sub-call, its
 * isValidSignature accepts the inner ERC-3009 signature carried by the (already-stripped)
 * collector data. Mirrors the Go/Python `simulateCounterfactualErc3009Deposit`.
 *
 * @param signer - Facilitator signer used for the Multicall3 read.
 * @param counterfactual - Factory + calldata for the undeployed ERC-6492 wallet.
 * @param payload - Batch deposit payload (provides the channel config).
 * @param depositAmount - Deposit amount in token base units.
 * @param execution - Resolved deposit execution details.
 * @param execution.collector - Collector contract the deposit routes through.
 * @param execution.collectorData - ABI-encoded collector data carrying the inner signature.
 * @returns True when the deposit sub-call would succeed against the just-deployed wallet.
 */
async function simulateCounterfactualErc3009Deposit(
  signer: FacilitatorEvmSigner,
  counterfactual: Erc3009CounterfactualDeployment,
  payload: BatchSettlementDepositPayload,
  depositAmount: bigint,
  execution: { collector: `0x${string}`; collectorData: `0x${string}` },
): Promise<boolean> {
  const results = await multicall(signer.readContract.bind(signer), [
    {
      address: counterfactual.factory,
      callData: counterfactual.factoryCalldata,
    },
    {
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName: "deposit",
      args: [
        toContractChannelConfig(payload.channelConfig),
        depositAmount,
        execution.collector,
        execution.collectorData,
      ],
    },
  ]);
  return results.length >= 2 && results[1].status === "success";
}

/**
 * Deploys an undeployed ERC-6492 wallet before an ERC-3009 deposit.
 *
 * Returns null when no deployment is needed (caller proceeds to deposit), or a terminal
 * {@link SettleResponse} when the factory is disallowed, the deploy reverts, or the deployed
 * wallet rejects the inner signature.
 *
 * @param signer - Facilitator signer used to deploy the wallet and simulate the deposit.
 * @param payload - Batch deposit payload carrying the ERC-6492-wrapped authorization.
 * @param requirements - Server payment requirements (used for the network in error responses).
 * @param allowedFactories - Allowlisted ERC-6492 factory addresses.
 * @returns A terminal {@link SettleResponse} on failure, or null to proceed with the deposit.
 */
async function deployErc3009CounterfactualIfNeeded(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  allowedFactories: string[],
): Promise<SettleResponse | null> {
  const config = payload.channelConfig;
  const payer = config.payer;
  const auth = payload.deposit.authorization.erc3009Authorization;
  if (!auth) {
    return null;
  }

  const { address: factory, data: factoryCalldata } = parseErc6492Signature(auth.signature);
  const hasDeploymentInfo = !!(
    factory &&
    factoryCalldata &&
    !isAddressEqual(factory, ZERO_ADDRESS)
  );
  if (!hasDeploymentInfo) {
    return null;
  }

  let code: `0x${string}` | undefined;
  try {
    code = await signer.getCode({ address: payer });
  } catch {
    code = undefined;
  }
  if (code && code !== "0x") {
    // Already deployed — nothing to do; proceed with the standard deposit.
    return null;
  }

  const normalizedFactory = factory.toLowerCase();
  if (!allowedFactories.some(a => a.trim().toLowerCase() === normalizedFactory)) {
    return {
      success: false,
      errorReason: Errors.ErrFactoryNotAllowed,
      errorMessage: "factory not in eip6492AllowedFactories allowlist",
      transaction: "",
      network: requirements.network,
      payer,
    };
  }

  const deployTx = await signer.sendTransaction({
    to: factory,
    data: factoryCalldata as `0x${string}`,
  });
  const deployReceipt = await signer.waitForTransactionReceipt({ hash: deployTx });
  if (deployReceipt.status !== "success") {
    return {
      success: false,
      errorReason: Errors.ErrSmartWalletDeploymentFailed,
      transaction: "",
      network: requirements.network,
      payer,
    };
  }

  return null;
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
