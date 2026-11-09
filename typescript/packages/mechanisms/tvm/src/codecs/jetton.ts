import { Address, beginCell, Cell } from "@ton/core";
import type { PaymentRequirements } from "@x402/core/types";
import { ERR_EXACT_TVM_INVALID_JETTON_TRANSFER, JETTON_TRANSFER_OPCODE } from "../constants";
import type { ParsedJettonTransfer } from "../types";
import { decodeBase64Boc, makeZeroBitCell, normalizeAddress } from "./common";

export function buildJettonTransferBody(requirements: PaymentRequirements): Cell {
  return buildJettonTransferBodyFields({
    amount: BigInt(requirements.amount),
    payTo: requirements.payTo,
    extra: requirements.extra ?? {},
  });
}

export function buildJettonTransferBodyFields({
  amount,
  payTo,
  extra,
}: {
  amount: bigint;
  payTo: string;
  extra: Record<string, unknown>;
}): Cell {
  const forwardTonAmount = BigInt(String(extra.forwardTonAmount ?? "0"));
  if (forwardTonAmount < 0n) {
    throw new Error("Forward TON amount should be >= 0");
  }

  const responseDestination =
    typeof extra.responseDestination === "string"
      ? Address.parse(extra.responseDestination)
      : undefined;

  const builder = beginCell()
    .storeUint(JETTON_TRANSFER_OPCODE, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(Address.parse(payTo))
    .storeAddress(responseDestination ?? null)
    .storeBit(false)
    .storeCoins(forwardTonAmount);

  if (typeof extra.forwardPayload === "string") {
    builder.storeMaybeRef(decodeBase64Boc(extra.forwardPayload));
  } else {
    builder.storeBit(false);
    builder.storeBuilder(makeZeroBitCell().asBuilder());
  }

  return builder.endCell();
}

export function parseJettonTransfer(jettonWallet: string, body: Cell): ParsedJettonTransfer {
  const slice = body.beginParse();
  if (slice.remainingBits < 32) {
    throw new Error(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
  }
  const opcode = slice.loadUint(32);
  if (opcode !== JETTON_TRANSFER_OPCODE) {
    throw new Error(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
  }

  slice.loadUintBig(64);
  const amount = slice.loadCoins();
  const destination = slice.loadAddress();
  if (!destination) {
    throw new Error(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
  }

  const responseDestination = slice.loadMaybeAddress();
  const hasCustomPayload = slice.loadBit();
  if (hasCustomPayload) {
    throw new Error(ERR_EXACT_TVM_INVALID_JETTON_TRANSFER);
  }

  const forwardTonAmount = slice.loadCoins();
  const forwardPayload = slice.loadBit() ? slice.loadRef() : slice.asCell();

  return {
    sourceWallet: normalizeAddress(jettonWallet),
    destination: normalizeAddress(destination),
    responseDestination: responseDestination ? normalizeAddress(responseDestination) : null,
    jettonAmount: amount,
    attachedTonAmount: 0n,
    forwardTonAmount,
    forwardPayload,
    bodyHash: body.hash(),
  };
}
