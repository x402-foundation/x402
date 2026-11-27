import { beginCell, loadMessageRelaxed } from "@ton/core";
import {
  ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC,
  ERR_EXACT_TVM_INVALID_W5_ACTIONS,
  ERR_EXACT_TVM_INVALID_W5_MESSAGE,
  INTERNAL_SIGNED_OP,
  SEND_MODE_IGNORE_ERRORS,
  SEND_MODE_PAY_FEES_SEPARATELY,
} from "../constants";
import type { ParsedJettonTransfer, ParsedNativeTransfer, ParsedTvmSettlement } from "../types";
import { decodeBase64Boc, normalizeAddress } from "../codecs/common";
import { parseJettonTransfer } from "../codecs/jetton";
import { parseNativeTransfer } from "../codecs/native";
import { parseOutList } from "../codecs/w5";

/**
 * Parse a settlement BoC carrying a TEP-74 Jetton `transfer`.
 *
 * @param settlementBoc - Base64 settlement BoC
 * @returns The parsed settlement
 */
export function parseExactTvmPayload(settlementBoc: string): ParsedTvmSettlement {
  return parseSettlement(settlementBoc, false);
}

/**
 * Parse a settlement BoC carrying a native TON transfer to `payTo`.
 *
 * @param settlementBoc - Base64 settlement BoC
 * @returns The parsed settlement
 */
export function parseExactTvmNativePayload(settlementBoc: string): ParsedTvmSettlement {
  return parseSettlement(settlementBoc, true);
}

function parseSettlement(settlementBoc: string, native: boolean): ParsedTvmSettlement {
  let root;
  let message;
  try {
    root = decodeBase64Boc(settlementBoc);
    message = loadMessageRelaxed(root.beginParse());
  } catch (error) {
    throw Object.assign(new Error(ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC), { cause: error });
  }

  if (message.info.type !== "internal") {
    throw new Error(ERR_EXACT_TVM_INVALID_SETTLEMENT_BOC);
  }

  const payer = normalizeAddress(message.info.dest);
  const body = message.body;
  const bodySlice = body.beginParse();

  if (bodySlice.remainingBits < 32) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_MESSAGE);
  }
  const opcode = bodySlice.loadUint(32);
  if (opcode !== INTERNAL_SIGNED_OP) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_MESSAGE);
  }

  const walletId = bodySlice.loadUint(32);
  const validUntil = bodySlice.loadUint(32);
  const seqno = bodySlice.loadUint(32);

  const hasActions = bodySlice.loadBit();
  const actionsCell = hasActions ? bodySlice.loadRef() : null;
  const actions = actionsCell ? parseOutList(actionsCell) : [];
  const hasExtraActions = bodySlice.loadBit();
  if (hasExtraActions) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_ACTIONS);
  }

  if (actions.length !== 1 || actions[0].type !== "sendMsg") {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_ACTIONS);
  }

  const action = actions[0];
  if (action.outMsg.info.type !== "internal" || !action.outMsg.info.dest) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_ACTIONS);
  }
  // Jetton transfers must bounce so that a failed transfer returns the attached TON.
  if (!native && action.outMsg.info.bounce !== true) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_ACTIONS);
  }

  const allowedModes = new Set([
    SEND_MODE_PAY_FEES_SEPARATELY,
    SEND_MODE_PAY_FEES_SEPARATELY + SEND_MODE_IGNORE_ERRORS,
  ]);
  if (!allowedModes.has(action.mode)) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_ACTIONS);
  }

  let transfer: ParsedJettonTransfer | ParsedNativeTransfer;
  if (native) {
    transfer = parseNativeTransfer(action.outMsg);
  } else {
    const jettonTransfer = parseJettonTransfer(
      normalizeAddress(action.outMsg.info.dest),
      action.outMsg.body,
    );
    jettonTransfer.attachedTonAmount = action.outMsg.info.value.coins;
    transfer = jettonTransfer;
  }

  const signature = bodySlice.loadBuffer(64);
  if (bodySlice.remainingBits || bodySlice.remainingRefs) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_MESSAGE);
  }

  const signedSliceBuilder = beginCell()
    .storeUint(opcode, 32)
    .storeUint(walletId, 32)
    .storeUint(validUntil, 32)
    .storeUint(seqno, 32);
  if (actionsCell) {
    signedSliceBuilder.storeBit(true).storeRef(actionsCell);
  } else {
    signedSliceBuilder.storeBit(false);
  }
  signedSliceBuilder.storeBit(false);

  return {
    payer,
    walletId,
    validUntil,
    seqno,
    settlementHash: root.hash().toString("hex"),
    body,
    signedSliceHash: signedSliceBuilder.endCell().hash(),
    signature,
    stateInit: message.init ?? null,
    transfer,
  };
}
