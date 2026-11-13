import { Cell, type MessageRelaxed } from "@ton/core";
import { ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER } from "../constants";
import type { ParsedJettonTransfer, ParsedNativeTransfer } from "../types";
import { decodeBase64Boc, normalizeAddress } from "./common";

/** Extra fields that only apply to Jetton transfers. */
const JETTON_ONLY_EXTRA_FIELDS = ["forwardTonAmount", "responseDestination"] as const;

/**
 * Effective body of a native TON transfer: `extra.forwardPayload`, or an empty cell.
 *
 * @param extra - Payment requirements `extra`
 * @returns The transfer body cell
 */
export function nativeTransferBody(extra: Record<string, unknown>): Cell {
  return typeof extra.forwardPayload === "string"
    ? decodeBase64Boc(extra.forwardPayload)
    : Cell.EMPTY;
}

export function hasJettonOnlyExtra(extra: Record<string, unknown>): boolean {
  return JETTON_ONLY_EXTRA_FIELDS.some(field => field in extra);
}

export function isNativeTransfer(
  transfer: ParsedJettonTransfer | ParsedNativeTransfer,
): transfer is ParsedNativeTransfer {
  return "kind" in transfer && transfer.kind === "native";
}

/**
 * Parse the outbound message of a native TON payment.
 *
 * @param outMsg - The single W5 `action_send_msg` message
 * @returns The parsed transfer
 */
export function parseNativeTransfer(outMsg: MessageRelaxed): ParsedNativeTransfer {
  if (outMsg.info.type !== "internal" || !outMsg.info.dest) {
    throw new Error(ERR_EXACT_TVM_INVALID_NATIVE_TRANSFER);
  }
  return {
    kind: "native",
    destination: normalizeAddress(outMsg.info.dest),
    amount: outMsg.info.value.coins,
    body: outMsg.body,
    bounce: outMsg.info.bounce,
    hasExtraCurrencies: (outMsg.info.value.other?.size ?? 0) > 0,
    hasStateInit: Boolean(outMsg.init),
  };
}
