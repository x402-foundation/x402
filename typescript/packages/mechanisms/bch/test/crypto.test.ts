import { describe, expect, it } from 'vitest';
import {
  decodeCashAddr,
  encodeCashAddr,
  hexToBytes,
  hash160,
  parseTransaction,
  p2pkhScript,
  serializeTransaction,
  signingHash,
  transactionId,
  verifyPayment,
} from '../src/crypto';
import { buildAndSignTransaction } from '../src/exact/client/scheme';
import { createSecp256k1BchSigner } from '../src/signer';
import type { BchNetwork } from '../src/types';
import fixture from './fixtures/bch-exact-p2pkh.json';

const NETWORK: BchNetwork = 'bch:bitcoincash';
const SECRET_KEY = new Uint8Array(32).fill(1);

describe('BCH CashAddr and transaction primitives', () => {
  it('round-trips a standard mainnet P2PKH CashAddr', () => {
    const hash = new Uint8Array(20).fill(0x11);
    const address = encodeCashAddr(hash, NETWORK);

    expect(address).toBe('bitcoincash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zye3kwllue');
    expect(decodeCashAddr(address, NETWORK)).toEqual(hash);
    expect(() => decodeCashAddr(address, 'bch:bchtest')).toThrow(/network mismatch/);
  });

  it('constructs, signs, serializes, parses, and verifies a BCH exact payment', async () => {
    const signer = createSecp256k1BchSigner(SECRET_KEY);
    const payerAddress = signer.getAddress(NETWORK);
    const merchantHash = new Uint8Array(20).fill(0x22);
    const merchantScript = p2pkhScript(merchantHash);
    const selected = [
      {
        txid: '00'.repeat(32),
        vout: 0,
        value: 100_000n,
        scriptPubKey: p2pkhScript(hash160(signer.getPublicKey())),
      },
    ];

    const transaction = await buildAndSignTransaction(selected, merchantScript, 1_000n, signer);
    const raw = serializeTransaction(transaction);
    const parsed = parseTransaction(raw);
    const result = verifyPayment(
      parsed,
      selected.map(({ value, scriptPubKey }) => ({ value, scriptPubKey })),
      NETWORK,
      merchantScript,
      1_000n,
    );

    expect(parsed).toEqual(transaction);
    expect(result.payer).toBe(payerAddress);
    expect(result.fee).toBe(226n);
    expect(result.txid).toBe(transactionId(transaction));
  });

  it('verifies the deterministic BCH exact interoperability fixture', () => {
    const transaction = parseTransaction(hexToBytes(fixture.rawTransaction));
    const merchantHash = decodeCashAddr(fixture.payTo, fixture.network);
    const result = verifyPayment(
      transaction,
      [
        {
          value: BigInt(fixture.sourceValue),
          scriptPubKey: hexToBytes(fixture.sourceScriptPubKey),
        },
      ],
      fixture.network,
      p2pkhScript(merchantHash),
      BigInt(fixture.amount),
    );

    expect(result).toMatchObject({
      txid: fixture.txid,
      payer: fixture.payer,
      fee: BigInt(fixture.fee),
    });
    expect(serializeTransaction(transaction).length).toBe(fixture.serializedSize);
  });

  it('rejects dust payments and trailing transaction bytes', () => {
    const transactionBytes = hexToBytes(fixture.rawTransaction);
    const transaction = parseTransaction(transactionBytes);
    const merchantHash = decodeCashAddr(fixture.payTo, fixture.network);
    const source = [
      {
        value: BigInt(fixture.sourceValue),
        scriptPubKey: hexToBytes(fixture.sourceScriptPubKey),
      },
    ];

    expect(() =>
      verifyPayment(transaction, source, fixture.network, p2pkhScript(merchantHash), 545n),
    ).toThrow('merchant output is dust');
    expect(() => parseTransaction(Uint8Array.from([...transactionBytes, 0]))).toThrow(
      'trailing transaction bytes',
    );
  });

  it('rejects change sent to a different P2PKH owner', async () => {
    const signer = createSecp256k1BchSigner(SECRET_KEY);
    const merchantScript = p2pkhScript(new Uint8Array(20).fill(0x22));
    const selected = [
      {
        txid: '00'.repeat(32),
        vout: 0,
        value: 100_000n,
        scriptPubKey: p2pkhScript(hash160(signer.getPublicKey())),
      },
    ];
    const transaction = await buildAndSignTransaction(selected, merchantScript, 1_000n, signer);
    const tampered = {
      ...transaction,
      outputs: transaction.outputs.map((output, index) =>
        index === 1
          ? { ...output, scriptPubKey: p2pkhScript(new Uint8Array(20).fill(0x33)) }
          : output,
      ),
    };
    const signature = Uint8Array.from([
      ...(await signer.signDigest(signingHash(tampered, 0, selected[0]))),
      0x41,
    ]);
    tampered.inputs[0].scriptSig = Uint8Array.from([
      ...[signature.length, ...signature],
      ...[signer.getPublicKey().length, ...signer.getPublicKey()],
    ]);
    expect(() =>
      verifyPayment(
        tampered,
        selected.map(({ value, scriptPubKey }) => ({ value, scriptPubKey })),
        NETWORK,
        merchantScript,
        1_000n,
      ),
    ).toThrow('change output must return to the payer');
  });
});
