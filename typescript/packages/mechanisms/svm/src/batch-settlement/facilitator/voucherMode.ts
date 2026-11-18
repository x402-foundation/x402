import type { PaymentRequirements } from "@x402/core/types";

import { parseU64 } from "../../payment-channels/open";
import { verifyBatchAuthorization } from "../authorization";
import { BatchError } from "../errors";
import type {
  BatchChannelConfig,
  BatchPayload,
  BatchRefundPayload,
  BatchVoucherSigner,
} from "../types";
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

/**
 * A client voucher must cover `settled + charge` and stay strictly above `settled`.
 * A zero price still has to move the watermark.
 *
 * @param cumulative - Signed `maxClaimableAmount`
 * @param settled - Onchain settled watermark
 * @param charge - `PaymentRequirements.amount`
 * @returns Whether the voucher clears the settled watermark
 */
export function advancesSettled(cumulative: bigint, settled: bigint, charge: bigint): boolean {
  return cumulative > settled && cumulative >= settled + charge;
}

/**
 * Check a deposit's proof against the escrow it will sit behind (spec 7). A
 * client voucher the server cannot accept (not the first charge on an open,
 * not past the settled watermark on a top-up) is `cumulative_amount_mismatch`;
 * a proof the deposit cannot cover is `cumulative_exceeds_deposit`.
 *
 * @param signer - Who signs the channel's vouchers
 * @param amounts - The amounts to compare
 * @param amounts.proof - Client voucher cumulative; the charge in server mode
 * @param amounts.charge - `PaymentRequirements.amount`
 * @param amounts.deposit - Channel deposit once this deposit lands
 * @param amounts.settled - Onchain settled watermark for a top-up; undefined for an open
 */
export function assertDepositProof(
  signer: BatchVoucherSigner,
  amounts: { proof: bigint; charge: bigint; deposit: bigint; settled?: bigint | undefined },
): void {
  const { proof, charge, deposit, settled } = amounts;
  if (signer === "client") {
    const accepted =
      settled === undefined ? proof === charge : advancesSettled(proof, settled, charge);
    if (!accepted) {
      throw new Error(
        settled === undefined
          ? `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: first voucher must equal the charge`
          : `${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: voucher must advance the settled watermark`,
      );
    }
  }
  if ((signer === "client" ? proof : charge) > deposit) {
    throw new Error(`${BatchError.CUMULATIVE_EXCEEDS_DEPOSIT}: proof exceeds the channel deposit`);
  }
}
