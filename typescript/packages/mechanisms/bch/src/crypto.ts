import * as secp256k1 from '@noble/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import type { BchNetwork, BchOutPoint, BchSourceOutput } from './types';

export const SIGHASH_ALL_FORKID = 0x41;
export const BCH_ASSET = 'BCH';

const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CASHADDR_GENERATORS = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

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
  return ripemd160(sha256(value));
}

export function doubleSha256(value: Uint8Array): Uint8Array {
  return sha256(sha256(value));
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
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) throw new Error('CashAddr prefix required');
  if (value !== value.toLowerCase()) throw new Error('CashAddr must be lowercase');
  const prefix = value.slice(0, separator);
  if (prefix !== NETWORK_PREFIX[network]) throw new Error('CashAddr network mismatch');
  const payload = value.slice(separator + 1);
  const values = Array.from(payload, (character) => {
    const index = CASHADDR_CHARSET.indexOf(character);
    if (index < 0) throw new Error(`invalid CashAddr character: ${character}`);
    return index;
  });
  if (values.length < 9 || cashAddrPolymod([...prefixExpand(prefix), ...values]) !== 1n) {
    throw new Error('invalid CashAddr checksum');
  }
  const decoded = convertBits(values.slice(0, -8), 5, 8, false);
  if (decoded.length !== 21 || decoded[0] !== 0) throw new Error('CashAddr is not P2PKH');
  return Uint8Array.from(decoded.slice(1));
}

export function encodeCashAddr(hash: Uint8Array, network: BchNetwork): string {
  if (hash.length !== 20) throw new Error('P2PKH hash must be 20 bytes');
  const prefix = NETWORK_PREFIX[network];
  const data = convertBits(Uint8Array.from([0, ...hash]), 8, 5, true);
  const checksum = cashAddrChecksum([...prefixExpand(prefix), ...data]);
  return `${prefix}:${[...data, ...checksum].map((value) => CASHADDR_CHARSET[value]).join('')}`;
}

export function parseTransaction(raw: Uint8Array): BchTransaction {
  const reader = new Reader(raw);
  const version = reader.i32();
  const inputCount = Number(reader.varInt());
  if (inputCount < 1 || inputCount > 10_000) throw new Error('invalid input count');
  const inputs: BchTxInput[] = [];
  for (let index = 0; index < inputCount; index += 1) {
    const txidBytes = reader.bytes(32).slice().reverse();
    inputs.push({
      outpoint: { txid: bytesToHex(txidBytes), vout: reader.u32() },
      scriptSig: reader.varBytes(),
      sequence: reader.u32(),
    });
  }
  const outputCount = Number(reader.varInt());
  if (outputCount < 1 || outputCount > 10_000) throw new Error('invalid output count');
  const outputs: BchTxOutput[] = [];
  for (let index = 0; index < outputCount; index += 1) {
    outputs.push({ value: reader.u64(), scriptPubKey: reader.varBytes() });
  }
  const lockTime = reader.u32();
  if (!reader.done()) throw new Error('trailing transaction bytes');
  return { version, inputs, outputs, lockTime };
}

export function serializeTransaction(transaction: BchTransaction): Uint8Array {
  const result: number[] = [];
  writeI32(result, transaction.version);
  writeVarInt(result, BigInt(transaction.inputs.length));
  for (const input of transaction.inputs) {
    result.push(...hexToBytes(input.outpoint.txid).slice().reverse());
    writeU32(result, input.outpoint.vout);
    writeVarBytes(result, input.scriptSig);
    writeU32(result, input.sequence);
  }
  writeVarInt(result, BigInt(transaction.outputs.length));
  for (const output of transaction.outputs) {
    writeU64(result, output.value);
    writeVarBytes(result, output.scriptPubKey);
  }
  writeU32(result, transaction.lockTime);
  return Uint8Array.from(result);
}

export function transactionId(transaction: BchTransaction): string {
  return bytesToHex(doubleSha256(serializeTransaction(transaction)).slice().reverse());
}

