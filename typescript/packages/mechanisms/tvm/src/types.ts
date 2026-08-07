import type { Cell, StateInit } from "@ton/core";

export interface ExactTvmPayload {
  settlementBoc: string;
  asset: string;
}

export type TvmPaymentPayload = ExactTvmPayload;

export interface ParsedJettonTransfer {
  sourceWallet: string;
  destination: string;
  responseDestination: string | null;
  jettonAmount: bigint;
  attachedTonAmount: bigint;
  forwardTonAmount: bigint;
  forwardPayload: Cell;
  bodyHash: Buffer;
}

export interface ParsedTvmSettlement {
  payer: string;
  walletId: number;
  validUntil: number;
  seqno: number;
  settlementHash: string;
  body: Cell;
  signedSliceHash: Buffer;
  signature: Buffer;
  stateInit: StateInit | null;
  transfer: ParsedJettonTransfer;
}

export interface TvmAccountState {
  address: string;
  balance: bigint;
  isActive: boolean;
  isUninitialized: boolean;
  isFrozen: boolean;
  stateInit: StateInit | null;
}

export interface TvmJettonWalletData {
  address: string;
  balance: bigint;
  owner: string;
  jettonMinter: string;
}

export interface TvmRelayRequest {
  destination: string;
  body: Cell;
  stateInit: StateInit | null;
  forwardTonAmount?: bigint;
  relayAmount?: bigint;
}

export interface W5InitData {
  signatureAllowed: boolean;
  seqno: number;
  walletId: number;
  publicKey: Buffer;
  extensionsDict: Cell | null;
}
