import {
  decodeCashAddress as decodeLibauthCashAddress,
  cashAddressToLockingBytecode,
  decodeTransactionBCH,
  encodeCashAddress as encodeLibauthCashAddress,
  encodeTransactionBCH,
  generateSigningSerializationBCH,
  hash160 as libauthHash160,
  hash256 as libauthHash256,
  secp256k1,
} from '@bitauth/libauth';
import type { BchNetwork, BchOutPoint, BchSourceOutput, BchTokenCapability } from './types';

export const SIGHASH_ALL_FORKID = 0x41;
export const BCH_ASSET = 'BCH';
const MAX_U64 = 0xffffffffffffffffn;
const MAX_CASH_TOKEN_AMOUNT = 0x7fffffffffffffffn;

const NETWORK_PREFIX: Record<BchNetwork, 'bitcoincash' | 'bchtest'> = {
  'bch:bitcoincash': 'bitcoincash',
  'bch:bchtest': 'bchtest',
};

export type TxId = string;

export type BchToken = {
  category: string;
  amount: bigint;
  nft?: {
    capability: BchTokenCapability;
    commitment: Uint8Array;
  };
};

export type BchPaymentTarget =
  | { kind: 'native'; amount: bigint; merchantValue: bigint }
  | {
      kind: 'cashtoken';
      category: string;
      amount: bigint;
      merchantValue: bigint;
      nft?: BchToken['nft'];
    };

export type BchTxInput = {
  outpoint: BchOutPoint;
  scriptSig: Uint8Array;
  sequence: number;
};

export type BchTxOutput = {
  value: bigint;
  scriptPubKey: Uint8Array;
  token?: BchToken;
};

export type BchTransaction = {
  version: number;
  inputs: BchTxInput[];
  outputs: BchTxOutput[];
  lockTime: number;
};

export type BchPolicy = {
  feeRateSatPerByte: bigint;
  dustThreshold: bigint;
  maxTransactionSize: number;
  maxInputs: number;
};

export const DEFAULT_BCH_POLICY: BchPolicy = {
  feeRateSatPerByte: 1n,
  dustThreshold: 546n,
  maxTransactionSize: 100_000,
  maxInputs: 100,
};

export function createBchPaymentTarget(
  asset: string,
  amount: string,
  extra: {
    assetTransferMethod?: string;
    tokenOutputValue?: string;
    token?: {
      category?: string;
      amount?: string;
      nft?: { capability: BchTokenCapability; commitment: string };
    };
  },
  policy: BchPolicy = DEFAULT_BCH_POLICY,
): BchPaymentTarget {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) {
    throw new Error('BCH amount must be canonical unsigned units');
  }
  const parsedAmount = BigInt(amount);
  if (parsedAmount > MAX_U64) throw new Error('BCH amount exceeds u64');
  if (asset === BCH_ASSET) {
    if (extra.assetTransferMethod !== 'native') throw new Error('BCH requires native transfer');
    return { kind: 'native', amount: parsedAmount, merchantValue: parsedAmount };
  }
  if (extra.assetTransferMethod !== 'cashtoken' || !isCashTokenCategory(asset)) {
    throw new Error('BCH asset must be BCH or a CashToken category');
  }
  if (extra.token?.category !== undefined && extra.token.category !== asset) {
    throw new Error('CashToken token category must match the asset');
  }
  const tokenAmount = extra.token?.amount ?? amount;
  if (tokenAmount !== amount) throw new Error('CashToken token amount must match amount');
  if (extra.token?.nft !== undefined) {
    if (!['none', 'mutable', 'minting'].includes(extra.token.nft.capability)) {
      throw new Error('CashToken NFT capability is invalid');
    }
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(extra.token.nft.commitment)) {
      throw new Error('CashToken NFT commitment must be non-empty hex');
    }
  }
  if (
    (parsedAmount === 0n && extra.token?.nft === undefined) ||
    parsedAmount > MAX_CASH_TOKEN_AMOUNT
  ) {
    throw new Error('CashToken amount is outside the BCH token range');
  }
  const merchantValue = extra.tokenOutputValue ?? policy.dustThreshold.toString();
  if (!/^(0|[1-9][0-9]*)$/.test(merchantValue)) {
    throw new Error('CashToken output value must be canonical satoshis');
  }
  const parsedMerchantValue = BigInt(merchantValue);
  if (parsedMerchantValue > MAX_U64) {
    throw new Error('CashToken output value exceeds u64');
  }
  return {
    kind: 'cashtoken',
    category: asset,
    amount: parsedAmount,
    merchantValue: parsedMerchantValue,
    ...(extra.token?.nft === undefined
      ? {}
      : {
          nft: {
            capability: extra.token.nft.capability,
            commitment: hexToBytes(extra.token.nft.commitment),
          },
        }),
  };
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new Error('invalid hexadecimal value');
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function hash160(value: Uint8Array): Uint8Array {
  return libauthHash160(value);
}

