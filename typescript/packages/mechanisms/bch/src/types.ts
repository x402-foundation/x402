import type { PaymentPayload, PaymentRequirements, ResourceInfo } from '@x402/core/types';

export type BchNetwork = 'bch:bitcoincash' | 'bch:bchtest';

export type BchExtra = {
  assetTransferMethod: 'native';
  paymentFlow: 'upfront';
};

export type ExactBchPayload = {
  transaction: string;
};

export type ExactBchPaymentPayload = PaymentPayload & {
  payload: ExactBchPayload;
};

export type ExactBchRequirements = PaymentRequirements & {
  network: BchNetwork;
  asset: 'BCH';
  extra: BchExtra;
};

export type BchOutPoint = {
  txid: string;
  vout: number;
};

export type BchSourceOutput = {
  value: bigint;
  scriptPubKey: Uint8Array;
};

export type BchUtxo = BchOutPoint & {
  value: bigint;
  scriptPubKey: Uint8Array;
  height?: number;
};

export type BchTransactionStatus =
  | { kind: 'notFound' }
  | { kind: 'mempool' }
  | { kind: 'confirmed'; height: number }
  | { kind: 'unknown' };

export type BchOutpointStatus = 'unspent' | 'spent' | 'unknown';

export interface BchProvider {
  readonly network: BchNetwork;
  getSourceOutput(outpoint: BchOutPoint): Promise<BchSourceOutput>;
  getOutpointStatus(outpoint: BchOutPoint, source: BchSourceOutput): Promise<BchOutpointStatus>;
  listUtxos(address: string): Promise<BchUtxo[]>;
  broadcast(rawTransaction: Uint8Array): Promise<string>;
  getTransactionStatus(txid: string): Promise<BchTransactionStatus>;
  getTipHeight(): Promise<number>;
  hasDoubleSpendProof(txid: string): Promise<boolean>;
}

export interface BchSigner {
  getPublicKey(): Uint8Array;
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
  getAddress(network: BchNetwork): string;
}

export interface BchFacilitatorConfig {
  settlementStrategy?: BchConfirmationStrategy;
  settlementStore?: import('./settlementStore').BchSettlementStore;
  feeRateSatPerByte?: bigint;
  dustThreshold?: bigint;
  maxTransactionSize?: number;
  maxInputs?: number;
}

export type BchConfirmationStrategy =
  | { kind: 'mempool' }
  | { kind: 'noDoubleSpendProof' }
  | { kind: 'confirmations'; count: number };

export type BchPrice =
  | string
  | number
  | {
      amount: string;
      asset: 'BCH';
      extra?: Record<string, unknown>;
    };

export type BchPaymentPayloadContext = {
  resource?: ResourceInfo;
};
