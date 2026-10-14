import { describe, expect, it } from 'vitest';
import { encodeCashAddr, hash160, p2pkhScript } from '../src/crypto';
import { FailoverFulcrumTransport, FulcrumProvider } from '../src/provider';
import { createSecp256k1BchSignerFromMnemonic } from '../src/signer';

const BIP39_VECTOR_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('Fulcrum provider adapter', () => {
  it('parses exact decimal and scientific BCH amounts without floating point rounding', async () => {
    const network = 'bch:bitcoincash' as const;
    const signer = createSecp256k1BchSignerFromMnemonic(BIP39_VECTOR_MNEMONIC);
    const address = signer.getAddress(network);
    const scriptPubKey = p2pkhScript(hash160(signer.getPublicKey()));
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const provider = new FulcrumProvider(network, {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'blockchain.transaction.get') {
          return {
            vout: [
              {
                n: 0,
                value: 1e-8,
                scriptPubKey: {
                  hex: Array.from(scriptPubKey, (byte) => byte.toString(16).padStart(2, '0')).join(
                    '',
                  ),
                },
              },
            ],
          };
        }
        if (method === 'blockchain.scripthash.listunspent') {
          return [{ tx_hash: '11'.repeat(32), tx_pos: 0, value: 1, height: 0 }];
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });

    const source = await provider.getSourceOutput({ txid: '11'.repeat(32), vout: 0 });
    const utxos = await provider.listUtxos(address);

    expect(source.value).toBe(1n);
    expect(utxos[0].value).toBe(1n);
    expect(utxos[0].scriptPubKey).toEqual(scriptPubKey);
    expect(calls.map((call) => call.method)).toEqual([
      'blockchain.transaction.get',
      'blockchain.scripthash.listunspent',
    ]);
    expect(calls[1].params).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), 'include_tokens']);
    expect(encodeCashAddr(hash160(signer.getPublicKey()), network)).toBe(address);
  });

  it('maps Fulcrum height zero to mempool status', async () => {
    const provider = new FulcrumProvider('bch:bitcoincash', {
      async request(method) {
        if (method === 'blockchain.transaction.get_height') return 0;
        throw new Error('unexpected method: ' + method);
      },
    });

    await expect(provider.getTransactionStatus('11'.repeat(32))).resolves.toEqual({
      kind: 'mempool',
    });
  });

  it('requests and parses CashToken UTXOs', async () => {
    const network = 'bch:bitcoincash' as const;
    const signer = createSecp256k1BchSignerFromMnemonic(BIP39_VECTOR_MNEMONIC);
    const provider = new FulcrumProvider(network, {
      async request(method, params) {
        if (method === 'blockchain.scripthash.listunspent') {
          expect(params[1]).toBe('include_tokens');
          return [
            {
              tx_hash: '22'.repeat(32),
              tx_pos: 0,
              value: '10000',
              height: 123,
              tokenData: { category: '33'.repeat(32), amount: '1000' },
            },
          ];
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });

    const [utxo] = await provider.listUtxos(signer.getAddress(network));
    expect(utxo.token).toEqual({ category: '33'.repeat(32), amount: 1000n });
    expect(utxo.value).toBe(10_000n);
  });

  it('maps Fulcrum transaction-not-found errors to notFound status', async () => {
    const provider = new FulcrumProvider('bch:bitcoincash', {
      async request(method) {
        if (method === 'blockchain.transaction.get_height') {
          throw new Error('No transaction matching the requested hash was found');
        }
        throw new Error('unexpected method: ' + method);
      },
    });

    await expect(provider.getTransactionStatus('11'.repeat(32))).resolves.toEqual({
      kind: 'notFound',
    });
  });

  it('fails over to the next caller-provided transport', async () => {
    const attempts: string[] = [];
    const transport = new FailoverFulcrumTransport([
      {
        async request(method) {
          attempts.push(`offline:${method}`);
          throw new Error('offline');
        },
      },
      {
        async request(method) {
          attempts.push(`online:${method}`);
          return { height: 123 };
        },
      },
    ]);
    const provider = new FulcrumProvider('bch:bitcoincash', transport);

    await expect(provider.getTipHeight()).resolves.toBe(123);
    expect(attempts).toEqual([
      'offline:blockchain.headers.subscribe',
      'online:blockchain.headers.subscribe',
    ]);
  });

  it('rejects an empty failover set', () => {
    expect(() => new FailoverFulcrumTransport([])).toThrow(
      'at least one Fulcrum transport is required',
    );
  });
});
