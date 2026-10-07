import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from '@x402/core/types';
import {
  DEFAULT_BCH_POLICY,
  BCH_ASSET,
  bytesToBase64,
  createBchPaymentTarget,
  decodeCashAddrScript,
  hash160,
  isSupportedMerchantScript,
  p2pkhScript,
  pushData,
  parseTransaction,
  serializeTransaction,
  signingHash,
  verifyPayment,
  type BchPaymentTarget,
  type BchPolicy,
  type BchTransaction,
  type BchTxInput,
  type BchTxOutput,
} from '../../crypto';
import {
  toBchTransactionRequest,
  type BchProvider,
  type BchSigner,
  type BchUtxo,
  type ExactBchRequirements,
  type BchWallet,
} from '../../types';

export class ExactBchScheme implements SchemeNetworkClient {
  readonly scheme = 'exact';

  constructor(
    private readonly signerOrWallet: BchSigner | BchWallet,
    private readonly provider: BchProvider,
    private readonly policy: BchPolicy = DEFAULT_BCH_POLICY,
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, 'x402Version' | 'payload'>> {
    if (x402Version !== 2) throw new Error('BCH exact supports x402 version 2 only');
    const requirements = validateRequirements(paymentRequirements, this.provider.network);
    const request = toBchTransactionRequest(requirements);
    if (isBchWallet(this.signerOrWallet)) {
      return this.createWalletPaymentPayload(x402Version, requirements, request);
    }
    const target = createBchPaymentTarget(
      request.token?.category ?? BCH_ASSET,
      (request.token?.amount ?? request.amount).toString(),
      requirements.extra,
      this.policy,
    );
    const merchant = decodeCashAddrScript(request.recipient.address, requirements.network);
    if (target.kind === 'cashtoken' && !merchant.tokenSupport) {
      throw new Error('CashToken payments require a token-support merchant CashAddr');
    }

    const signer = this.signerOrWallet;
    const payerAddress = signer.getAddress(requirements.network);
    const payerScript = p2pkhScript(hash160(signer.getPublicKey()));
    const utxos = (await this.provider.listUtxos(payerAddress)).filter((utxo) =>
      equalBytes(utxo.scriptPubKey, payerScript),
    );
    const tokenUtxos =
      target.kind === 'cashtoken'
        ? utxos.filter(
            (utxo) =>
              utxo.token !== undefined &&
              utxo.token.category === target.category &&
              (target.nft === undefined
                ? utxo.token.nft === undefined
                : utxo.token.nft !== undefined &&
                  utxo.token.nft.capability === target.nft.capability &&
                  equalBytes(utxo.token.nft.commitment, target.nft.commitment)),
          )
        : [];
    const pureBchUtxos = utxos.filter((utxo) => utxo.token === undefined);
    const candidates = target.kind === 'native' ? pureBchUtxos : tokenUtxos;
    candidates.sort(compareValueDescending);
    pureBchUtxos.sort(compareValueDescending);

    const selected: BchUtxo[] = [];
    let selectedValue = 0n;
    let selectedTokenAmount = 0n;
    for (const utxo of candidates) {
      selected.push(utxo);
      selectedValue += utxo.value;
      selectedTokenAmount += utxo.token?.amount ?? 0n;
      const estimatedSize = 10n + BigInt(selected.length * 180 + 68);
      if (
        selectedTokenAmount >= (target.kind === 'cashtoken' ? target.amount : 0n) &&
        selectedValue >= target.merchantValue + estimatedSize * this.policy.feeRateSatPerByte
      ) {
        break;
      }
    }
    if (target.kind === 'cashtoken') {
      for (const utxo of pureBchUtxos) {
        if (
          selectedTokenAmount >= target.amount &&
          selectedValue >= target.merchantValue + 10n * this.policy.feeRateSatPerByte
        ) {
          break;
        }
        selected.push(utxo);
        selectedValue += utxo.value;
      }
    }

    if (
      (target.kind === 'cashtoken' && selectedTokenAmount < target.amount) ||
      selectedValue < target.merchantValue
    ) {
      throw new Error('insufficient BCH/CashToken UTXOs for payment and fee');
    }

    const transaction = await buildAndSignTransaction(
      selected,
      merchant.scriptPubKey,
      target,
      signer,
      this.policy,
    );
    verifyPayment(
      transaction,
      selected.map((utxo) => ({
        value: utxo.value,
        scriptPubKey: utxo.scriptPubKey,
        token: utxo.token,
      })),
      requirements.network,
      merchant.scriptPubKey,
      target,
      this.policy,
    );
    return {
      x402Version,
      payload: { transaction: bytesToBase64(serializeTransaction(transaction)) },
    };
  }

  private async createWalletPaymentPayload(
    x402Version: number,
    requirements: ExactBchRequirements,
    request: ReturnType<typeof toBchTransactionRequest>,
  ): Promise<Pick<PaymentPayload, 'x402Version' | 'payload'>> {
    const raw = await (this.signerOrWallet as BchWallet).createPayment(request);
    const transaction = parseTransaction(raw);
    const merchant = decodeCashAddrScript(request.recipient.address, requirements.network);
    const target = createBchPaymentTarget(
      requirements.asset,
      requirements.amount,
      requirements.extra,
      this.policy,
    );
    const sources = await Promise.all(
      transaction.inputs.map((input) => this.provider.getSourceOutput(input.outpoint)),
    );
    verifyPayment(
      transaction,
      sources,
      requirements.network,
      merchant.scriptPubKey,
      target,
      this.policy,
    );
    return { x402Version, payload: { transaction: bytesToBase64(raw) } };
  }
}

function isBchWallet(value: BchSigner | BchWallet): value is BchWallet {
  return 'createPayment' in value;
}

export async function buildAndSignTransaction(
  selected: Array<BchUtxo>,
  merchantScript: Uint8Array,
  merchantAmountOrTarget: bigint | BchPaymentTarget,
  signer: BchSigner,
  policy: BchPolicy = DEFAULT_BCH_POLICY,
): Promise<BchTransaction> {
  const target: BchPaymentTarget =
    typeof merchantAmountOrTarget === 'bigint'
      ? { kind: 'native', amount: merchantAmountOrTarget, merchantValue: merchantAmountOrTarget }
      : merchantAmountOrTarget;
  if (selected.length === 0 || selected.length > policy.maxInputs) {
    throw new Error('invalid BCH input count');
  }
  if (!isSupportedMerchantScript(merchantScript)) {
    throw new Error('BCH exact requires P2PKH, P2SH20, or P2SH32 merchant output');
  }
  if (target.merchantValue < policy.dustThreshold) throw new Error('merchant output is dust');
  const inputValue = selected.reduce(
    (total, utxo) => addU64(total, utxo.value, 'BCH input value'),
    0n,
  );
  const inputTokenAmount = selected.reduce(
    (total, utxo) => addU64(total, utxo.token?.amount ?? 0n, 'CashToken input amount'),
    0n,
  );
  if (target.kind === 'cashtoken' && inputTokenAmount < target.amount) {
    throw new Error('selected CashToken UTXOs do not cover payment');
  }
  if (inputValue < target.merchantValue) throw new Error('selected BCH UTXOs do not cover payment');

  const changeScript = p2pkhScript(hash160(signer.getPublicKey()));
  let change = inputValue - target.merchantValue;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const tokenChange = target.kind === 'cashtoken' ? inputTokenAmount - target.amount : 0n;
    const includeChange = change >= policy.dustThreshold || tokenChange > 0n;
    if (includeChange && change < policy.dustThreshold) {
      throw new Error('CashToken change requires a dust-valued BCH change output');
    }
    const transaction = makeUnsignedTransaction(
      selected,
      merchantScript,
      target,
      includeChange
        ? {
            value: change,
            scriptPubKey: changeScript,
            ...(tokenChange > 0n && target.kind === 'cashtoken'
              ? { token: { category: target.category, amount: tokenChange } }
              : {}),
          }
        : undefined,
    );
    await signTransaction(transaction, selected, signer);
    const requiredFee = BigInt(serializeTransaction(transaction).length) * policy.feeRateSatPerByte;
    const available = inputValue - target.merchantValue;
    if (!includeChange) {
      if (available < requiredFee) throw new Error('selected BCH UTXOs do not cover fee');
      if (serializeTransaction(transaction).length > policy.maxTransactionSize) {
        throw new Error('transaction exceeds maximum size');
      }
      return transaction;
    }

    const desiredChange = available - requiredFee;
    if (desiredChange < policy.dustThreshold) {
      if (tokenChange > 0n) throw new Error('selected BCH UTXOs do not cover token change dust');
      change = 0n;
      continue;
    }
    if (change > desiredChange) {
      change = desiredChange;
      continue;
    }
    if (serializeTransaction(transaction).length > policy.maxTransactionSize) {
      throw new Error('transaction exceeds maximum size');
    }
    return transaction;
  }
  throw new Error('BCH fee/change calculation did not converge');
}

