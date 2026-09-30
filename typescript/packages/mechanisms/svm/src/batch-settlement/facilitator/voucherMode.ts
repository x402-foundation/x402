import type { PaymentRequirements } from "@x402/core/types";

import { parseU64 } from "../../payment-channels/open";
import { verifyBatchAuthorization } from "../authorization";
import { BatchError } from "../errors";
import type { BatchChannelConfig, BatchPayload, BatchRefundPayload } from "../types";
import type { ProofAmountBound, VoucherModeBinding } from "./types";

/**
 * Verify server-mode refund identity: close intent via `authorizedAmount` zero.
 *
 * @param payload - Refund payload without an operator voucher
 * @param channelId - Derived channel PDA
 */
export async function assertServerModeRefundProof(
  payload: BatchRefundPayload,
  channelId: string,
): Promise<void> {
  if (payload.voucher !== undefined) {
    throw new Error(`${BatchError.VOUCHER_SIGNATURE}: invalid payer proof`);
  }
  const authorization = payload.authorization;
  if (!authorization) throw new Error(`${BatchError.VOUCHER_SIGNATURE}: payer proof missing`);
  const authorized = parseU64(authorization.authorizedAmount, "authorizedAmount");
  if (
    authorized !== 0n ||
    authorization.channelId !== channelId ||
    authorization.payer !== payload.channelConfig.payer ||
    typeof authorization.requestId !== "string" ||
    authorization.requestId.length === 0 ||
    !(await verifyBatchAuthorization(authorization, payload.channelConfig.payerAuthorizer))
  ) {
    throw new Error(`${BatchError.VOUCHER_SIGNATURE}: invalid payer proof`);
  }
}

/**
 * Verify the payer proof behind a server-signed request.
 *
 * Verify requires `requirements.amount` to equal the signed ceiling. Settle
 * allows a metered charge at or below that ceiling. Signature, channel, payer,
 * request id, and expiry stay exact in both cases.
 *
 * @param payload - Server-mode `authorization` or `deposit` payload
 * @param channelId - Derived channel PDA
 * @param requirements - Accepted requirements for this verify or settle
 * @param proofBound - `"exact"` at verify; `"ceiling"` at settle
 */
export async function assertServerModeProof(
  payload: Extract<BatchPayload, { type: "authorization" | "deposit" }>,
  channelId: string,
  requirements: PaymentRequirements,
  proofBound: ProofAmountBound = "exact",
): Promise<void> {
  const authorization = payload.authorization;
  if (!authorization) throw new Error(`${BatchError.VOUCHER_SIGNATURE}: payer proof missing`);
  const charged = parseU64(requirements.amount, "amount");
  const authorized = parseU64(authorization.authorizedAmount, "authorizedAmount");
  if (
    authorization.channelId !== channelId ||
    authorization.payer !== payload.channelConfig.payer ||
    !proofCoversCharge(charged, authorized, proofBound) ||
    typeof authorization.requestId !== "string" ||
    authorization.requestId.length === 0 ||
    !(await verifyBatchAuthorization(authorization, payload.channelConfig.payerAuthorizer))
  ) {
    throw new Error(`${BatchError.VOUCHER_SIGNATURE}: invalid payer proof`);
  }
}

/**
 * Whether a metered charge is inside the payer proof.
 *
 * @param charged - Amount the request is verifying or settling
 * @param authorized - Amount the payer proof signed
 * @param bound - Exact match at verify, ceiling at settle
 * @returns Whether the charge is allowed by the proof
 */
function proofCoversCharge(charged: bigint, authorized: bigint, bound: ProofAmountBound): boolean {
  switch (bound) {
    case "exact":
      return charged === authorized;
    case "ceiling":
      return charged <= authorized;
    default: {
      const unexpected: never = bound;
      return unexpected;
    }
  }
}

/**
 * Resolve voucher mode from the requirements or from the payload.
 *
 * @param config - Channel the payload names
 * @param extra - Requirements extra from the payment or the redemption worker
 * @param binding - `"requirements"` matches the payload to the requirements; `"payload"` follows `channelConfig`
 * @returns The voucher mode those terms should enforce
 */
export function voucherSignerFor(
  config: BatchChannelConfig,
  extra: Record<string, unknown>,
  binding: VoucherModeBinding,
): "client" | "server" {
  switch (binding) {
    case "payload": {
      const voucherSigner = config.voucherSigner ?? "client";
      if (voucherSigner !== "client" && voucherSigner !== "server") {
        throw new Error(BatchError.CHANNEL_STATE);
      }
      if (
        voucherSigner === "server" &&
        (typeof extra.operator !== "string" || config.payerAuthorizer !== extra.operator)
      ) {
        throw new Error(BatchError.CHANNEL_STATE);
      }
      return voucherSigner;
    }
    case "requirements": {
      const voucherSigner = extra.voucherSigner ?? "client";
      const operator = extra.operator;
      if (voucherSigner !== "client" && voucherSigner !== "server") {
        throw new Error(BatchError.CHANNEL_STATE);
      }
      if (
        (voucherSigner === "server" &&
          (typeof operator !== "string" || config.payerAuthorizer !== operator)) ||
        (voucherSigner === "client" && operator !== undefined) ||
        (config.voucherSigner ?? "client") !== voucherSigner
      ) {
        throw new Error(BatchError.CHANNEL_STATE);
      }
      return voucherSigner;
    }
    default: {
      const unexpected: never = binding;
      throw new Error(`${BatchError.CHANNEL_STATE}: ${String(unexpected)}`);
    }
  }
}
