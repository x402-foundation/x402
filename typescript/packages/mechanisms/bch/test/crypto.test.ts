import { describe, expect, it } from 'vitest';
import {
  decodeCashAddr,
  decodeCashAddrScript,
  createBchPaymentTarget,
  encodeCashAddr,
  hexToBytes,
  hash160,
  parseTransaction,
  p2pkhScript,
  p2sh32Script,
  serializeTransaction,
  signingHash,
  transactionId,
  verifyPayment,
} from '../src/crypto';
import { buildAndSignTransaction } from '../src/exact/client/scheme';
import { createSecp256k1BchSignerFromMnemonic, deriveBchWalletAddress } from '../src/signer';
import { toBchTransactionNetwork, toBchTransactionRequest, type BchNetwork } from '../src/types';
import cashtokenFixture from './fixtures/bch-exact-cashtoken-p2sh32.json';
import fixture from './fixtures/bch-exact-p2pkh.json';
import twoInputFixture from './fixtures/bch-exact-p2pkh-two-inputs.json';

const NETWORK: BchNetwork = 'bch:bitcoincash';
const BIP39_VECTOR_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

describe('BCH CashAddr and transaction primitives', () => {
  it('maps x402 BCH networks into BCH transaction requests', () => {
    const request = toBchTransactionRequest({
      network: 'bch:bchtest',
      payTo: 'bchtest:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zye3kwllue',
      amount: '1000',
      asset: 'BCH',
      extra: { assetTransferMethod: 'native', paymentFlow: 'upfront' },
    });
    expect(toBchTransactionNetwork('bch:bitcoincash')).toBe('mainnet');
    expect(request).toEqual({
      network: 'chipnet',
      recipient: { address: 'bchtest:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zye3kwllue' },
      amount: 1000n,
    });
  });

  it('supports exact CashToken NFT requests and preserves the commitment', async () => {
    const signer = createSecp256k1BchSignerFromMnemonic(BIP39_VECTOR_MNEMONIC);
    const category = '00'.repeat(31) + '02';
    const commitment = new Uint8Array([0xaa, 0xbb]);
    const target = createBchPaymentTarget('00'.repeat(32 - 1) + '02', '0', {
      assetTransferMethod: 'cashtoken',
      token: { category, amount: '0', nft: { capability: 'none', commitment: 'aabb' } },
    });
    const selected = [
      {
        txid: '11'.repeat(32),
        vout: 0,
        value: 100_000n,
        scriptPubKey: p2pkhScript(hash160(signer.getPublicKey())),
        token: { category, amount: 0n, nft: { capability: 'none' as const, commitment } },
      },
    ];
    const merchant = decodeCashAddrScript(
      'bitcoincash:rv3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyh0xp0zdk',
      NETWORK,
    );
    const transaction = await buildAndSignTransaction(
      selected,
      merchant.scriptPubKey,
      target,
      signer,
    );
    expect(transaction.outputs[0]?.token).toEqual({
      category,
      amount: 0n,
      nft: { capability: 'none', commitment },
    });
  });
  it("derives the chipnet BIP44 account at m/44'/1'/0'/0/0", () => {
    const signer = createSecp256k1BchSignerFromMnemonic(BIP39_VECTOR_MNEMONIC);

    expect(signer.getAddress('bch:bchtest')).toBe(
      'bchtest:qp7zymyamk2cf6rxgdwcagxwzmyaqjg9ksvqydu0dl',
    );
  });

  it('derives separate receive and change branches for both BCH networks', () => {
    const receive = deriveBchWalletAddress(BIP39_VECTOR_MNEMONIC, 'bch:bchtest', 0, 0);
    const change = deriveBchWalletAddress(BIP39_VECTOR_MNEMONIC, 'bch:bchtest', 1, 0);
    const mainnet = deriveBchWalletAddress(BIP39_VECTOR_MNEMONIC, 'bch:bitcoincash', 0, 0);
    expect(receive.path).toBe("m/44'/1'/0'/0/0");
    expect(change.path).toBe("m/44'/1'/0'/1/0");
    expect(mainnet.path).toBe("m/44'/145'/0'/0/0");
    expect(new Set([receive.address, change.address, mainnet.address]).size).toBe(3);
  });

  it('rejects an invalid BIP39 mnemonic before deriving a key', () => {
    expect(() => createSecp256k1BchSignerFromMnemonic('not a valid mnemonic')).toThrow(
      'Invalid BIP39 mnemonic',
    );
  });

  it('round-trips a standard mainnet P2PKH CashAddr', () => {
    const hash = new Uint8Array(20).fill(0x11);
    const address = encodeCashAddr(hash, NETWORK);

    expect(address).toBe('bitcoincash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zye3kwllue');
    expect(decodeCashAddr(address, NETWORK)).toEqual(hash);
    expect(() => decodeCashAddr(address, 'bch:bchtest')).toThrow(/network mismatch/);
  });

  it('accepts CashScript P2SH32 outputs and fungible CashToken change', async () => {
    const signer = createSecp256k1BchSignerFromMnemonic(BIP39_VECTOR_MNEMONIC);
    const category = '00'.repeat(31) + '01';
    const merchantAddress =
      'bitcoincash:pv3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zy9u6qkr5a';
    const merchant = decodeCashAddrScript(merchantAddress, NETWORK);
    expect(merchant.tokenSupport).toBe(false);
    expect(merchant.scriptPubKey).toEqual(p2sh32Script(new Uint8Array(32).fill(0x22)));
    const tokenMerchantAddress =
      'bitcoincash:rv3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyh0xp0zdk';
    const tokenMerchant = decodeCashAddrScript(tokenMerchantAddress, NETWORK);
    expect(tokenMerchant.tokenSupport).toBe(true);

    const selected = [
      {
        txid: '00'.repeat(32),
        vout: 0,
        value: 100_000n,
        scriptPubKey: p2pkhScript(hash160(signer.getPublicKey())),
        token: { category, amount: 1_500n },
      },
    ];
    const target = { kind: 'cashtoken' as const, category, amount: 1_000n, merchantValue: 1_000n };
    const transaction = await buildAndSignTransaction(
      selected,
      tokenMerchant.scriptPubKey,
      target,
      signer,
    );
    const parsed = parseTransaction(serializeTransaction(transaction));
    const result = verifyPayment(
      parsed,
      selected.map(({ value, scriptPubKey, token }) => ({ value, scriptPubKey, token })),
      NETWORK,
      tokenMerchant.scriptPubKey,
      target,
    );

    expect(parsed.outputs[0].token).toEqual({ category, amount: 1_000n });
    expect(parsed.outputs[1].token).toEqual({ category, amount: 500n });
    expect(result.payer).toBe(signer.getAddress(NETWORK));
  });

  it('uses the BCH token range for target validation', () => {
    expect(() =>
      verifyPayment(
        parseTransaction(hexToBytes(fixture.rawTransaction)),
        [
          {
            value: BigInt(fixture.sourceValue),
            scriptPubKey: hexToBytes(fixture.sourceScriptPubKey),
          },
        ],
        NETWORK,
        p2pkhScript(decodeCashAddr(fixture.payTo, NETWORK)),
        { kind: 'cashtoken', category: '00'.repeat(32), amount: 0n, merchantValue: 1_000n },
      ),
    ).toThrow('CashToken amount is outside the BCH token range');
  });

  it('verifies the shared CashToken P2SH32 interoperability fixture', () => {
    const transaction = parseTransaction(hexToBytes(cashtokenFixture.rawTransaction));
    const merchant = decodeCashAddrScript(cashtokenFixture.payTo, cashtokenFixture.network);
    const result = verifyPayment(
      transaction,
      [
        {
          value: BigInt(cashtokenFixture.sourceValue),
          scriptPubKey: hexToBytes(cashtokenFixture.sourceScriptPubKey),
          token: {
            category: cashtokenFixture.sourceToken.category,
            amount: BigInt(cashtokenFixture.sourceToken.amount),
          },
        },
      ],
      cashtokenFixture.network,
      merchant.scriptPubKey,
      {
        kind: 'cashtoken',
        category: cashtokenFixture.asset,
        amount: BigInt(cashtokenFixture.amount),
        merchantValue: BigInt(cashtokenFixture.tokenOutputValue),
      },
    );

    expect(merchant.tokenSupport).toBe(true);
    expect(result.txid).toBe(cashtokenFixture.txid);
    expect(transaction.outputs[0].token?.amount).toBe(BigInt(cashtokenFixture.merchantTokenAmount));
    expect(transaction.outputs[1].token?.amount).toBe(BigInt(cashtokenFixture.changeTokenAmount));
    expect(serializeTransaction(transaction).length).toBe(cashtokenFixture.serializedSize);
  });

  it('constructs, signs, serializes, parses, and verifies a BCH exact payment', async () => {
    const signer = createSecp256k1BchSignerFromMnemonic(BIP39_VECTOR_MNEMONIC);
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

  it('verifies the shared two-input BCH interoperability fixture', () => {
    const transaction = parseTransaction(hexToBytes(twoInputFixture.rawTransaction));
    const merchantHash = decodeCashAddr(twoInputFixture.payTo, twoInputFixture.network);
    const result = verifyPayment(
      transaction,
      twoInputFixture.sources.map((source) => ({
        value: BigInt(source.value),
        scriptPubKey: hexToBytes(source.scriptPubKey),
      })),
      twoInputFixture.network,
      p2pkhScript(merchantHash),
      BigInt(twoInputFixture.amount),
    );

    expect(transaction.inputs).toHaveLength(2);
    expect(result).toMatchObject({
      txid: twoInputFixture.txid,
      payer: twoInputFixture.payer,
      fee: BigInt(twoInputFixture.fee),
    });
    expect(serializeTransaction(transaction).length).toBe(twoInputFixture.serializedSize);
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
    const signer = createSecp256k1BchSignerFromMnemonic(BIP39_VECTOR_MNEMONIC);
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
