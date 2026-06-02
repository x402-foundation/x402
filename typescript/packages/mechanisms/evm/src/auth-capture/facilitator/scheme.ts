/**
 * AuthCapture Scheme - Facilitator
 * Handles verification and settlement of auth-capture payments.
 *
 * Implements x402's SchemeNetworkFacilitator interface so the auth-capture scheme
 * is a drop-in for the x402 facilitator, just like ExactEvmScheme.
 *
 * The facilitator is captureAuthorizer-agnostic: capture-authorizer addresses are
 * set by the merchant and arrive in `requirements.extra` at verify/settle time.
 * Escrow + token-collector addresses are universal constants and never come from
 * the wire format.
 */

import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorEvmSigner } from "../../signer";
import { BaseError, ContractFunctionRevertedError, hexToBigInt, parseErc6492Signature } from "viem";
import { ERC20_BALANCE_OF_ABI, ESCROW_ABI, ESCROW_ERRORS_ABI } from "../abi";
import {
  AUTH_CAPTURE_ESCROW_ADDRESS,
  AUTH_CAPTURE_SCHEME,
  EIP3009_TOKEN_COLLECTOR_ADDRESS,
  PERMIT2_TOKEN_COLLECTOR_ADDRESS,
} from "../constants";
import {
  ESCROW_ERROR_TO_INVALID_REASON,
  ErrAmountMismatch,
  ErrAuthorizationExpired,
  ErrAuthorizationNotYetValid,
  ErrCaptureDeadlineExpired,
  ErrInsufficientBalance,
  ErrInvalidAuthCaptureExtra,
  ErrInvalidAuthCaptureSignature,
  ErrInvalidDeadlineOrdering,
  ErrInvalidNetwork,
  ErrInvalidPayloadFormat,
  ErrNetworkMismatch,
  ErrNonceMismatch,
  ErrPayloadMethodMismatch,
  ErrSimulationFailed,
  ErrTokenCollectorMismatch,
  ErrTokenMismatch,
  ErrTransactionReverted,
  ErrUnsupportedAssetTransferMethod,
  ErrUnsupportedScheme,
  ErrVerificationFailed,
} from "./errors";
import {
  computePayerAgnosticPaymentInfoHash,
  verifyERC3009Signature,
  verifyPermit2Signature,
} from "../nonce";
import {
  isAuthCaptureExtra,
  isAuthCapturePayload,
  isEip3009Payload,
  isPermit2Payload,
} from "../types";
import type {
  AuthCaptureExtra,
  AuthCapturePayload,
  Eip3009Payload,
  PaymentInfoStruct,
  Permit2Payload,
} from "../types";
import { parseChainId } from "../utils";

/**
 * Reconstruct the on-chain PaymentInfo struct from the inputs the facilitator
 * has after verifying a wire payload. Wire-only inputs: `payer` and `salt`
 * (both from the payload). `preApprovalExpiry` is computed by the caller from
 * the payload (ERC-3009 `validBefore` or Permit2 `deadline`). The remaining
 * fields come from `requirements` (receiver/token/maxAmount) and
 * `requirements.extra` (capture/refund deadlines, fee policy, captureAuthorizer).
 *
 * @param payer - Address recovered from the wire payload's signature.
 * @param preApprovalExpiry - Pre-approval expiry in Unix seconds (from the wire payload).
 * @param salt - 32-byte salt from the wire payload.
 * @param requirements - The payment requirements published by the server.
 * @param extra - The validated `AuthCaptureExtra` subset of `requirements.extra`.
 * @returns A PaymentInfo struct ready to hand to the escrow contract.
 */
function reconstructPaymentInfo(
  payer: `0x${string}`,
  preApprovalExpiry: number,
  salt: `0x${string}`,
  requirements: PaymentRequirements,
  extra: AuthCaptureExtra,
): PaymentInfoStruct {
  return {
    operator: extra.captureAuthorizer,
    payer,
    receiver: requirements.payTo as `0x${string}`,
    token: requirements.asset as `0x${string}`,
    maxAmount: requirements.amount,
    preApprovalExpiry,
    authorizationExpiry: extra.captureDeadline,
    refundExpiry: extra.refundDeadline,
    minFeeBps: extra.minFeeBps,
    maxFeeBps: extra.maxFeeBps,
    feeReceiver: extra.feeRecipient,
    salt,
  };
}