export function signingHash(
  transaction: BchTransaction,
  inputIndex: number,
  source: BchSourceOutput,
): Uint8Array {
  if (inputIndex < 0 || inputIndex >= transaction.inputs.length)
    throw new Error('invalid input index');
  const input = transaction.inputs[inputIndex];
  const prevouts: number[] = [];
  const sequences: number[] = [];
  for (const candidate of transaction.inputs) {
    prevouts.push(...hexToBytes(candidate.outpoint.txid).slice().reverse());
    writeU32(prevouts, candidate.outpoint.vout);
    writeU32(sequences, candidate.sequence);
  }
  const outputs: number[] = [];
  for (const output of transaction.outputs) {
    writeU64(outputs, output.value);
    writeVarBytes(outputs, output.scriptPubKey);
  }
  const preimage: number[] = [];
  writeI32(preimage, transaction.version);
  preimage.push(...doubleSha256(Uint8Array.from(prevouts)));
  preimage.push(...doubleSha256(Uint8Array.from(sequences)));
  preimage.push(...hexToBytes(input.outpoint.txid).slice().reverse());
  writeU32(preimage, input.outpoint.vout);
  writeVarBytes(preimage, source.scriptPubKey);
  writeU64(preimage, source.value);
  writeU32(preimage, input.sequence);
  preimage.push(...doubleSha256(Uint8Array.from(outputs)));
  writeU32(preimage, transaction.lockTime);
  writeU32(preimage, SIGHASH_ALL_FORKID);
  return doubleSha256(Uint8Array.from(preimage));
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
    !secp256k1.verify(
      signature.slice(0, -1),
      signingHash(transaction, inputIndex, source),
      publicKey,
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

function prefixExpand(prefix: string): number[] {
  return [...prefix].map((character) => character.charCodeAt(0) & 0x1f).concat(0);
}

function cashAddrPolymod(values: number[]): bigint {
  let checksum = 1n;
  for (const value of values) {
    const top = checksum >> 35n;
    checksum = ((checksum & 0x07ffffffffn) << 5n) ^ BigInt(value);
    for (let index = 0; index < CASHADDR_GENERATORS.length; index += 1) {
      if (((top >> BigInt(index)) & 1n) !== 0n) checksum ^= CASHADDR_GENERATORS[index];
    }
  }
  return checksum;
}

function cashAddrChecksum(values: number[]): number[] {
  const checksum = cashAddrPolymod([...values, ...new Array(8).fill(0)]) ^ 1n;
  return Array.from({ length: 8 }, (_, index) =>
    Number((checksum >> BigInt(5 * (7 - index))) & 31n),
  );
}

function convertBits(
  data: Uint8Array | number[],
  from: number,
  to: number,
  pad: boolean,
): number[] {
  let accumulator = 0;
  let bits = 0;
  const maxValue = (1 << to) - 1;
  const maxAccumulator = (1 << (from + to - 1)) - 1;
  const result: number[] = [];
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('invalid CashAddr data');
    accumulator = ((accumulator << from) | value) & maxAccumulator;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((accumulator >> bits) & maxValue);
    }
  }
  if (pad) {
    if (bits > 0) result.push((accumulator << (to - bits)) & maxValue);
  } else if (bits >= from || ((accumulator << (to - bits)) & maxValue) !== 0) {
    throw new Error('invalid CashAddr padding');
  }
  return result;
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

function writeI32(output: number[], value: number): void {
  writeU32(output, value >>> 0);
}

function writeU32(output: number[], value: number): void {
  const normalized = value >>> 0;
  output.push(
    normalized & 255,
    (normalized >>> 8) & 255,
    (normalized >>> 16) & 255,
    (normalized >>> 24) & 255,
  );
}

function writeU64(output: number[], value: bigint): void {
  for (let index = 0; index < 8; index += 1)
    output.push(Number((value >> BigInt(index * 8)) & 255n));
}

function writeVarInt(output: number[], value: bigint): void {
  if (value <= 252n) output.push(Number(value));
  else if (value <= 0xffffn) {
    output.push(253);
    output.push(Number(value & 255n), Number((value >> 8n) & 255n));
  } else if (value <= 0xffffffffn) {
    output.push(254);
    writeU32(output, Number(value));
  } else {
    output.push(255);
    writeU64(output, value);
  }
}

function writeVarBytes(output: number[], value: Uint8Array): void {
  writeVarInt(output, BigInt(value.length));
  output.push(...value);
}

class Reader {
  private offset = 0;

  constructor(private readonly value: Uint8Array) {}

  bytes(length: number): Uint8Array {
    const result = this.value.slice(this.offset, this.offset + length);
    if (result.length !== length) throw new Error('truncated transaction');
    this.offset += length;
    return result;
  }

  u32(): number {
    const bytes = this.bytes(4);
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  }

  i32(): number {
    return this.u32() | 0;
  }

  u64(): bigint {
    let value = 0n;
    const bytes = this.bytes(8);
    for (let index = 0; index < 8; index += 1) value |= BigInt(bytes[index]) << BigInt(index * 8);
    return value;
  }

  varInt(): bigint {
    const prefix = this.bytes(1)[0];
    if (prefix <= 252) return BigInt(prefix);
    if (prefix === 253) {
      const bytes = this.bytes(2);
      const value = BigInt(bytes[0] | (bytes[1] << 8));
      if (value < 253n) throw new Error('non-canonical transaction varint');
      return value;
    }
    if (prefix === 254) {
      const bytes = this.bytes(4);
      const value = BigInt(
        (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0,
      );
      if (value <= 0xffffn) throw new Error('non-canonical transaction varint');
      return value;
    }
    const value = this.u64();
    if (value <= 0xffffffffn) throw new Error('non-canonical transaction varint');
    return value;
  }

  varBytes(): Uint8Array {
    const length = Number(this.varInt());
    if (!Number.isSafeInteger(length)) throw new Error('transaction field is too large');
    return this.bytes(length);
  }

  done(): boolean {
    return this.offset === this.value.length;
  }
}
