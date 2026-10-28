import type { PaymentRequirements } from "@x402/core/types";
import { resolveBatchAuthorizationFormat } from "./authorization";
import { BatchError } from "./errors";
import type { BatchAuthorizationFormat, BatchPayload } from "./types";

/**
 * Enforce advertised proof format and local opt-in before signature verification.
 *
 * @param payload - Validated batch payload
 * @param requirements - Server-advertised payment requirements
 * @param allowed - Locally enabled formats; binary only by default
 */
export function assertBatchAuthorizationFormat(
  payload: BatchPayload,
  requirements: PaymentRequirements,
  allowed: readonly BatchAuthorizationFormat[] = ["binary"],
): void {
  let expected: BatchAuthorizationFormat;
  try {
    expected = resolveBatchAuthorizationFormat(requirements.extra?.authorizationFormat);
  } catch {
    throw new Error(`${BatchError.VOUCHER_SIGNATURE}: unsupported batch authorization format`);
  }
  if (!allowed.includes(expected))
    throw new Error(`${BatchError.VOUCHER_SIGNATURE}: authorization format is not enabled`);
  if (payload.channelConfig.voucherSigner !== "server") {
    if (expected !== "binary")
      throw new Error(`${BatchError.VOUCHER_SIGNATURE}: text proofs require server mode`);
    return;
  }
  if (
    "authorization" in payload &&
    payload.authorization !== undefined &&
    resolveBatchAuthorizationFormat(payload.authorization.format) !== expected
  ) {
    throw new Error(
      `${BatchError.VOUCHER_SIGNATURE}: authorization format does not match requirements`,
    );
  }
}