/**
 * Convert a JS-side PaymentInfo struct (string `maxAmount` and `salt`) into
 * the bigint-typed form viem expects when encoding the on-chain tuple.
 *
 * @param p - PaymentInfo with string-form numeric fields.
 * @returns The same struct with `maxAmount` and `salt` coerced to bigint.
 */
function paymentInfoToContractTuple(p: PaymentInfoStruct) {
  return { ...p, maxAmount: BigInt(p.maxAmount), salt: BigInt(p.salt) };
}

/**
 * AuthCapture Facilitator Scheme - implements x402's SchemeNetworkFacilitator.
 *
 * Settle dispatch:
 *  - extra.autoCapture === true  → escrow.charge() (single-shot, funds direct to receiver)
 *  - extra.autoCapture !== true  → escrow.authorize() (two-phase; captureAuthorizer captures later)
 *
 * Asset-transfer dispatch (extra.assetTransferMethod):
 *  - 'eip3009' (default) → ERC-3009 ReceiveWithAuthorization, EIP3009_TOKEN_COLLECTOR
 *  - 'permit2'           → Permit2 PermitTransferFrom, PERMIT2_TOKEN_COLLECTOR
 */
export class AuthCaptureEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  readonly caipFamily = "eip155:*";

  /**
   * Construct a facilitator-side auth-capture scheme bound to a specific signer.
   *
   * @param signer - Facilitator signer with on-chain read + write capability.
   */
  constructor(private signer: FacilitatorEvmSigner) {}

  /**
   * Return the EOA address(es) this facilitator submits transactions from.
   * Advertised via `/supported` so merchants can decide whether to set
   * `extra.captureAuthorizer = facilitator-EOA` for the EOA-captureAuthorizer
   * path.
   *
   * @param _ - Unused network argument (interface compatibility).
   * @returns The facilitator's submitter address(es) on this network.
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Facilitator-injected `extra` fields for `/supported`. auth-capture injects
   * none; every wire-format address is a universal canonical constant, and
   * `captureAuthorizer`, `feeRecipient`, and the deadlines are merchant-set
   * per request.
   *
   * @param _ - Unused network argument (interface compatibility).
   * @returns Always `undefined`.
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    return undefined;
  }

  /**
   * Verify a payment payload against the published requirements without
   * touching state. Performs envelope shape checks, scheme/network agreement,
   * `extra` validation, deadline-ordering invariants, per-method field checks
   * (collector address, token, amount), signature verification (with
   * EIP-6492 unwrap), nonce binding to the payer-agnostic PaymentInfo hash,
   * and an on-chain `simulateContract` of `authorize` / `charge` so typed
   * escrow reverts surface as stable invalidReason strings.
   *
   * @param payload - The wire payload from the payer.
   * @param requirements - The server's published payment requirements.
   * @param _ - Unused FacilitatorContext (interface compatibility).
   * @returns A `VerifyResponse` with `isValid` and, on failure, a stable `invalidReason`.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    if (!isAuthCapturePayload(payload.payload)) {
      return { isValid: false, invalidReason: ErrInvalidPayloadFormat };
    }
    const wirePayload = payload.payload as AuthCapturePayload;
    const payer = isEip3009Payload(wirePayload)
      ? wirePayload.authorization.from
      : (wirePayload as Permit2Payload).permit2Authorization.from;

    if (
      payload.accepted.scheme !== AUTH_CAPTURE_SCHEME ||
      requirements.scheme !== AUTH_CAPTURE_SCHEME
    ) {
      return { isValid: false, invalidReason: ErrUnsupportedScheme, payer };
    }

    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: ErrNetworkMismatch, payer };
    }

    const networkParts = requirements.network.split(":");
    if (networkParts.length !== 2 || networkParts[0] !== "eip155") {
      return { isValid: false, invalidReason: ErrInvalidNetwork, payer };
    }

    if (!isAuthCaptureExtra(requirements.extra)) {
      return { isValid: false, invalidReason: ErrInvalidAuthCaptureExtra, payer };
    }
    const extra = requirements.extra as AuthCaptureExtra;
    const chainId = parseChainId(requirements.network);
    const assetTransferMethod = extra.assetTransferMethod ?? "eip3009";

    if (assetTransferMethod !== "eip3009" && assetTransferMethod !== "permit2") {
      return { isValid: false, invalidReason: ErrUnsupportedAssetTransferMethod, payer };
    }
    if (assetTransferMethod === "eip3009" && !isEip3009Payload(wirePayload)) {
      return { isValid: false, invalidReason: ErrPayloadMethodMismatch, payer };
    }
    if (assetTransferMethod === "permit2" && !isPermit2Payload(wirePayload)) {
      return { isValid: false, invalidReason: ErrPayloadMethodMismatch, payer };
    }

    const now = Math.floor(Date.now() / 1000);
    const SAFETY_MARGIN_SECONDS = 6;
    if (extra.captureDeadline <= now + SAFETY_MARGIN_SECONDS) {
      return { isValid: false, invalidReason: ErrCaptureDeadlineExpired, payer };
    }
    if (extra.refundDeadline < extra.captureDeadline) {
      return { isValid: false, invalidReason: ErrInvalidDeadlineOrdering, payer };
    }
    // Mirror AuthCaptureEscrow._validatePayment ordering check upfront so the
    // facilitator rejects with a typed reason instead of letting the contract
    // revert with InvalidExpiries. preApprovalExpiry is client-derived from
    // requirements.maxTimeoutSeconds; if a merchant pairs a tight captureDeadline
    // with a generous maxTimeoutSeconds, the inequality breaks.

    let preApprovalExpiry: number;
    let amount: bigint;
    let signatureForVerify: `0x${string}`;
    let signatureValid = false;

    if (assetTransferMethod === "eip3009") {
      const eipPayload = wirePayload as Eip3009Payload;
      preApprovalExpiry = Number(eipPayload.authorization.validBefore);
      amount = BigInt(eipPayload.authorization.value);

      if (preApprovalExpiry <= now + SAFETY_MARGIN_SECONDS) {
        return { isValid: false, invalidReason: ErrAuthorizationExpired, payer };
      }
      if (Number(eipPayload.authorization.validAfter) > now) {
        return { isValid: false, invalidReason: ErrAuthorizationNotYetValid, payer };
      }
      if (
        eipPayload.authorization.to.toLowerCase() !== EIP3009_TOKEN_COLLECTOR_ADDRESS.toLowerCase()
      ) {
        return { isValid: false, invalidReason: ErrTokenCollectorMismatch, payer };
      }

      const parsed = parseErc6492Signature(eipPayload.signature);
      signatureForVerify = parsed.signature;
      signatureValid = await verifyERC3009Signature(
        this.signer,
        eipPayload.authorization,
        signatureForVerify,
        { ...extra, chainId },
        requirements.asset as `0x${string}`,
      );
    } else {
      const permitPayload = wirePayload as Permit2Payload;
      preApprovalExpiry = Number(permitPayload.permit2Authorization.deadline);
      amount = BigInt(permitPayload.permit2Authorization.permitted.amount);

      if (preApprovalExpiry <= now + SAFETY_MARGIN_SECONDS) {
        return { isValid: false, invalidReason: ErrAuthorizationExpired, payer };
      }
      if (
        permitPayload.permit2Authorization.spender.toLowerCase() !==
        PERMIT2_TOKEN_COLLECTOR_ADDRESS.toLowerCase()
      ) {
        return { isValid: false, invalidReason: ErrTokenCollectorMismatch, payer };
      }
      if (
        permitPayload.permit2Authorization.permitted.token.toLowerCase() !==
        requirements.asset.toLowerCase()
      ) {
        return { isValid: false, invalidReason: ErrTokenMismatch, payer };
      }

      const parsed = parseErc6492Signature(permitPayload.signature);
      signatureForVerify = parsed.signature;
      signatureValid = await verifyPermit2Signature(
        this.signer,
        permitPayload.permit2Authorization,
        signatureForVerify,
        chainId,
      );
    }

    if (!signatureValid) {
      return { isValid: false, invalidReason: ErrInvalidAuthCaptureSignature, payer };
    }

    if (amount !== BigInt(requirements.amount)) {
      return { isValid: false, invalidReason: ErrAmountMismatch, payer };
    }

    if (preApprovalExpiry > extra.captureDeadline) {
      // AuthCaptureEscrow._validatePayment requires preApprovalExp <= authorizationExp <= refundExp.
      // Surface this as the same invalid_deadline_ordering reason rather than letting the
      // contract revert with InvalidExpiries on settle.
      return { isValid: false, invalidReason: ErrInvalidDeadlineOrdering, payer };
    }

    // Reconstruct PaymentInfo and verify the wire nonce matches the
    // payer-agnostic hash. This binds the signature to all PaymentInfo fields.
    const paymentInfo = reconstructPaymentInfo(
      payer,
      preApprovalExpiry,
      wirePayload.salt,
      requirements,
      extra,
    );
    const expectedNonce = computePayerAgnosticPaymentInfoHash(chainId, paymentInfo);

    if (assetTransferMethod === "eip3009") {
      const wireNonce = (wirePayload as Eip3009Payload).authorization.nonce;
      if (wireNonce.toLowerCase() !== expectedNonce.toLowerCase()) {
        return { isValid: false, invalidReason: ErrNonceMismatch, payer };
      }
    } else {
      const wireNonce = BigInt((wirePayload as Permit2Payload).permit2Authorization.nonce);
      if (wireNonce !== hexToBigInt(expectedNonce)) {
        return { isValid: false, invalidReason: ErrNonceMismatch, payer };
      }
    }

    // Simulate the settle call to catch issues before spending gas.
    const settleResult = await this.simulateSettle(paymentInfo, amount, wirePayload, extra, payer);
    if (settleResult !== "ok") {
      // For balance-related failures, return a more actionable reason.
      try {
        const balance = (await this.signer.readContract({
          address: requirements.asset as `0x${string}`,
          abi: ERC20_BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [payer],
        })) as bigint;
        if (balance < BigInt(requirements.amount)) {
          return { isValid: false, invalidReason: ErrInsufficientBalance, payer };
        }
      } catch {
        /* ignore: fall through */
      }
      return { isValid: false, invalidReason: settleResult, payer };
    }

    return { isValid: true, payer };
  }

  /**
   * Verify-then-settle. Re-runs `verify()` against the payload, then submits
   * `authorize` (two-phase, default) or `charge` (single-shot, when
   * `extra.autoCapture === true`) to the escrow contract. If the merchant has
   * set `captureAuthorizer` to a smart contract, the call is routed through
   * that contract instead of directly to the escrow (see `resolveSettleTarget`).
   * Waits for the transaction receipt with a 60-second timeout.
   *
   * @param payload - The wire payload from the payer.
   * @param requirements - The server's published payment requirements.
   * @param _ - Unused FacilitatorContext (interface compatibility).
   * @returns A `SettleResponse` with `success`, the transaction hash (on
   *          success), and a stable `errorReason` (on failure).
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const verification = await this.verify(payload, requirements);
    if (!verification.isValid) {
      return {
        success: false,
        errorReason: verification.invalidReason ?? ErrVerificationFailed,
        transaction: "",
        network: requirements.network,
        payer: verification.payer,
      };
    }

    const wirePayload = payload.payload as unknown as AuthCapturePayload;
    const extra = requirements.extra as unknown as AuthCaptureExtra;
    const assetTransferMethod = extra.assetTransferMethod ?? "eip3009";
    const payer = verification.payer as `0x${string}`;

    const { preApprovalExpiry, amount, tokenCollector, collectorData } = unpackForSettle(
      wirePayload,
      assetTransferMethod,
    );
    const paymentInfo = reconstructPaymentInfo(
      payer,
      preApprovalExpiry,
      wirePayload.salt,
      requirements,
      extra,
    );

    const functionName = extra.autoCapture === true ? "charge" : "authorize";
    const tuple = paymentInfoToContractTuple(paymentInfo);
    // charge() takes 6 args (adds feeBps + feeReceiver); authorize() takes 4.
    // Use minFeeBps as the safe default within the merchant's signed [min, max]
    // range; feeReceiver mirrors paymentInfo.feeReceiver (= extra.feeRecipient)
    // because _validateFee requires actual to match configured when configured != 0.
    const args =
      functionName === "charge"
        ? ([
            tuple,
            amount,
            tokenCollector,
            collectorData,
            paymentInfo.minFeeBps,
            paymentInfo.feeReceiver,
          ] as const)
        : ([tuple, amount, tokenCollector, collectorData] as const);

    const settleTarget = await this.resolveSettleTarget(extra.captureAuthorizer);

    try {
      const txHash = await this.signer.writeContract({
        address: settleTarget,
        abi: ESCROW_ABI,
        functionName,
        args,
      });

      const receiptPromise = this.signer.waitForTransactionReceipt({ hash: txHash });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Transaction receipt timeout after 60s")), 60_000),
      );
      const receipt = await Promise.race([receiptPromise, timeoutPromise]);

      if (receipt.status !== "success") {
        return {
          success: false,
          errorReason: ErrTransactionReverted,
          transaction: txHash,
          network: requirements.network,
          payer,
        };
      }

      return {
        success: true,
        transaction: txHash,
        network: requirements.network,
        payer,
      };
    } catch (error) {
      return {
        success: false,
        errorReason: error instanceof Error ? error.message : "Settlement failed",
        transaction: "",
        network: requirements.network,
        payer,
      };
    }
  }

  /**
   * Simulate the settle call via `eth_call` and translate the result to a
   * stable wire-level reason. Returns `"ok"` on simulated success; on revert
   * viem walks the error chain for `ContractFunctionRevertedError` and decodes
   * the custom-error name against `ESCROW_ABI + ESCROW_ERRORS_ABI`. Known
   * errors map to typed reasons via `ESCROW_ERROR_TO_INVALID_REASON`; anything
   * unmapped (e.g. token-collector reverts like a consumed ERC-3009 nonce)
   * falls through to `simulation_failed`.
   *
   * @param paymentInfo - The reconstructed PaymentInfo struct.
   * @param amount - Settle amount in token base units.
   * @param wirePayload - The payer's wire payload.
   * @param extra - Validated `AuthCaptureExtra` from `requirements.extra`.
   * @param _ - Unused payer address (interface compatibility).
   * @returns `"ok"` on simulated success, or a stable `invalidReason` string.
   */
  private async simulateSettle(
    paymentInfo: PaymentInfoStruct,
    amount: bigint,
    wirePayload: AuthCapturePayload,
    extra: AuthCaptureExtra,
    _: `0x${string}`,
  ): Promise<"ok" | string> {
    const assetTransferMethod = extra.assetTransferMethod ?? "eip3009";
    const { tokenCollector, collectorData } = unpackForSettle(wirePayload, assetTransferMethod);
    const functionName = extra.autoCapture === true ? "charge" : "authorize";
    const tuple = paymentInfoToContractTuple(paymentInfo);
    const args =
      functionName === "charge"
        ? ([
            tuple,
            amount,
            tokenCollector,
            collectorData,
            paymentInfo.minFeeBps,
            paymentInfo.feeReceiver,
          ] as const)
        : ([tuple, amount, tokenCollector, collectorData] as const);

    const settleTarget = await this.resolveSettleTarget(extra.captureAuthorizer);

    try {
      await this.signer.readContract({
        address: settleTarget,
        abi: ESCROW_ABI_WITH_ERRORS,
        functionName,
        args,
        // Simulate as the facilitator EOA so escrow's `onlySender(operator)`
        // gate is evaluated against the same `msg.sender` that the real
        // settle tx will have (EOA path: facilitator EOA; contract path:
        // captureAuthorizer contract, which forwards as itself).
        account: this.signer.getAddresses()[0],
      });
      return "ok";
    } catch (err) {
      return decodeRevertReason(err);
    }
  }

  /**
   * Resolve the on-chain target for an `authorize`/`charge` call per spec.
   * Per `scheme_auth-capture_evm.md`, the facilitator may call escrow `"either
   * directly or through a smart contract set as the captureAuthorizer"`.
   * Probes `getCode(captureAuthorizer)`:
   *
   * - **EOA** (empty or `0x` bytecode) → call the canonical escrow directly.
   *   The escrow's `onlySender(paymentInfo.operator)` gate is satisfied
   *   because the facilitator's tx `msg.sender` equals the captureAuthorizer
   *   EOA.
   * - **Contract** (non-empty bytecode) → call the captureAuthorizer
   *   contract, which MUST expose the literal `authorize`/`charge` escrow
   *   selectors and forward to escrow. The contract becomes `msg.sender` at
   *   the escrow, satisfying the gate.
   *
   * @param captureAuthorizer - Address from `extra.captureAuthorizer`.
   * @returns The address to target with the settle write/simulate.
   */
  private async resolveSettleTarget(captureAuthorizer: `0x${string}`): Promise<`0x${string}`> {
    const code = await this.signer.getCode({ address: captureAuthorizer });
    if (!code || code === "0x") return AUTH_CAPTURE_ESCROW_ADDRESS;
    return captureAuthorizer;
  }
}

