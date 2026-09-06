import {
  beginCell,
  Cell,
  contractAddress,
  loadOutList,
  storeMessageRelaxed,
  type MessageRelaxed,
  type StateInit,
} from "@ton/core";
import { signVerify } from "@ton/crypto";
import {
  ALLOWED_CLIENT_CODES,
  ERR_EXACT_TVM_INVALID_W5_ACTIONS,
  ERR_EXACT_TVM_INVALID_W5_MESSAGE,
  SEND_MODE_IGNORE_ERRORS,
  SEND_MODE_PAY_FEES_SEPARATELY,
  W5R1_CODE_HEX,
} from "../constants";
import type { TvmAccountState, W5InitData } from "../types";
import { getNetworkGlobalId, normalizeAddress } from "./common";

export function makeW5R1WalletId(network: string, workchain = 0, subwalletNumber = 0): number {
  const context = beginCell()
    .storeUint(1, 1)
    .storeInt(workchain, 8)
    .storeUint(0, 8)
    .storeUint(subwalletNumber, 15)
    .endCell()
    .beginParse()
    .loadInt(32);
  return Number(BigInt.asUintN(32, BigInt(getNetworkGlobalId(network)) ^ BigInt(context)));
}

export function addressFromStateInit(stateInit: StateInit, workchain: number): string {
  return contractAddress(workchain, stateInit).toRawString();
}

export function buildW5R1StateInit(publicKey: Buffer, walletId: number): StateInit {
  const code = Cell.fromBoc(Buffer.from(W5R1_CODE_HEX, "hex"))[0];
  const data = beginCell()
    .storeUint(1, 1)
    .storeUint(0, 32)
    .storeUint(walletId, 32)
    .storeBuffer(publicKey, 32)
    .storeBit(false)
    .endCell();
  return { code, data };
}

export function parseW5InitData(stateInit: StateInit): W5InitData {
  if (!stateInit.data) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_MESSAGE);
  }
  const data = stateInit.data.beginParse();
  const result: W5InitData = {
    signatureAllowed: data.loadBoolean(),
    seqno: data.loadUint(32),
    walletId: data.loadUint(32),
    publicKey: data.loadBuffer(32),
    extensionsDict: data.loadMaybeRef(),
  };
  if (data.remainingBits || data.remainingRefs) {
    throw new Error(ERR_EXACT_TVM_INVALID_W5_MESSAGE);
  }
  return result;
}

export function parseActiveW5AccountState(accountState: TvmAccountState): W5InitData {
  if (!accountState.isActive || !accountState.stateInit?.code) {
    throw new Error(`Account ${accountState.address} does not have active W5 state`);
  }
  const codeHash = accountState.stateInit.code.hash().toString("hex");
  if (!ALLOWED_CLIENT_CODES.has(codeHash)) {
    throw new Error(`Account ${accountState.address} is not a W5R1 wallet`);
  }
  return parseW5InitData(accountState.stateInit);
}

export function getW5Seqno(accountState: TvmAccountState): number {
  if (accountState.isUninitialized) {
    return 0;
  }
  return parseActiveW5AccountState(accountState).seqno;
}

export function parseOutList(cell: Cell): ReturnType<typeof loadOutList> {
  try {
    return loadOutList(cell.beginParse());
  } catch (error) {
    throw Object.assign(new Error(ERR_EXACT_TVM_INVALID_W5_ACTIONS), { cause: error });
  }
}

export function serializeSendMsgAction(
  message: Cell,
  mode = SEND_MODE_IGNORE_ERRORS + SEND_MODE_PAY_FEES_SEPARATELY,
): Cell {
  return beginCell().storeUint(0x0ec3c86d, 32).storeUint(mode, 8).storeRef(message).endCell();
}

export function serializeOutList(actions: Cell[]): Cell {
  let outList = Cell.EMPTY;
  for (const action of actions) {
    outList = beginCell().storeRef(outList).storeBuilder(action.asBuilder()).endCell();
  }
  return outList;
}

export function buildW5SignedBody({
  outMessage,
  seqno,
  validUntil,
  signMessage,
  walletId,
  opcode,
  sendMode = SEND_MODE_PAY_FEES_SEPARATELY,
}: {
  outMessage: MessageRelaxed;
  seqno: number;
  validUntil: number;
  signMessage: (message: Buffer) => Buffer | Promise<Buffer>;
  walletId: number;
  opcode: number;
  sendMode?: number;
}): Cell | Promise<Cell> {
  const action = beginCell()
    .storeUint(0x0ec3c86d, 32)
    .storeUint(sendMode, 8)
    .storeRef(beginCell().store(storeMessageRelaxed(outMessage)).endCell())
    .endCell();
  const actions = serializeOutList([action]);
  const unsignedBody = beginCell()
    .storeUint(opcode, 32)
    .storeUint(walletId, 32)
    .storeUint(validUntil, 32)
    .storeUint(seqno, 32)
    .storeMaybeRef(actions)
    .storeBit(false)
    .endCell();

  const pack = (signature: Buffer) =>
    beginCell().storeSlice(unsignedBody.beginParse()).storeBuffer(signature, 64).endCell();
  const signature = signMessage(unsignedBody.hash());
  return signature instanceof Promise ? signature.then(pack) : pack(signature);
}

export function verifyW5Signature(
  publicKey: Buffer,
  signedSliceHash: Buffer,
  signature: Buffer,
): boolean {
  return signVerify(signedSliceHash, signature, publicKey);
}

export function stateInitAddressMatches(stateInit: StateInit, address: string): boolean {
  const workchain = Number.parseInt(normalizeAddress(address).split(":", 1)[0], 10);
  return addressFromStateInit(stateInit, workchain) === normalizeAddress(address);
}
