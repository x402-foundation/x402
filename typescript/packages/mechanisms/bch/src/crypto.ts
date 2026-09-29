import {
  decodeCashAddress as decodeLibauthCashAddress,
  decodeTransactionBCH,
  encodeCashAddress as encodeLibauthCashAddress,
  encodeTransactionBCH,
  generateSigningSerializationBCH,
  hash160 as libauthHash160,
  hash256 as libauthHash256,
  secp256k1,
} from '@bitauth/libauth';
import type { BchNetwork, BchOutPoint, BchSourceOutput } from './types';

export const SIGHASH_ALL_FORKID = 0x41;
export const BCH_ASSET = 'BCH';

const NETWORK_PREFIX: Record<BchNetwork, string> = {
  'bch:bitcoincash': 'bitcoincash',
  'bch:bchtest': 'bchtest',
};

export type TxId = string;

export type BchTxInput = {
  outpoint: BchOutPoint;
  scriptSig: Uint8Array;
  sequence: number;
};

export type BchTxOutput = {
  value: bigint;
  scriptPubKey: Uint8Array;
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

export function decodeCashAddr(value: string, network: BchNetwork): Uint8Array {
  if (value !== value.toLowerCase()) throw new Error('CashAddr must be lowercase');
  const decoded = decodeLibauthCashAddress(value);
  if (typeof decoded === 'string') throw new Error(decoded);
  if (decoded.prefix !== NETWORK_PREFIX[network]) throw new Error('CashAddr network mismatch');
  if (decoded.type !== 'p2pkh') throw new Error('CashAddr type mismatch');
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
  outputs: Array<{ valueSatoshis: bigint; lockingBytecode: Uint8Array }>;
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
    })),
    lockTime: transaction.locktime,
  };
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
      })),
      transaction: toLibauthTransaction(transaction),
    },
    {
      coveredBytecode: source.scriptPubKey,
      signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID),
      forkId: Uint8Array.of(0, 0, 0),
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
  merchantAmount: bigint,
  policy: BchPolicy = DEFAULT_BCH_POLICY,
): { txid: string; payer: string; fee: bigint } {
  const serialized = serializeTransaction(transaction);
  if (serialized.length > policy.maxTransactionSize)
    throw new Error('transaction exceeds maximum size');
  if (transaction.inputs.length === 0 || transaction.inputs.length > policy.maxInputs) {
    throw new Error('invalid input count');
  }
  if (transaction.lockTime !== 0) throw new Error('non-zero locktime is unsupported');
  if (merchantAmount < policy.dustThreshold) throw new Error('merchant output is dust');
  if (sources.length !== transaction.inputs.length) throw new Error('source output count mismatch');
  if (transaction.outputs.length < 1 || transaction.outputs.length > 2) {
    throw new Error('BCH exact requires one merchant output and optional change');
  }
  let inputValue = 0n;
  let payerHash: Uint8Array | undefined;
  for (let index = 0; index < sources.length; index += 1) {
    inputValue += sources[index].value;
    const inputPayerHash = verifyP2pkhInput(transaction, index, sources[index]);
    if (payerHash !== undefined && !equalBytes(payerHash, inputPayerHash)) {
      throw new Error('all BCH inputs must belong to the same payer');
    }
    payerHash ??= inputPayerHash;
  }
  const merchantMatches = transaction.outputs.filter(
    (output) => output.value === merchantAmount && equalBytes(output.scriptPubKey, merchantScript),
  ).length;
  if (merchantMatches !== 1) throw new Error('merchant output must match exactly once');
  let outputValue = 0n;
  for (const output of transaction.outputs) {
    if (!isP2pkhScript(output.scriptPubKey))
      throw new Error('BCH exact supports P2PKH outputs only');
    outputValue += output.value;
  }
  const fee = inputValue - outputValue;
  if (fee < BigInt(serialized.length) * policy.feeRateSatPerByte) {
    throw new Error('transaction fee is below the required BCH fee rate');
  }
  if (transaction.outputs.length === 2) {
    const change = transaction.outputs.find(
      (output) =>
        !(output.value === merchantAmount && equalBytes(output.scriptPubKey, merchantScript)),
    );
    if (!change || change.value < policy.dustThreshold) throw new Error('change output is dust');
    if (equalBytes(change.scriptPubKey, merchantScript))
      throw new Error('duplicate merchant output');
  }
  if (!payerHash) throw new Error('missing payer');
  return { txid: transactionId(transaction), payer: encodeCashAddr(payerHash, network), fee };
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