// Combined ABI: function definitions + custom-error definitions. viem decodes
// revert data against any error in the ABI passed to the call.
const ESCROW_ABI_WITH_ERRORS = [...ESCROW_ABI, ...ESCROW_ERRORS_ABI] as const;

/**
 * Walk a viem error chain looking for a decoded custom-error name, then map
 * known names to a stable `invalidReason` via `ESCROW_ERROR_TO_INVALID_REASON`.
 * Anything unmapped returns `ErrSimulationFailed` so the wire never leaks raw
 * selectors.
 *
 * @param err - The error thrown by `readContract` / `simulateContract`.
 * @returns A stable wire-level `invalidReason` string.
 */
function decodeRevertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e): e is ContractFunctionRevertedError => e instanceof ContractFunctionRevertedError,
    );
    if (revert instanceof ContractFunctionRevertedError) {
      const errorName = revert.data?.errorName;
      if (errorName && errorName in ESCROW_ERROR_TO_INVALID_REASON) {
        return ESCROW_ERROR_TO_INVALID_REASON[errorName];
      }
    }
  }
  return ErrSimulationFailed;
}

/**
 * Unpack the per-method inputs the escrow needs at settle time: the token
 * collector address (canonical, per method) and the `collectorData` blob the
 * collector parses. EIP-3009 collectors take the raw ReceiveWithAuthorization
 * signature directly. Permit2 collectors take the signature ABI-encoded as
 * `bytes` (the collector itself reconstructs the PermitTransferFrom struct
 * from PaymentInfo, using the deterministic nonce + payer).
 *
 * @param wirePayload - The verified wire payload (EIP-3009 or Permit2 shape).
 * @param assetTransferMethod - Which envelope the payload uses.
 * @returns `preApprovalExpiry`, `amount`, `tokenCollector`, and `collectorData` ready for the escrow call.
 */
