import { describe, expect, it, vi } from 'vitest';
import { ExactBchScheme } from '../src/exact/client';
import { ExactBchFacilitatorScheme } from '../src/exact/facilitator';
import { ExactBchServerScheme } from '../src/exact/server';
import { hash160, parseTransaction, p2pkhScript, transactionId } from '../src/crypto';
import { createSecp256k1BchSigner } from '../src/signer';
import type { BchNetwork, BchProvider } from '../src/types';

const NETWORK: BchNetwork = 'bch:bitcoincash';
const MERCHANT_ADDRESS = 'bitcoincash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zye3kwllue';
const REQUIREMENTS = {
  scheme: 'exact' as const,
  network: NETWORK,
  asset: 'BCH' as const,
  amount: '1000',
  payTo: MERCHANT_ADDRESS,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: 'native' as const, paymentFlow: 'upfront' as const },
};

function makeProvider(): BchProvider {
  const signer = createSecp256k1BchSigner(new Uint8Array(32).fill(1));
  const scriptPubKey = p2pkhScript(hash160(signer.getPublicKey()));
  const utxo = {
    txid: '00'.repeat(32),
    vout: 0,
    value: 100_000n,
    scriptPubKey,
  };
  return {
    network: NETWORK,
    listUtxos: vi.fn(async () => [utxo]),
    getSourceOutput: vi.fn(async () => ({ value: utxo.value, scriptPubKey })),
    getOutpointStatus: vi.fn(async () => 'unspent' as const),
    broadcast: vi.fn(async (raw) => transactionId(parseTransaction(raw))),
    getTransactionStatus: vi.fn(async () => ({ kind: 'confirmed' as const, height: 100 })),
    getTipHeight: vi.fn(async () => 100),
    hasDoubleSpendProof: vi.fn(async () => false),
  };
}

describe('BCH x402 v2 exact scheme', () => {
  it('creates, verifies, and settles a payment through the core scheme interfaces', async () => {
    const provider = makeProvider();
    const signer = createSecp256k1BchSigner(new Uint8Array(32).fill(1));
    const client = new ExactBchScheme(signer, provider);
    const facilitator = new ExactBchFacilitatorScheme(provider);

    const created = await client.createPaymentPayload(2, REQUIREMENTS);
    const payload = { ...created, accepted: REQUIREMENTS };
    const verified = await facilitator.verify(payload, REQUIREMENTS);
    const settled = await facilitator.settle(payload, REQUIREMENTS);

    expect(verified).toMatchObject({ isValid: true, payer: signer.getAddress(NETWORK) });
    expect(settled).toMatchObject({
      success: true,
      network: NETWORK,
      payer: signer.getAddress(NETWORK),
    });
    expect(provider.broadcast).toHaveBeenCalledOnce();

    const retried = await facilitator.settle(payload, REQUIREMENTS);
    expect(retried).toMatchObject({ success: true, transaction: settled.transaction });
    expect(provider.broadcast).toHaveBeenCalledOnce();
  });

  it('declares BCH native upfront pricing and rejects unsupported price assets', async () => {
    const server = new ExactBchServerScheme();

    await expect(server.parsePrice({ amount: '1000', asset: 'BCH' }, NETWORK)).resolves.toEqual({
      amount: '1000',
      asset: 'BCH',
      extra: { assetTransferMethod: 'native', paymentFlow: 'upfront' },
    });
    await expect(
      server.parsePrice({ amount: '1000', asset: 'USD' } as never, NETWORK),
    ).rejects.toThrow('BCH exact requires asset BCH');
  });

  it('treats a double-spend proof as conflict evidence in no-double-spend-proof mode', async () => {
    const provider = makeProvider();
    const signer = createSecp256k1BchSigner(new Uint8Array(32).fill(1));
    const client = new ExactBchScheme(signer, provider);
    const facilitator = new ExactBchFacilitatorScheme(provider, {
      settlementStrategy: { kind: 'noDoubleSpendProof' },
    });
    const created = await client.createPaymentPayload(2, REQUIREMENTS);
    const payload = { ...created, accepted: REQUIREMENTS };
    vi.mocked(provider.getTransactionStatus).mockResolvedValue({ kind: 'mempool' });
    vi.mocked(provider.hasDoubleSpendProof).mockResolvedValue(true);

    const settled = await facilitator.settle(payload, REQUIREMENTS);

    expect(settled).toMatchObject({ success: false });
    expect(settled.errorReason).toMatch(/^settlement_pending:/);
  });
});