export function doubleSha256(value: Uint8Array): Uint8Array {
  return libauthHash256(value);
}

export function p2pkhScript(hash: Uint8Array): Uint8Array {
  if (hash.length !== 20) throw new Error('P2PKH hash must be 20 bytes');
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac]);
}

export function p2sh20Script(hash: Uint8Array): Uint8Array {
  if (hash.length !== 20) throw new Error('P2SH20 hash must be 20 bytes');
  return Uint8Array.from([0xa9, 0x14, ...hash, 0x87]);
}

export function p2sh32Script(hash: Uint8Array): Uint8Array {
  if (hash.length !== 32) throw new Error('P2SH32 hash must be 32 bytes');
  return Uint8Array.from([0xaa, 0x20, ...hash, 0x87]);
}

export function isP2pkhScript(script: Uint8Array): boolean {
  return (
    script.length === 25 &&
    script[0] === 0x76 &&
    script[1] === 0xa9 &&
    script[2] === 0x14 &&
    script[23] === 0x88 &&
    script[24] === 0xac
  );
}

export function isP2sh20Script(script: Uint8Array): boolean {
  return script.length === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87;
}

export function isP2sh32Script(script: Uint8Array): boolean {
  return script.length === 35 && script[0] === 0xaa && script[1] === 0x20 && script[34] === 0x87;
}

export function isSupportedMerchantScript(script: Uint8Array): boolean {
  return isP2pkhScript(script) || isP2sh20Script(script) || isP2sh32Script(script);
}

export function isCashTokenCategory(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

export function decodeCashAddrScript(
  value: string,
  network: BchNetwork,
): { scriptPubKey: Uint8Array; tokenSupport: boolean } {
  if (value !== value.toLowerCase()) throw new Error('CashAddr must be lowercase');
  const decoded = cashAddressToLockingBytecode(value);
  if (typeof decoded === 'string') throw new Error(decoded);
  if (decoded.prefix !== NETWORK_PREFIX[network]) throw new Error('CashAddr network mismatch');
  if (!isSupportedMerchantScript(decoded.bytecode)) throw new Error('unsupported CashAddr type');
  return { scriptPubKey: decoded.bytecode, tokenSupport: decoded.tokenSupport };
}

export function decodeCashAddr(value: string, network: BchNetwork): Uint8Array {
  if (value !== value.toLowerCase()) throw new Error('CashAddr must be lowercase');
  const decoded = decodeLibauthCashAddress(value);
  if (typeof decoded === 'string') throw new Error(decoded);
  if (decoded.prefix !== NETWORK_PREFIX[network]) throw new Error('CashAddr network mismatch');
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    throw new Error('CashAddr type mismatch');
  }
  return decoded.payload;
}

