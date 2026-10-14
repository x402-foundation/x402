import type { PaymentPayload, PaymentRequirements, ResourceInfo } from '@x402/core/types';

export type BchNetwork = 'bch:bitcoincash' | 'bch:bchtest';
export type BchTransactionNetwork = 'mainnet' | 'chipnet';

export type BchTokenCapability = 'none' | 'mutable' | 'minting';

export type BchTokenRequest = {
  category: string;
  amount: bigint;
  nft?: {
    capability: BchTokenCapability;
    commitment: string;
  };
};

export type BchTransactionRequest = {
  network: BchTransactionNetwork;
  recipient: { address: string };
  amount: bigint;
  token?: BchTokenRequest;
};

export type BchWalletAddress = {
  address: string;
  path: string;
  change: 0 | 1;
  index: number;
  utxos?: BchUtxo[];
};

export type BchHdDiscoveryOptions = {
  accountIndex?: number;
  gapLimit?: number;
  maxAddresses?: number;
};

/** Wallet boundary used by the x402 client; key material remains wallet-owned. */
export interface BchWallet {
  createPayment(request: BchTransactionRequest): Promise<Uint8Array>;
}

export function toBchTransactionNetwork(network: BchNetwork): BchTransactionNetwork {
  if (network === 'bch:bitcoincash') return 'mainnet';
  if (network === 'bch:bchtest') return 'chipnet';
  throw new Error(`Unsupported BCH network: ${network}`);
}

export function toBchTransactionRequest(
  requirements: Pick<ExactBchRequirements, 'network' | 'payTo' | 'amount' | 'asset' | 'extra'>,
): BchTransactionRequest {
  return {
    network: toBchTransactionNetwork(requirements.network),
    recipient: { address: requirements.payTo },
    amount: BigInt(requirements.amount),
    ...(requirements.extra.assetTransferMethod === 'cashtoken'
      ? {
          token: {
            category: requirements.asset,
            amount: BigInt(requirements.amount),
            ...(requirements.extra.token?.nft === undefined
              ? {}
              : { nft: requirements.extra.token.nft }),
          },
        }
      : {}),
  };
}

export type BchNativeExtra = {
  assetTransferMethod: 'native';
  paymentFlow: 'upfront';
};

export type BchCashTokenExtra = {
  assetTransferMethod: 'cashtoken';
  paymentFlow: 'upfront';
  /** BCH value assigned to the merchant's token-bearing output. */
  tokenOutputValue?: string;
  token?: {
    category: string;
    amount: string;
    nft?: BchTokenRequest['nft'];
  };
};

export type BchExtra = BchNativeExtra | BchCashTokenExtra;

export type ExactBchPayload = {
  transaction: string;
};

export type ExactBchPaymentPayload = PaymentPayload & {
  payload: ExactBchPayload;
};

export type ExactBchRequirements = PaymentRequirements & {
  network: BchNetwork;
  asset: string;
  extra: BchExtra;
};

export type BchOutPoint = {
  txid: string;
  vout: number;
};

export type BchSourceOutput = {
  value: bigint;
  scriptPubKey: Uint8Array;
  token?: import('./crypto').BchToken;
};

export type BchUtxo = BchOutPoint & {
  value: bigint;
  scriptPubKey: Uint8Array;
  token?: import('./crypto').BchToken;
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
      asset: string;
      extra?: Record<string, unknown>;
    };

export type BchPaymentPayloadContext = {
  resource?: ResourceInfo;
};