async function signTransaction(
  transaction: BchTransaction,
  selected: Array<BchUtxo>,
  signer: BchSigner,
): Promise<void> {
  const publicKey = signer.getPublicKey();
  for (let index = 0; index < selected.length; index += 1) {
    const digest = signingHash(transaction, index, {
      value: selected[index].value,
      scriptPubKey: selected[index].scriptPubKey,
      token: selected[index].token,
    });
    const signature = Uint8Array.from([...(await signer.signDigest(digest)), 0x41]);
    transaction.inputs[index].scriptSig = Uint8Array.from([
      ...pushData(signature),
      ...pushData(publicKey),
    ]);
  }
}

function makeUnsignedTransaction(
  selected: Array<BchUtxo>,
  merchantScript: Uint8Array,
  target: BchPaymentTarget,
  change?: BchTxOutput,
): BchTransaction {
  const inputs: BchTxInput[] = selected.map((utxo) => ({
    outpoint: { txid: utxo.txid, vout: utxo.vout },
    scriptSig: new Uint8Array(),
    sequence: 0xffffffff,
  }));
  const outputs: BchTxOutput[] = [
    {
      value: target.merchantValue,
      scriptPubKey: merchantScript,
      ...(target.kind === 'cashtoken'
        ? {
            token: {
              category: target.category,
              amount: target.amount,
              ...(target.nft === undefined ? {} : { nft: target.nft }),
            },
          }
        : {}),
    },
  ];
  if (change) outputs.push(change);
  return { version: 2, inputs, outputs, lockTime: 0 };
}

function validateRequirements(
  value: PaymentRequirements,
  network: ExactBchRequirements['network'],
): ExactBchRequirements {
  if (value.scheme !== 'exact') throw new Error('unsupported BCH scheme');
  if (value.network !== network) throw new Error('BCH network mismatch');
  if (value.extra?.paymentFlow !== 'upfront') {
    throw new Error('BCH exact requires upfront payment flow');
  }
  createBchPaymentTarget(value.asset, value.amount, value.extra);
  return value as ExactBchRequirements;
}

function compareValueDescending(left: BchUtxo, right: BchUtxo): number {
  return left.value < right.value ? 1 : left.value > right.value ? -1 : 0;
}

function addU64(left: bigint, right: bigint, label: string): bigint {
  const result = left + right;
  if (right < 0n || result > 0xffffffffffffffffn) throw new Error(`${label} exceeds u64`);
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
