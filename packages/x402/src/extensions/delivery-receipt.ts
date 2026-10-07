import type { DeliveryReceipt } from '../types/delivery-receipt';

export const DELIVERY_RECEIPT_EXTENSION_NAME = 'delivery-receipt';
export const DELIVERY_RECEIPT_SCHEME = 'x402-receipts/v0';

export function isDeliveryReceipt(data: unknown): data is DeliveryReceipt {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as Record<string, unknown>;
  return r.scheme === DELIVERY_RECEIPT_SCHEME &&
    typeof r.payment === 'object' &&
    typeof r.request === 'object' &&
    typeof r.response === 'object' &&
    typeof r.seller === 'object';
}

export function validateSchema(receipt: DeliveryReceipt): { ok: boolean; error?: string } {
  if (receipt.scheme !== DELIVERY_RECEIPT_SCHEME) {
    return { ok: false, error: 'Invalid scheme' };
  }
  if (receipt.payment.payer.toLowerCase() === receipt.payment.payee.toLowerCase()) {
    return { ok: false, error: 'payer == payee not allowed' };
  }
  const requiredPayment = ['chain_id','tx_hash','asset','amount','payer','payee'];
  for (const k of requiredPayment) {
    if (!(k in receipt.payment)) return { ok: false, error: `payment.${k} missing` };
  }
  return { ok: true };
}

/**
 * Fail-open verification stub.
 * Real implementation should:
 * 1. Verify EIP-712 seller signature over receipt digest
 * 2. Verify on-chain settlement for payment.tx_hash
 * 3. Verify RFC-6962 merkle inclusion if anchor present
 */
export async function verifyDeliveryReceipt(
  receipt: DeliveryReceipt,
  ctx: {
    getChainId: () => Promise<number>;
    getTransaction: (chainId: number, txHash: string) => Promise<{ from: string; to: string; value: string; asset: string } | null>;
  }
): Promise<{ valid: boolean; reason?: string }> {
  const schemaCheck = validateSchema(receipt);
  if (!schemaCheck.ok) return { valid: false, reason: schemaCheck.error };

  const chainId = await ctx.getChainId();
  if (chainId !== receipt.payment.chain_id) {
    return { valid: false, reason: 'chain_id mismatch' };
  }
  const tx = await ctx.getTransaction(chainId, receipt.payment.tx_hash);
  if (!tx) return { valid: false, reason: 'tx not found' };
  if (tx.from.toLowerCase() !== receipt.payment.payer.toLowerCase() ||
      tx.to.toLowerCase() !== receipt.payment.payee.toLowerCase()) {
    return { valid: false, reason: 'tx parties mismatch' };
  }
  return { valid: true };
}

export const deliveryReceiptExtension = {
  name: DELIVERY_RECEIPT_EXTENSION_NAME,
  parse: (data: unknown) => data as DeliveryReceipt,
  validate: validateSchema,
  verify: verifyDeliveryReceipt,
};
