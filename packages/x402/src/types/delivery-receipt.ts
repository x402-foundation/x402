export interface DeliveryReceiptPayment {
  chain_id: number;
  tx_hash: string;
  asset: string;
  amount: string;
  payer: string;
  payee: string;
}

export interface DeliveryReceiptRequest {
  method: string;
  url_hash: string;
  params_hash: string;
  ts: number;
}

export interface DeliveryReceiptResponse {
  status: number;
  body_sha256: string;
  content_type: string;
  ts: number;
  latency_ms: number;
}

export interface DeliveryReceiptSeller {
  erc8004_agent_id: string;
  sig: string;
}

export interface DeliveryReceiptBuyer {
  countersig: string | null;
}

export interface DeliveryReceiptAnchor {
  batch_merkle_root: string;
  base_tx: string;
  leaf_index: number;
}

export interface DeliveryReceiptV0 {
  scheme: 'x402-receipts/v0';
  payment: DeliveryReceiptPayment;
  request: DeliveryReceiptRequest;
  response: DeliveryReceiptResponse;
  seller: DeliveryReceiptSeller;
  buyer: DeliveryReceiptBuyer;
  anchor: DeliveryReceiptAnchor | null;
}

export type DeliveryReceipt = DeliveryReceiptV0;