function unpackForSettle(
  wirePayload: AuthCapturePayload,
  assetTransferMethod: "eip3009" | "permit2",
): {
  preApprovalExpiry: number;
  amount: bigint;
  tokenCollector: `0x${string}`;
  collectorData: `0x${string}`;
} {
  if (assetTransferMethod === "eip3009") {
    const p = wirePayload as Eip3009Payload;
    return {
      preApprovalExpiry: Number(p.authorization.validBefore),
      amount: BigInt(p.authorization.value),
      tokenCollector: EIP3009_TOKEN_COLLECTOR_ADDRESS,
      collectorData: p.signature,
    };
  }
  const p = wirePayload as Permit2Payload;
  // Permit2 collector expects the raw 65-byte signature; the collector itself
  // reconstructs the PermitTransferFrom struct from PaymentInfo (deterministic
  // nonce + payer). Don't ABI-wrap; Permit2 checks `signature.length == 65`
  // directly and rejects a wrapped blob with `InvalidSignatureLength()`.
  return {
    preApprovalExpiry: Number(p.permit2Authorization.deadline),
    amount: BigInt(p.permit2Authorization.permitted.amount),
    tokenCollector: PERMIT2_TOKEN_COLLECTOR_ADDRESS,
    collectorData: p.signature,
  };
}