export function encodeCashAddr(hash: Uint8Array, network: BchNetwork): string {
  if (hash.length !== 20) throw new Error('P2PKH hash must be 20 bytes');
  const encoded = encodeLibauthCashAddress({
    payload: hash,
    prefix: NETWORK_PREFIX[network],
    type: 'p2pkh',
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}

function toLibauthTransaction(transaction: BchTransaction) {
  return {
    version: transaction.version,
    inputs: transaction.inputs.map((input) => ({
      outpointIndex: input.outpoint.vout,
      outpointTransactionHash: hexToBytes(input.outpoint.txid),
      sequenceNumber: input.sequence,
      unlockingBytecode: input.scriptSig,
    })),
    outputs: transaction.outputs.map((output) => ({
      valueSatoshis: output.value,
      lockingBytecode: output.scriptPubKey,
      ...(output.token === undefined ? {} : { token: toLibauthToken(output.token) }),
    })),
    locktime: transaction.lockTime,
  };
}

function fromLibauthTransaction(transaction: {
  version: number;
  inputs: Array<{
    outpointIndex: number;
    outpointTransactionHash: Uint8Array;
    sequenceNumber: number;
    unlockingBytecode: Uint8Array;
  }>;
  outputs: Array<{
    valueSatoshis: bigint;
    lockingBytecode: Uint8Array;
    token?: {
      amount: bigint;
      category: Uint8Array;
      nft?: { capability: BchTokenCapability; commitment: Uint8Array };
    };
  }>;
  locktime: number;
}): BchTransaction {
  return {
    version: transaction.version,
    inputs: transaction.inputs.map((input) => ({
      outpoint: {
        txid: bytesToHex(input.outpointTransactionHash),
        vout: input.outpointIndex,
      },
      scriptSig: input.unlockingBytecode,
      sequence: input.sequenceNumber,
    })),
    outputs: transaction.outputs.map((output) => ({
      value: output.valueSatoshis,
      scriptPubKey: output.lockingBytecode,
      ...(output.token === undefined ? {} : { token: fromLibauthToken(output.token) }),
    })),
    lockTime: transaction.locktime,
  };
}

function toLibauthToken(token: BchToken) {
  assertToken(token);
  return {
    amount: token.amount,
    category: hexToBytes(token.category),
    ...(token.nft === undefined
      ? {}
      : { nft: { capability: token.nft.capability, commitment: token.nft.commitment } }),
  };
}

function fromLibauthToken(token: {
  amount: bigint;
  category: Uint8Array;
  nft?: { capability: BchTokenCapability; commitment: Uint8Array };
}): BchToken {
  const result: BchToken = {
    amount: token.amount,
    category: bytesToHex(token.category),
  };
  if (token.nft !== undefined) result.nft = token.nft;
  assertToken(result);
  return result;
}

function assertToken(token: BchToken): void {
  if (!isCashTokenCategory(token.category))
    throw new Error('CashToken category must be 32-byte hex');
  if (token.amount < 0n || token.amount > 0x7fffffffffffffffn) {
    throw new Error('CashToken amount exceeds the BCH consensus range');
  }
  if (token.nft === undefined && token.amount === 0n) {
    throw new Error('CashToken output must contain a fungible amount or NFT');
  }
  if (token.nft !== undefined) {
    if (!['none', 'mutable', 'minting'].includes(token.nft.capability)) {
      throw new Error('invalid CashToken NFT capability');
    }
    if (token.nft.commitment.length > 40) throw new Error('CashToken commitment is too large');
  }
}

export function parseTransaction(raw: Uint8Array): BchTransaction {
  const decoded = decodeTransactionBCH(raw);
  if (typeof decoded === 'string') {
    if (decoded.includes('unexpected bytes')) throw new Error('trailing transaction bytes');
    throw new Error(decoded);
  }
  return fromLibauthTransaction(decoded);
}

export function serializeTransaction(transaction: BchTransaction): Uint8Array {
  return encodeTransactionBCH(toLibauthTransaction(transaction));
}

export function transactionId(transaction: BchTransaction): string {
  return bytesToHex(libauthHash256(serializeTransaction(transaction)).slice().reverse());
}

export function signingHash(
  transaction: BchTransaction,
  inputIndex: number,
  source: BchSourceOutput,
): Uint8Array {
  if (inputIndex < 0 || inputIndex >= transaction.inputs.length)
    throw new Error('invalid input index');
  const serialization = generateSigningSerializationBCH(
    {
      inputIndex,
      sourceOutputs: transaction.inputs.map(() => ({
        valueSatoshis: source.value,
        lockingBytecode: source.scriptPubKey,
        ...(source.token === undefined ? {} : { token: toLibauthToken(source.token) }),
      })),
      transaction: toLibauthTransaction(transaction),
    },
    {
      coveredBytecode: source.scriptPubKey,
      signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID),
    },
  );
  return libauthHash256(serialization);
}

export function verifyP2pkhInput(
  transaction: BchTransaction,
  inputIndex: number,
  source: BchSourceOutput,
): Uint8Array {
  if (!isP2pkhScript(source.scriptPubKey)) throw new Error('source output is not P2PKH');
  const pushes = parsePushes(transaction.inputs[inputIndex]?.scriptSig ?? new Uint8Array());
  if (pushes.length !== 2 || pushes[0].length < 2) throw new Error('invalid P2PKH scriptSig');
  const signature = pushes[0];
  if (signature[signature.length - 1] !== SIGHASH_ALL_FORKID) {
    throw new Error('unsupported BCH sighash type');
  }
  assertStrictDer(signature.slice(0, -1));
  const publicKey = pushes[1];
  const publicKeyHash = hash160(publicKey);
  if (!equalBytes(publicKeyHash, source.scriptPubKey.slice(3, 23))) {
    throw new Error('P2PKH public key does not match source output');
  }
  if (
    !secp256k1.verifySignatureDER(
      signature.slice(0, -1),
      publicKey,
      signingHash(transaction, inputIndex, source),
    )
  ) {
    throw new Error('invalid BCH signature');
  }
  return publicKeyHash;
}

export function verifyPayment(
  transaction: BchTransaction,
  sources: BchSourceOutput[],
  network: BchNetwork,
  merchantScript: Uint8Array,
  merchantAmountOrTarget: bigint | BchPaymentTarget,
  policy: BchPolicy = DEFAULT_BCH_POLICY,
): { txid: string; payer: string; fee: bigint } {
  const target: BchPaymentTarget =
    typeof merchantAmountOrTarget === 'bigint'
      ? { kind: 'native', amount: merchantAmountOrTarget, merchantValue: merchantAmountOrTarget }
      : merchantAmountOrTarget;
  assertPaymentTarget(target);
  const serialized = serializeTransaction(transaction);
  if (serialized.length > policy.maxTransactionSize)
    throw new Error('transaction exceeds maximum size');
  if (transaction.inputs.length === 0 || transaction.inputs.length > policy.maxInputs) {
    throw new Error('invalid input count');
  }
  if (transaction.lockTime !== 0) throw new Error('non-zero locktime is unsupported');
  if (target.merchantValue < policy.dustThreshold) throw new Error('merchant output is dust');
  if (sources.length !== transaction.inputs.length) throw new Error('source output count mismatch');
  if (transaction.outputs.length < 1 || transaction.outputs.length > 2) {
    throw new Error('BCH exact requires one merchant output and optional change');
  }
  let inputValue = 0n;
  let inputTokenAmount = 0n;
  let payerHash: Uint8Array | undefined;
  for (let index = 0; index < sources.length; index += 1) {
    inputValue = addU64(inputValue, sources[index].value, 'BCH input value');
    const inputPayerHash = verifyP2pkhInput(transaction, index, sources[index]);
    if (payerHash !== undefined && !equalBytes(payerHash, inputPayerHash)) {
      throw new Error('all BCH inputs must belong to the same payer');
    }
    payerHash ??= inputPayerHash;
    const token = sources[index].token;
    if (target.kind === 'native') {
      if (token !== undefined) throw new Error('native BCH payment cannot spend CashTokens');
    } else if (token !== undefined) {
      assertToken(token);
      if (
        token.category !== target.category ||
        (target.nft === undefined && token.nft !== undefined) ||
        (target.nft !== undefined && token.nft !== undefined && !sameNft(token.nft, target.nft))
      ) {
        throw new Error('CashToken input does not match the requested category or NFT');
      }
      inputTokenAmount = addU64(inputTokenAmount, token.amount, 'CashToken input amount');
    }
  }
  if (
    target.kind === 'cashtoken' &&
    target.nft !== undefined &&
    !sources.some((source) => sameNft(source.token?.nft, target.nft))
  ) {
    throw new Error('CashToken inputs do not contain the requested NFT');
  }
  if (target.kind === 'cashtoken' && inputTokenAmount < target.amount) {
    throw new Error('CashToken inputs do not cover the requested amount');
  }
  const merchantMatches = transaction.outputs.filter(
    (output) =>
      output.value === target.merchantValue &&
      equalBytes(output.scriptPubKey, merchantScript) &&
      matchesMerchantToken(output.token, target),
  ).length;
  if (merchantMatches !== 1) throw new Error('merchant output must match exactly once');
  let outputValue = 0n;
  let outputTokenAmount = 0n;
  for (const output of transaction.outputs) {
    const isMerchant =
      output.value === target.merchantValue && equalBytes(output.scriptPubKey, merchantScript);
    if (!isMerchant && !isP2pkhScript(output.scriptPubKey))
      throw new Error('BCH exact supports P2PKH outputs only');
    if (output.token !== undefined) {
      assertToken(output.token);
      if (target.kind === 'native') throw new Error('native BCH payment cannot create CashTokens');
      if (output.token.nft !== undefined || output.token.category !== target.category) {
        throw new Error('CashToken output does not match the requested fungible category');
      }
      outputTokenAmount = addU64(outputTokenAmount, output.token.amount, 'CashToken output amount');
    }
    outputValue = addU64(outputValue, output.value, 'BCH output value');
  }
  if (target.kind === 'native') {
    if (outputTokenAmount !== 0n) throw new Error('native BCH payment cannot create CashTokens');
  } else if (outputTokenAmount !== inputTokenAmount) {
    throw new Error('CashToken amount is not conserved');
  }
  const fee = inputValue - outputValue;
  if (fee < BigInt(serialized.length) * policy.feeRateSatPerByte) {
    throw new Error('transaction fee is below the required BCH fee rate');
  }
  if (transaction.outputs.length === 2) {
    if (!payerHash) throw new Error('missing payer');
    const change = transaction.outputs.find(
      (output) =>
        !(output.value === target.merchantValue && equalBytes(output.scriptPubKey, merchantScript)),
    );
    if (!change || change.value < policy.dustThreshold) throw new Error('change output is dust');
    if (equalBytes(change.scriptPubKey, merchantScript))
      throw new Error('duplicate merchant output');
    if (!equalBytes(change.scriptPubKey, p2pkhScript(payerHash))) {
      throw new Error('change output must return to the payer');
    }
    if (target.kind === 'native') {
      if (change.token !== undefined)
        throw new Error('native BCH change cannot contain CashTokens');
    } else {
      const expectedChange = inputTokenAmount - target.amount;
      if (expectedChange === 0n) {
        if (change.token !== undefined) throw new Error('unexpected CashToken change');
      } else if (
        change.token === undefined ||
        change.token.category !== target.category ||
        change.token.amount !== expectedChange ||
        !sameNft(change.token.nft, target.nft)
      ) {
        throw new Error('CashToken change does not return the exact remainder to the payer');
      }
    }
  } else if (target.kind === 'cashtoken' && inputTokenAmount !== target.amount) {
    throw new Error('CashToken remainder is missing');
  }
  if (!payerHash) throw new Error('missing payer');
  return { txid: transactionId(transaction), payer: encodeCashAddr(payerHash, network), fee };
}

function matchesMerchantToken(token: BchToken | undefined, target: BchPaymentTarget): boolean {
  if (target.kind === 'native') return token === undefined;
  return (
    token !== undefined &&
    token.category === target.category &&
    token.amount === target.amount &&
    sameNft(token.nft, target.nft)
  );
}

function sameNft(left: BchToken['nft'] | undefined, right: BchToken['nft'] | undefined): boolean {
  return (
    left?.capability === right?.capability &&
    (left === undefined || (right !== undefined && equalBytes(left.commitment, right.commitment)))
  );
}

function assertPaymentTarget(target: BchPaymentTarget): void {
  if (
    target.amount < 0n ||
    target.merchantValue < 0n ||
    target.amount > MAX_U64 ||
    target.merchantValue > MAX_U64
  ) {
    throw new Error('invalid BCH payment target');
  }
  if (target.kind === 'cashtoken') {
    if (!isCashTokenCategory(target.category)) {
      throw new Error('CashToken category must be 32-byte hex');
    }
    if (target.amount === 0n || target.amount > MAX_CASH_TOKEN_AMOUNT) {
      throw new Error('CashToken amount is outside the BCH token range');
    }
  }
}

function addU64(left: bigint, right: bigint, label: string): bigint {
  const result = left + right;
  if (right < 0n || result > MAX_U64) throw new Error(`${label} exceeds u64`);
  return result;
}

export function pushData(value: Uint8Array): Uint8Array {
  if (value.length > 75) throw new Error('script push too large for P2PKH');
  return Uint8Array.from([value.length, ...value]);
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsePushes(script: Uint8Array): Uint8Array[] {
  const pushes: Uint8Array[] = [];
  let offset = 0;
  while (offset < script.length) {
    const opcode = script[offset++];
    let length: number;
    if (opcode >= 1 && opcode <= 75) length = opcode;
    else if (opcode === 0x4c) length = script[offset++];
    else if (opcode === 0x4d) {
      length = script[offset] | (script[offset + 1] << 8);
      offset += 2;
    } else throw new Error('non-push opcode in P2PKH scriptSig');
    const end = offset + length;
    if (end > script.length) throw new Error('truncated script push');
    pushes.push(script.slice(offset, end));
    offset = end;
  }
  return pushes;
}

function assertStrictDer(signature: Uint8Array): void {
  if (signature.length < 8 || signature[0] !== 0x30 || signature[1] !== signature.length - 2) {
    throw new Error('invalid DER signature');
  }
  const rLength = signature[3];
  const rStart = 4;
  const sMarker = rStart + rLength;
  if (
    signature[2] !== 0x02 ||
    rLength === 0 ||
    sMarker + 2 > signature.length ||
    signature[sMarker] !== 0x02
  ) {
    throw new Error('invalid DER signature');
  }
  const sLength = signature[sMarker + 1];
  const sStart = sMarker + 2;
  if (sLength === 0 || sStart + sLength !== signature.length)
    throw new Error('invalid DER signature');
  if (
    signature[rStart] & 0x80 ||
    (rLength > 1 && signature[rStart] === 0 && !(signature[rStart + 1] & 0x80))
  ) {
    throw new Error('invalid DER signature');
  }
  if (
    signature[sStart] & 0x80 ||
    (sLength > 1 && signature[sStart] === 0 && !(signature[sStart + 1] & 0x80))
  ) {
    throw new Error('invalid DER signature');
  }
}
