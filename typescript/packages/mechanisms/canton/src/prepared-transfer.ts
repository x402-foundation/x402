/* ════════════════════════════════════════════════════════════════════════
 * PREPARED-TRANSACTION VALIDATOR (moved here from agent-wallet, unchanged)
 *
 * The structural protobuf decoder plus the transfer/accept expectation asserts.
 * It lives in core so BOTH sides can use it: the agent signing a relay-prepared
 * transaction, and the facilitator validating an INLINE payload it is asked to
 * relay. Inline carriage puts payer-controlled protobuf on the submit path for
 * the first time, so the facilitator MUST structurally validate the bytes it
 * relays — it can no longer trust a relay-built stash row.
 *
 * Deliberately dependency-free: this range uses no `node:crypto` and no
 * @canton-network/* package, so core stays a zero-dependency published package.
 * `assertHashBinding` and the onboarding arm intentionally STAY in agent-wallet
 * — they need node:crypto, and hash binding protects the CLIENT from a lying
 * relay, which is not a facilitator-side concern.
 * ════════════════════════════════════════════════════════════════════════ */

/* ────────────────────────────────────────────────────────────────────────
 * Generic protobuf wire reader (proto3, schema-driven by the caller).
 * Wire types: 0=varint, 1=64-bit, 2=length-delimited, 5=32-bit. 3/4 (groups)
 * are obsolete and rejected (we cannot skip them without a schema).
 * ──────────────────────────────────────────────────────────────────────── */
const WIRE_VARINT = 0;
const WIRE_64 = 1;
const WIRE_LEN = 2;
const WIRE_32 = 5;

interface WireField {
  field: number;
  wire: number;
  /** Present for WIRE_LEN. */
  bytes?: Uint8Array;
  /** Present for WIRE_VARINT (as a JS number; party/amount values are LEN). */
  varint?: number;
  /** Present for WIRE_VARINT: the RAW varint-encoded bytes, so callers that need
   *  full int64 precision (nonce) can re-decode as BigInt without the
   *  float-precision loss of `readVarint`'s `2**shift` accumulation. */
  varintBytes?: Uint8Array;
  /** Present for WIRE_64: the RAW 8 little-endian bytes. Daml `Value.timestamp`
   *  (oneof tag 5, `Time` µs since epoch) is serialized as a protobuf SFIXED64
   *  (wire type 1), NOT a varint — so its value lives here, read BigInt-precise
   *  via `fixed64ToBigInt`. (Confirmed against the canonical Canton interactive
   *  `Value` codec AND a live TestNet prepared `TransferFactory_Transfer`: the
   *  transfer's `executeBefore` deadline arrives as `field 5, wire 1`, 9 bytes.) */
  fixed64Bytes?: Uint8Array;
}

/**
 *
 * @param buf
 * @param pos
 */
function readVarint(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let shift = 0;
  let value = 0;
  while (pos < buf.length) {
    const b = buf[pos++] as number;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, pos };
    shift += 7;
    if (shift > 63) break;
  }
  throw new PreparedDecodeError("truncated or malformed varint");
}

/**
 * Read a varint that must fit in 32 bits: a protobuf TAG or a LENGTH prefix.
 *
 * BYPASS THIS CLOSES — the parsers disagree, and the disagreement is silent.
 * `readVarint` above accumulates up to 64 bits. Every reference reader on the
 * other side of this transaction reads a tag and a length as a *32-bit* varint
 * and DISCARDS bits >= 32 of an over-long encoding: protobuf-java's
 * `CodedInputStream.readTag()` -> `readRawVarint32()` in the Canton
 * participant, and protobufjs's `Reader.uint32()` inside
 * `@canton-network/core-tx-visualizer`, which is what `recomputeHash` uses.
 *
 * So `8A 80 80 80 10` — a 5-byte non-minimal encoding of 0x0A + 2^32 — is read
 * by them as tag 0x0A (field 1, wire 2) and by us as tag 4294967306
 * (field 536870913). The participant parses the field and the hasher covers it;
 * we see an unknown field number and skip it. Any field can be made invisible
 * to verify-before-sign while staying fully effective on execute. The same
 * trick on a LENGTH prefix desynchronises where the field ends, so every byte
 * after it is read differently by us and by them.
 *
 * The fix is NOT to mirror their truncation. Copying another parser's quirk
 * makes correctness depend on us tracking that quirk forever, and any future
 * divergence in *their* rules silently re-opens the hole. The invariant is
 * simply the protobuf specification: tags and length prefixes are `uint32`, and
 * field numbers max out at 2^29-1 so a valid tag can never exceed 2^32-1.
 * Anything larger is not a legal encoding — refuse it. No honest encoder emits
 * one, so the honest path is untouched, and an encoding we cannot read the same
 * way as the participant is exactly what we must never validate.
 *
 * @param buf
 * @param pos
 */
function readVarint32(buf: Uint8Array, pos: number): { value: number; pos: number } {
  const r = readVarint(buf, pos);
  if (r.value > 0xffffffff) {
    throw new PreparedDecodeError(
      "protobuf tag/length varint exceeds 32 bits — the participant and the " +
        "official hasher read these as uint32 and would silently truncate, so " +
        "these bytes cannot be validated to mean the same thing on both sides",
    );
  }
  return r;
}

/**
 * Decode one protobuf message into its fields. Repeated fields appear multiple
 * times in the returned array (we never silently collapse them). Unknown field
 * numbers are still parsed (and skipped by callers) so an honest-but-evolved
 * encoding is tolerated; only structurally impossible bytes throw.
 *
 * @param buf
 */
function decodeMessage(buf: Uint8Array): WireField[] {
  const out: WireField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const { value: tag, pos: p1 } = readVarint32(buf, pos);
    pos = p1;
    const field = Math.floor(tag / 8);
    const wire = tag & 0x7;
    if (field === 0) throw new PreparedDecodeError("invalid field number 0");
    if (wire === WIRE_LEN) {
      const { value: len, pos: p2 } = readVarint32(buf, pos);
      pos = p2;
      if (len < 0 || pos + len > buf.length) {
        throw new PreparedDecodeError("length-delimited field overruns buffer");
      }
      out.push({ field, wire, bytes: buf.subarray(pos, pos + len) });
      pos += len;
    } else if (wire === WIRE_VARINT) {
      const start = pos;
      const { value, pos: p2 } = readVarint(buf, pos);
      pos = p2;
      out.push({ field, wire, varint: value, varintBytes: buf.subarray(start, p2) });
    } else if (wire === WIRE_64) {
      if (pos + 8 > buf.length) throw new PreparedDecodeError("64-bit field overruns buffer");
      // Capture the 8 little-endian bytes: Daml `Value.timestamp` (Time µs) is a
      // protobuf SFIXED64 (wire type 1), so a deadline/expiry leaf lives HERE, not
      // as a varint. (Previously these bytes were discarded, which is why the
      // transfer's executeBefore deadline read back as absent on the live wire.)
      out.push({ field, wire, fixed64Bytes: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wire === WIRE_32) {
      if (pos + 4 > buf.length) throw new PreparedDecodeError("32-bit field overruns buffer");
      pos += 4;
      out.push({ field, wire });
    } else {
      throw new PreparedDecodeError(`unsupported/obsolete wire type ${wire}`);
    }
  }
  return out;
}

/**
 * All length-delimited submessages for a given field number, in order.
 *
 * @param fields
 * @param field
 */
function lenFields(fields: WireField[], field: number): Uint8Array[] {
  return fields
    .filter(f => f.field === field && f.wire === WIRE_LEN && f.bytes !== undefined)
    .map(f => f.bytes as Uint8Array);
}

/**
 * Strict accessor for a NON-REPEATED length-delimited field: returns its single
 * submessage, `undefined` if absent, and THROWS if it occurs more than once.
 *
 * Why this exists (BYPASS: amount-inflation via duplicate oneof / field):
 * the protobuf wire format mandates LAST-occurrence-wins for a non-repeated
 * scalar or `oneof` member, and Canton's spec-conformant ScalaPB parser (which
 * the participant runs on `execute` to recompute the V2 hash and interpret the
 * transaction) follows that rule. A naive hand-rolled reader that takes the
 * FIRST occurrence (our old `lenField`) would diverge: an attacker can place
 * `Value.numeric` twice inside the SAME amount `Value` — a decoy "1.0" first,
 * the real "9999.0" second — and the first-wins reader sees the decoy while the
 * participant executes the inflated amount. There is no legitimate reason for a
 * non-repeated field to appear twice, so we FAIL CLOSED on any duplicate rather
 * than guess which occurrence the participant will honour. This makes our decode
 * unambiguous and forces it to agree with the spec parser for everything we
 * read (amount/party/text/record/label/value).
 *
 * @param fields
 * @param field
 * @param what
 */
function lenFieldUnique(fields: WireField[], field: number, what: string): Uint8Array | undefined {
  const all = lenFields(fields, field);
  if (all.length > 1) {
    throw new PreparedDecodeError(
      `non-repeated field ${field} (${what}) appears ${all.length} times — ` +
        `ambiguous encoding (last-occurrence-wins on the participant), refusing to sign`,
    );
  }
  return all[0];
}

/**
 * Number of length-delimited occurrences of a field (for duplicate detection on
 * scalar `Value` oneof members, which must each appear at most once).
 *
 * @param fields
 * @param field
 */
function countLenField(fields: WireField[], field: number): number {
  return lenFields(fields, field).length;
}

/**
 * Decode a length-delimited field as UTF-8 (strict).
 *
 * @param bytes
 */
function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * All WIRE_VARINT occurrences of a field number, in order.
 *
 * @param fields
 * @param field
 */
function varintFields(fields: WireField[], field: number): WireField[] {
  return fields.filter(
    f => f.field === field && f.wire === WIRE_VARINT && f.varintBytes !== undefined,
  );
}

/**
 * Number of WIRE_VARINT occurrences of a field (duplicate-oneof detection).
 *
 * @param fields
 * @param field
 */
function countVarintField(fields: WireField[], field: number): number {
  return varintFields(fields, field).length;
}

/**
 * All WIRE_64 (fixed64) occurrences of a field number, in order.
 *
 * @param fields
 * @param field
 */
function fixed64Fields(fields: WireField[], field: number): WireField[] {
  return fields.filter(
    f => f.field === field && f.wire === WIRE_64 && f.fixed64Bytes !== undefined,
  );
}

/** Number of WIRE_64 occurrences of a field (duplicate-oneof detection for the
 * @param fields
 * @param field
 *  fixed64 `Value.timestamp` member, the analogue of `countVarintField`). */
function countFixed64Field(fields: WireField[], field: number): number {
  return fixed64Fields(fields, field).length;
}

/**
 * Decode an 8-byte little-endian protobuf fixed64/sfixed64 as a BigInt — full
 * 64-bit precision, no float loss. Daml `Value.timestamp` (`Time`, µs since
 * epoch) is wire type 1 (SFIXED64), little-endian per the protobuf spec.
 * Timestamps are non-negative in practice (Canton Time is post-epoch), so we
 * read the value as UNSIGNED; a "negative" (high-bit) timestamp would be an
 * absurd far-future µs count that the past-/ordering checks reject anyway.
 *
 * @param bytes
 */
function fixed64ToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) {
    throw new PreparedDecodeError(
      `fixed64 field has ${bytes.length} bytes, expected exactly 8 — refusing to sign`,
    );
  }
  let value = 0n;
  for (let i = 7; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i] as number);
  }
  return value;
}

/**
 * Strict accessor for a NON-REPEATED fixed64 field (Daml `Time`/`Value.timestamp`):
 * returns its single value as a BigInt, `undefined` if absent, and THROWS if it
 * occurs more than once. Same fail-closed rationale as `varintFieldUnique`: the
 * wire format is last-occurrence-wins for a non-repeated scalar, so a duplicate
 * (decoy-first/real-second deadline) would let our read diverge from the
 * participant's. There is no legitimate reason for a deadline leaf to appear
 * twice within the same `Value`.
 *
 * @param fields
 * @param field
 * @param what
 */
function fixed64FieldUnique(fields: WireField[], field: number, what: string): bigint | undefined {
  const all = fixed64Fields(fields, field);
  if (all.length > 1) {
    throw new PreparedDecodeError(
      `non-repeated fixed64 field ${field} (${what}) appears ${all.length} times — ` +
        `ambiguous encoding (last-occurrence-wins on the participant), refusing to sign`,
    );
  }
  const only = all[0];
  if (only === undefined) return undefined;
  return fixed64ToBigInt(only.fixed64Bytes as Uint8Array);
}

/**
 * Re-decode a raw varint byte-sequence as a BigInt — full int64 precision, no
 * `2**shift` float loss. proto3 int64 is up to 10 bytes (64 data bits). We cap
 * the data shift at 63 bits and fail closed on anything longer/malformed rather
 * than silently truncating. (`readVarint` already validated framing during
 * decode; this re-reads the SAME bytes precisely.)
 *
 * @param bytes
 */
function varintToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  let shift = 0n;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    value += BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 63n) break;
  }
  throw new PreparedDecodeError("truncated or over-long varint");
}

/**
 * Strict accessor for a NON-REPEATED varint field (Daml Int / Time): returns its
 * single value as a BigInt, `undefined` if absent, and THROWS if it occurs more
 * than once. Same fail-closed rationale as `lenFieldUnique`: the wire format is
 * last-occurrence-wins for a non-repeated scalar, so a duplicate would let a
 * decoy-first/real-second split diverge our read from the participant's. There
 * is no legitimate reason for nonce/expiresAt to appear twice.
 *
 * @param fields
 * @param field
 * @param what
 */
function varintFieldUnique(fields: WireField[], field: number, what: string): bigint | undefined {
  const all = varintFields(fields, field);
  if (all.length > 1) {
    throw new PreparedDecodeError(
      `non-repeated varint field ${field} (${what}) appears ${all.length} times — ` +
        `ambiguous encoding (last-occurrence-wins on the participant), refusing to sign`,
    );
  }
  const only = all[0];
  if (only === undefined) return undefined;
  return varintToBigInt(only.varintBytes as Uint8Array);
}

/* ────────────────────────────────────────────────────────────────────────
 * Daml `Value` (the choice-argument tree). We only need the leaves that carry
 * security-relevant data: party (recipients), numeric (amount), text (e.g.
 * instrument id). We descend record / list / optional / variant containers.
 * ──────────────────────────────────────────────────────────────────────── */

// Value oneof tags (com.daml.ledger.api.v2.Value.Sum).
//   unit=1 bool=2 int64=3 date=4 timestamp=5 numeric=6 party=7 text=8
//   contract_id=9 optional=10 list=11 text_map=12 gen_map=13 record=14
//   variant=15 enum=16
const V_UNIT = 1; // Value.unit (Daml `()`; google.protobuf.Empty). Non-party leaf.
const V_BOOL = 2; // Value.bool. Varint. Non-party leaf.
const V_INT64 = 3; // Value.int64 (Daml `Int`, e.g. TransferCommand.nonce). Varint.
const V_DATE = 4; // Value.date (Daml `Date`; days since epoch). Varint. Non-party leaf.
const V_TIMESTAMP = 5; // Value.timestamp (Daml `Time`, e.g. expiresAt). SFIXED64 µs (wire type 1, NOT varint).
const V_NUMERIC = 6;
const V_PARTY = 7;
const V_TEXT = 8;
const V_CONTRACT_ID = 9; // Value.contract_id (e.g. transfer.inputHoldingCids). Non-party leaf.
const V_OPTIONAL = 10;
const V_LIST = 11;
const V_TEXT_MAP = 12; // Value.text_map (TextMap; string keys, Value values)
const V_GEN_MAP = 13; // Value.gen_map (GenMap; Value keys AND Value values)
const V_RECORD = 14;
const V_VARIANT = 15;
const V_ENUM = 16; // Value.enum (Identifier + constructor; carries no Party). Non-party leaf.
/**
 * The COMPLETE com.daml.ledger.api.v2.interactive `Value` oneof member set. We
 * fail closed (refuse to sign) on ANY `Value` that sets a member outside this
 * set: the leaf reader + the foreign-party backstop only recognize these, so an
 * unknown/future member's subtree would be silently dropped — and could hide a
 * foreign recipient party. Mirrors the codebase's fail-closed stance on unknown
 * node versions / node types.
 */
const COMPLETE_VALUE_MEMBERS = new Set<number>([
  V_UNIT,
  V_BOOL,
  V_INT64,
  V_DATE,
  V_TIMESTAMP,
  V_NUMERIC,
  V_PARTY,
  V_TEXT,
  V_CONTRACT_ID,
  V_OPTIONAL,
  V_LIST,
  V_TEXT_MAP,
  V_GEN_MAP,
  V_RECORD,
  V_VARIANT,
  V_ENUM,
]);
// Record / RecordField / List / Optional / Variant inner field numbers.
const RECORD_FIELDS = 2;
const RF_LABEL = 1;
const RF_VALUE = 2;
const LIST_ELEMENTS = 1;
/** `Value.TextMap.entries` and its `Entry { key : string = 1, value : Value = 2 }`.
 *  Confirmed against the real MainNet transfer's `transfer.meta.values`. */
const TEXT_MAP_ENTRIES = 1;
const TM_KEY = 1;
const TM_VALUE = 2;
/** The meta key the scheme reserves for the merchant memo. */
const X402_MEMO_KEY = "x402.memo";
const OPTIONAL_VALUE = 1;
const VARIANT_VALUE = 3;
// GenMap / TextMap inner field numbers. Both wrap a repeated `Entry` at field 1;
// GenMap.Entry has Value key=1 + Value value=2, TextMap.Entry has string key=1 +
// Value value=2 (so only TextMap *values* can carry a party leaf).
const MAP_ENTRIES = 1;
const ENTRY_KEY = 1;
const ENTRY_VALUE = 2;

/** A decoded leaf carrying its Daml type so callers match on TYPE, not text.
 *  `int64`/`timestamp` are Daml `Int`/`Time`, serialized as protobuf VARINTS
 *  (not length-delimited); their `value` is the decimal string of the varint so
 *  callers compare exactly without precision loss. */
type Leaf =
  | { kind: "party"; value: string }
  | { kind: "numeric"; value: string }
  | { kind: "text"; value: string }
  | { kind: "int64"; value: string }
  | { kind: "timestamp"; value: string };

/**
 * A field within a record, by label (label may be absent in normalized
 * encodings — then `label` is "" and callers fall back to declaration order).
 */
interface RecordEntry {
  label: string;
  value: Uint8Array; // the encoded `Value`
}

const MAX_DEPTH = 64;
/**
 * Bounds on the SHAPE of a prepared transaction, required by the scheme
 * ("bound structural nesting depth, total node count, and parse time").
 *
 * Not guesses: a real MainNet TransferFactory_Transfer decodes to 12 nodes with
 * ONE root, and the accept path to 13. The caps sit ~20x above that, so they
 * cannot reject a genuine payment while still refusing an input whose only
 * purpose is to be expensive.
 *
 * The payload size cap already bounds total work linearly. What this closes is
 * the ASYMMETRY: measured on this decoder, 64 KiB of dense junk cost ~6 ms
 * versus ~0.13 ms for a real 26 KB payment — 47x the work of a real payment,
 * for input that gets rejected anyway. Stopping at the node count collapses
 * that back to a rejection the attacker pays for.
 */
const MAX_NODES = 256;
const MAX_ROOTS = 16;

/**
 * Decode a `Value`'s record fields (in order). Throws if it is not a record.
 *
 * @param value
 */
function recordEntries(value: Uint8Array): RecordEntry[] {
  assertSingleValueMember(value);
  const v = decodeMessage(value);
  const rec = lenFieldUnique(v, V_RECORD, "Value.record");
  if (rec === undefined) throw new PreparedDecodeError("expected a Value.record");
  const recFields = decodeMessage(rec);
  const entries = lenFields(recFields, RECORD_FIELDS).map(rf => {
    const f = decodeMessage(rf);
    // A RecordField's label and value are each non-repeated; reject duplicates
    // so a last-wins parser cannot disagree with us about a field's value.
    const labelBytes = lenFieldUnique(f, RF_LABEL, "RecordField.label");
    const valBytes = lenFieldUnique(f, RF_VALUE, "RecordField.value");
    if (valBytes === undefined) throw new PreparedDecodeError("record field missing value");
    return { label: labelBytes ? utf8(labelBytes) : "", value: valBytes };
  });
  // Reject duplicate NON-EMPTY labels: by-label lookup would pick the first
  // while a last-wins consumer keying by label would pick the last (decoy/real
  // split). Empty labels (normalized encodings) are positional, so allowed.
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.label === "") continue;
    if (seen.has(e.label)) {
      throw new PreparedDecodeError(
        `record contains duplicate field label ${JSON.stringify(e.label)} — ` +
          `ambiguous encoding, refusing to sign`,
      );
    }
    seen.add(e.label);
  }
  return entries;
}

/**
 * A Daml `Value` is a `oneof sum` — at most one member may be set. A
 * spec-conformant parser keeps the LAST member it sees within a oneof, so if an
 * attacker sets two members (or the same member twice) our by-type reads could
 * pick a different one than the participant. Enforce that the scalar/structural
 * members we ever read each occur AT MOST ONCE and that no two DIFFERENT members
 * are present simultaneously. Fail closed on any ambiguity.
 *
 * @param value
 */
function assertSingleValueMember(value: Uint8Array): void {
  const v = decodeMessage(value);
  // Length-delimited oneof members.
  const lenMembers: Array<{ tag: number; what: string }> = [
    { tag: V_NUMERIC, what: "Value.numeric" },
    { tag: V_PARTY, what: "Value.party" },
    { tag: V_TEXT, what: "Value.text" },
    { tag: V_RECORD, what: "Value.record" },
    { tag: V_OPTIONAL, what: "Value.optional" },
    { tag: V_LIST, what: "Value.list" },
    { tag: V_TEXT_MAP, what: "Value.text_map" },
    { tag: V_GEN_MAP, what: "Value.gen_map" },
    { tag: V_VARIANT, what: "Value.variant" },
  ];
  // Varint oneof members (Daml `Int`). Counted separately because they use wire
  // type 0, not length-delimited; a duplicate int64 (decoy nonce first, real
  // nonce second) must be caught with the SAME fail-closed rigor.
  const varintMembers: Array<{ tag: number; what: string }> = [
    { tag: V_INT64, what: "Value.int64" },
  ];
  // Fixed64 oneof members (Daml `Time`/`Value.timestamp`). These use wire type 1
  // (SFIXED64), NOT varint — so a duplicate deadline (decoy-first/real-second)
  // would be INVISIBLE to the varint counter and could let our read diverge from
  // the participant's. Count them with their own wire-type-correct accessor so the
  // single-member + duplicate guards cover the timestamp leaf too.
  const fixed64Members: Array<{ tag: number; what: string }> = [
    { tag: V_TIMESTAMP, what: "Value.timestamp" },
  ];
  let present = 0;
  for (const m of lenMembers) {
    const count = countLenField(v, m.tag);
    if (count > 1) {
      throw new PreparedDecodeError(
        `Value oneof member ${m.what} set ${count} times — ambiguous encoding ` +
          `(last-occurrence-wins on the participant), refusing to sign`,
      );
    }
    if (count === 1) present++;
  }
  for (const m of varintMembers) {
    const count = countVarintField(v, m.tag);
    if (count > 1) {
      throw new PreparedDecodeError(
        `Value oneof member ${m.what} set ${count} times — ambiguous encoding ` +
          `(last-occurrence-wins on the participant), refusing to sign`,
      );
    }
    if (count === 1) present++;
  }
  for (const m of fixed64Members) {
    const count = countFixed64Field(v, m.tag);
    if (count > 1) {
      throw new PreparedDecodeError(
        `Value oneof member ${m.what} set ${count} times — ambiguous encoding ` +
          `(last-occurrence-wins on the participant), refusing to sign`,
      );
    }
    if (count === 1) present++;
  }
  if (present > 1) {
    throw new PreparedDecodeError(
      "Value sets more than one oneof member — ambiguous encoding, refusing to sign",
    );
  }
}

/**
 * Read a leaf scalar (party/numeric/text) out of a `Value`, if it is one.
 *
 * Hardened against the duplicate-oneof amount-inflation bypass: we first assert
 * the `Value` sets at most one oneof member, each at most once
 * (`assertSingleValueMember`), then read that single member with the strict
 * unique accessor. A `Value` carrying `Value.numeric` twice (decoy "1.0" then
 * real "9999.0") — which a last-wins ScalaPB parser would read as the inflated
 * amount — is rejected here BEFORE any amount comparison, instead of silently
 * taking the first (decoy) occurrence. Fail closed.
 *
 * @param value
 */
function leafOf(value: Uint8Array): Leaf | undefined {
  assertSingleValueMember(value);
  const v = decodeMessage(value);
  const party = lenFieldUnique(v, V_PARTY, "Value.party");
  if (party !== undefined) return { kind: "party", value: utf8(party) };
  const numeric = lenFieldUnique(v, V_NUMERIC, "Value.numeric");
  if (numeric !== undefined) return { kind: "numeric", value: utf8(numeric) };
  const text = lenFieldUnique(v, V_TEXT, "Value.text");
  if (text !== undefined) return { kind: "text", value: utf8(text) };
  // Daml Int / Time leaves (e.g. TransferCommand.nonce / expiresAt). Read as
  // BigInt-precise decimal strings via the unique varint accessor.
  const int64 = varintFieldUnique(v, V_INT64, "Value.int64");
  // Daml-LF encodes `Value.int64` (Daml `Int`, e.g. TransferCommand.nonce) as a
  // protobuf SINT64 — a ZIGZAG varint, NOT a plain two's-complement int64. The
  // raw varint w decodes to the signed value zigzag(w) = (w >> 1) ^ -(w & 1):
  // nonce 1 is on the wire as varint 2, nonce 2 as 4, -1 as 1, 0 as 0. The
  // earlier code decoded it as a plain int64, so every nonce >= 1 read as 2n —
  // the v1 nonce pin then matched ONLY nonce 0 and rejected every later payment
  // (the unit fixture also plain-encoded, hiding it: fixture-vs-reality, like the
  // expectedDso Optional bug). Zigzag-decode so the value equals the participant's
  // signed read (a negative nonce still decodes negative for the sanity check).
  if (int64 !== undefined) return { kind: "int64", value: zigzagDecodeInt64(int64).toString() };
  // Daml `Value.timestamp` (`Time`, µs since epoch, e.g. the transfer's
  // executeBefore deadline) is a protobuf SFIXED64 — wire type 1, little-endian 8
  // bytes — NOT a varint. The earlier code read it via the varint accessor, so on
  // the real wire (where the participant emits `field 5, wire 1`) the timestamp
  // read back as ABSENT — the same fixture-vs-reality trap as the zigzag-nonce /
  // Optional-DSO bugs: a varint-encoded fixture passed while the live fixed64 wire
  // failed, false-tripping the deadline-fail-closed check on a legitimate transfer.
  // Read it as a fixed64 so the value equals the participant's read. Timestamps are
  // non-negative in practice; the unsigned value is exact (BigInt).
  const timestamp = fixed64FieldUnique(v, V_TIMESTAMP, "Value.timestamp");
  if (timestamp !== undefined) return { kind: "timestamp", value: timestamp.toString() };
  return undefined;
}

/** Decode a protobuf SINT64 zigzag varint to its signed BigInt value:
 *  zigzag(w) = (w >> 1) ^ -(w & 1). Daml-LF serializes `Value.int64` as sint64,
 *  so a wire varint of 0 is 0, 1 is -1, 2 is 1, 3 is -2, 4 is 2, … This is what
 *  the participant signs, so the agent must decode it the same way (decoding it
 *
 * @param u
 *  - as a plain int64 read every nonce >= 1 as 2n). */
function zigzagDecodeInt64(u: bigint): bigint {
  return (u >> 1n) ^ -(u & 1n);
}

/**
 * Fail closed on a `Value` that sets any oneof member outside the COMPLETE known
 * set. The leaf reader + the backstop's container descent recognize only the
 * standard members, so an unknown/future member's subtree would be silently
 * dropped — and could hide a foreign recipient party. Refuse rather than guess.
 *
 * @param value
 */
function assertKnownValueMembers(value: Uint8Array): void {
  for (const f of decodeMessage(value)) {
    if (!COMPLETE_VALUE_MEMBERS.has(f.field)) {
      throw new PreparedDecodeError(
        `Daml Value sets an unknown oneof member (field ${f.field}) — refusing to sign ` +
          `(cannot prove the member carries no foreign recipient party)`,
      );
    }
  }
}

/**
 * Recursively collect every party-typed leaf in a `Value` tree, EXCEPT those
 * sitting inside an `instrumentId`-shaped sub-record (admin party at a
 * non-recipient position). Used for the foreign-recipient backstop. We descend
 * every Value container that can hold a party leaf: records, lists, optionals,
 * variants, and BOTH map shapes — GenMap (party can hide in a Value key OR a
 * Value value) and TextMap (string keys cannot be parties, so only values are
 * descended). Skipping the map oneof members would let a relay smuggle an extra
 * recipient inside a GenMap and slip past the backstop (defense-in-depth: the
 * receiver itself must still be a plain Party at the transfer.receiver position,
 * which extractTransfer pins, so this is not a known redirect exploit). The
 * caller excludes the instrument admin from the recipient set without trusting
 * its value. Fails closed on any unknown Value oneof member (assertKnownValueMembers).
 *
 * @param value
 * @param out
 * @param depth
 */
function collectPartyLeaves(value: Uint8Array, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) throw new PreparedDecodeError("Value nesting too deep");
  // Fail closed on any Value oneof member outside the complete known set BEFORE
  // we walk it: the leaf reader + container descent below recognize only the
  // standard members, so an unknown/future member's subtree would otherwise be
  // silently dropped — and could hide a foreign recipient party from this
  // backstop. (Known non-party scalars — unit/bool/date/contract_id/enum — are
  // in the set: leafOf returns undefined for them and no container matches, so
  // they are correctly ignored, not rejected.)
  assertKnownValueMembers(value);
  const leaf = leafOf(value);
  if (leaf) {
    if (leaf.kind === "party") out.push(leaf.value);
    return; // scalar leaf — nothing to recurse into
  }
  // Not a scalar leaf — it must be a single structural oneof member. Reject any
  // ambiguous (duplicate/multi-member) Value before descending so a smuggled
  // extra party cannot hide behind a last-wins parser disagreement.
  assertSingleValueMember(value);
  const v = decodeMessage(value);
  // record → recurse each field value
  const rec = lenFieldUnique(v, V_RECORD, "Value.record");
  if (rec !== undefined) {
    const recFields = decodeMessage(rec);
    for (const rf of lenFields(recFields, RECORD_FIELDS)) {
      const f = decodeMessage(rf);
      const valBytes = lenFieldUnique(f, RF_VALUE, "RecordField.value");
      if (valBytes !== undefined) collectPartyLeaves(valBytes, out, depth + 1);
    }
    return;
  }
  // list → recurse elements
  const list = lenFieldUnique(v, V_LIST, "Value.list");
  if (list !== undefined) {
    for (const el of lenFields(decodeMessage(list), LIST_ELEMENTS)) {
      collectPartyLeaves(el, out, depth + 1);
    }
    return;
  }
  // optional → recurse inner value
  const opt = lenFieldUnique(v, V_OPTIONAL, "Value.optional");
  if (opt !== undefined) {
    const inner = lenFieldUnique(decodeMessage(opt), OPTIONAL_VALUE, "Optional.value");
    if (inner !== undefined) collectPartyLeaves(inner, out, depth + 1);
    return;
  }
  // variant → recurse inner value
  const variant = lenFieldUnique(v, V_VARIANT, "Value.variant");
  if (variant !== undefined) {
    const inner = lenFieldUnique(decodeMessage(variant), VARIANT_VALUE, "Variant.value");
    if (inner !== undefined) collectPartyLeaves(inner, out, depth + 1);
    return;
  }
  // gen_map → recurse BOTH the key and the value of every entry. In a GenMap
  // both Entry.key and Entry.value are full `Value`s, so a party can hide in
  // either; descend both so a smuggled recipient cannot escape the backstop.
  const genMap = lenFieldUnique(v, V_GEN_MAP, "Value.gen_map");
  if (genMap !== undefined) {
    for (const entry of lenFields(decodeMessage(genMap), MAP_ENTRIES)) {
      const e = decodeMessage(entry);
      const key = lenFieldUnique(e, ENTRY_KEY, "GenMap.Entry.key");
      if (key !== undefined) collectPartyLeaves(key, out, depth + 1);
      const val = lenFieldUnique(e, ENTRY_VALUE, "GenMap.Entry.value");
      if (val !== undefined) collectPartyLeaves(val, out, depth + 1);
    }
    return;
  }
  // text_map → recurse entry VALUES only (TextMap keys are plain strings, never
  // parties), so a party leaf can only appear in a value.
  const textMap = lenFieldUnique(v, V_TEXT_MAP, "Value.text_map");
  if (textMap !== undefined) {
    for (const entry of lenFields(decodeMessage(textMap), MAP_ENTRIES)) {
      const val = lenFieldUnique(decodeMessage(entry), ENTRY_VALUE, "TextMap.Entry.value");
      if (val !== undefined) collectPartyLeaves(val, out, depth + 1);
    }
  }
}

/**
 * Collect every party-typed leaf in a `GlobalKeyWithMaintainers` (the contract-
 * key metadata attached to Create.key (field 8) / Exercise.key (field 15) /
 * Fetch.key (field 9) / QueryByKey.key (field 5)). A contract key carries
 * parties in TWO positions, BOTH covered by the agent's signature once a V3
 * hashing scheme is negotiated (the V3 NodeHashBuilder hashes keyOpt +
 * maintainers): the `maintainers` (GKWM field 2, repeated string party) AND the
 * inner contract-key `Value` (GKWM.key=1 → GlobalKey.key=3), which is a full
 * Daml `Value` tree that can itself hold a party leaf. Both were previously
 * invisible to the foreign-party backstop, so a relay could place ATTACKER ONLY
 * in a key position and slip past `assertNoForeignParties` (the file's stated
 * invariant is that a party introduced ANYWHERE the signature covers is visible
 * to the backstop). We scan both and feed them into the backstop's `elsewhere`
 * set — a key party is NEVER a legitimate recipient position, so it must equal
 * an already-allowed party or be rejected. Fail-closed; honest CC
 * transfers/commands carry no contract key, so this never affects the happy path.
 *
 * @param gkwm
 * @param out
 * @param depth
 */
function collectGlobalKeyWithMaintainersParties(
  gkwm: Uint8Array,
  out: string[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) throw new PreparedDecodeError("contract key nesting too deep");
  const f = decodeMessage(gkwm);
  // maintainers (repeated string party) — authorization parties on the key.
  out.push(...stringFields(f, GKWM_MAINTAINERS));
  // the inner GlobalKey.key Value (the contract-key payload) — descend it as a
  // full Daml Value so a party leaf hidden inside the key surfaces too.
  const globalKey = lenFieldUnique(f, GKWM_KEY, "GlobalKeyWithMaintainers.key");
  if (globalKey !== undefined) {
    const keyValue = lenFieldUnique(decodeMessage(globalKey), GLOBALKEY_KEY, "GlobalKey.key");
    if (keyValue !== undefined) collectPartyLeaves(keyValue, out, depth + 1);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * PreparedTransaction structural descent.
 * ──────────────────────────────────────────────────────────────────────── */

// PreparedTransaction / Metadata / DamlTransaction / Node field numbers.
// Schema-pinned against com.daml.ledger.api.v2.interactive (Canton 3.x):
//   PreparedTransaction.transaction=1, .metadata=2
//   Metadata.submitter_info=2 ; SubmitterInfo.act_as=1
//   DamlTransaction.version=1, .roots=2, .nodes=3
//   DamlTransaction.Node.node_id=1, oneof versioned_node { v1=1000 }
//   transaction.v1.Node oneof node_type { create=1 fetch=2 exercise=3
//                                          rollback=4 query_by_key=5 }
//   Exercise.choice_id=9, .chosen_value=10, .children=12, .exercise_result=13
//   Create.argument=5 ; Rollback.children=1
const PT_TRANSACTION = 1;
const PT_METADATA = 2;
const MD_SUBMITTER_INFO = 2;
const SI_ACT_AS = 1;
// Metadata "needs to be signed" block (interactive_submission_service.proto):
//   submitter_info=2 synchronizer_id=3 mediator_group=4 transaction_uuid=5
//   preparation_time=6 input_contracts=7 min_ledger_effective_time=9
//   max_ledger_effective_time=10 max_record_time=11
// (field 8 = global_key_mapping is the ONLY field NOT signed.) Every signed
// field is covered by the agent's signature, so verify must constrain the ones
// that affect WHERE/WHEN the transfer lands or WHICH parties it touches.
const MD_SYNCHRONIZER_ID = 3;
const MD_PREPARATION_TIME = 6;
const MD_INPUT_CONTRACTS = 7;
const MD_MIN_LEDGER_EFFECTIVE_TIME = 9;
const MD_MAX_LEDGER_EFFECTIVE_TIME = 10;
const MD_MAX_RECORD_TIME = 11;
// Metadata.InputContract: oneof contract { v1 Create = 1 }, created_at=1000,
// event_blob=1002. We descend the Create v1 argument for the party backstop.
const IC_V1 = 1;
const DT_ROOTS = 2;
const DT_NODES = 3;
const NODE_ID = 1;
const NODE_V1 = 1000;
// transaction.v1.Node.node_type oneof members.
const V1NODE_CREATE = 1;
const V1NODE_FETCH = 2;
const V1NODE_EXERCISE = 3;
const V1NODE_ROLLBACK = 4;
const V1NODE_QUERY_BY_KEY = 5;
// interactive.transaction.v1.Exercise field numbers (interactive_submission_data.proto).
const EX_CONTRACT_ID = 2; // Exercise.contract_id — the exercised target contract.
const EX_TEMPLATE_ID = 4;
const EX_SIGNATORIES = 5;
const EX_STAKEHOLDERS = 6;
const EX_ACTING_PARTIES = 7;
const EX_CHOICE_ID = 9;
const EX_CHOSEN_VALUE = 10;
const EX_CHILDREN = 12;
const EX_RESULT = 13;
const EX_CHOICE_OBSERVERS = 14;
const EX_KEY = 15; // Exercise.key : optional GlobalKeyWithMaintainers
// interactive.transaction.v1.Create field numbers.
// Field numbers CONFIRMED against a real MainNet PreparedTransaction (see
// src/__fixtures__/): lf_version=1, contract_id=2, package_name=3, template_id=4,
// create_argument=5, signatories=6, stakeholders=7, key=8.
const CREATE_CONTRACT_ID = 2; // Create.contract_id — identity of the created/input contract.
const CREATE_TEMPLATE_ID = 4; // Create.template_id : Identifier (same shape as Exercise.template_id).
const CREATE_ARGUMENT = 5;
const CREATE_SIGNATORIES = 6;
const CREATE_STAKEHOLDERS = 7;
const CREATE_KEY = 8; // Create.key : optional GlobalKeyWithMaintainers
// interactive.transaction.v1.Fetch field numbers (party lists; no Daml Value arg).
const FETCH_SIGNATORIES = 5;
const FETCH_STAKEHOLDERS = 6;
const FETCH_ACTING_PARTIES = 7;
const FETCH_KEY = 9; // Fetch.key : optional GlobalKeyWithMaintainers
// interactive.transaction.v1.QueryByKey + GlobalKeyWithMaintainers + GlobalKey.
const QBK_KEY = 5; // QueryByKey.key : GlobalKeyWithMaintainers
const GKWM_KEY = 1; // GlobalKeyWithMaintainers.key : GlobalKey
const GKWM_MAINTAINERS = 2; // GlobalKeyWithMaintainers.maintainers (repeated string party)
const GLOBALKEY_KEY = 3; // GlobalKey.key : Value (the contract-key Value tree)
const ROLLBACK_CHILDREN = 1;
// Identifier (com.daml.ledger.api.v2.value.Identifier): module_name=2, entity_name=3.
// (package_id=1 is intentionally NOT pinned — it varies with package upgrades.)
const ID_PACKAGE_ID = 1;
const ID_MODULE_NAME = 2;
const ID_ENTITY_NAME = 3;

/** The transfer choice on a TransferFactory. */
const TRANSFER_CHOICE = "TransferFactory_Transfer";

export interface DecodedExercise {
  choiceId: string;
  chosenValue: Uint8Array;
  /** The exercised contract id (Exercise.contract_id, field 2), UTF-8 decoded.
   *  Pinned by the arms ONLY when the caller supplies an expected value
   *  (defense-in-depth: closes the resolve→prepare TOCTOU where a relay points
   *  the choice at a contract other than the one it resolved to the agent).
   *  undefined if the node carried no decodable contract_id. */
  contractId?: string | undefined;
  /** The exercised contract's template, as a `module:entity` qualified name (the
   *  package id is dropped because it changes across package upgrades). Used to
   *  pin WHICH template the validated choice runs against, so a relay cannot
   *  point a same-named choice at a confusable/attacker template. undefined if
   *  the node carried no decodable template_id. */
  templateQualifiedName?: string | undefined;
}

/** The recognized `transaction.v1.Node` node-type oneof members. Anything not
 *  in this set is treated as PRESENT-AND-UNVALIDATED (reject), never skipped. */
type NodeKind = "create" | "fetch" | "exercise" | "rollback" | "query_by_key";

/**
 * One fully-accounted node of the prepared transaction. EVERY entry in
 * DamlTransaction.nodes produces exactly one of these — a node we cannot fully
 * recognize is recorded with `recognized=false` rather than silently dropped, so
 * the invariant layer can fail closed on it (this is the fix for the bypass
 * where a sibling node carried under a non-1000 node version, or as a
 * non-exercise node type, was invisible to verify).
 */
export interface DecodedNode {
  /** DamlTransaction.Node.node_id (the id `roots`/`children` reference). */
  nodeId: string;
  /** False ⇒ the node version was not the known `v1` (1000) oneof member, or it
   *  set an unknown/extra versioned_node member. Such a node is opaque: a
   *  participant understanding that version could execute it under our signature,
   *  so we must refuse to sign. */
  recognizedVersion: boolean;
  /** The v1 node-type oneof member, or undefined if !recognizedVersion or the
   *  inner node set no/unknown node_type member. undefined ⇒ reject. */
  kind?: NodeKind | undefined;
  /** For exercise nodes: the choice id + chosen value (money-critical args). */
  exercise?: DecodedExercise | undefined;
  /** For create nodes: the created template's `module:entity` qualified name
   *  (package-id dropped — it changes across upgrades) + the raw `Create.argument`
   *  Value bytes. Lets an arm pin a NUMERIC (non-party) field of a CONSEQUENCE
   *  create — e.g. the `amount` recorded on a created `X402Escrow` — which the
   *  party-leaf backstop cannot see. undefined for non-create nodes / a create
   *  carrying no decodable template / argument. */
  create?:
    | { templateQualifiedName?: string | undefined; argument?: Uint8Array | undefined }
    | undefined;
  /** node_id references this node declares as its children (Exercise.children /
   *  Rollback.children). Used to prove reachability from the single root so no
   *  orphan (extra-leg) node can hide in DamlTransaction.nodes. */
  children: string[];
  /** Every `Value`-typed payload this node introduces (exercise chosen_value &
   *  exercise_result, create argument). The foreign-party backstop scans the
   *  UNION of these across ALL nodes, not just the matched root exercise — so a
   *  party/recipient introduced by ANY sibling/consequence node surfaces. */
  values: Uint8Array[];
  /** Node-level `repeated string party` fields that are NOT carried inside a
   *  Daml `Value` tree: Create.signatories/stakeholders,
   *  Exercise.signatories/stakeholders/acting_parties/choice_observers,
   *  Fetch.signatories/stakeholders/acting_parties, and a QueryByKey's key
   *  maintainers. The foreign-party backstop scans these too, so an attacker
   *  party placed as e.g. a consequence contract's stakeholder/observer (a
   *  position invisible to the Value-leaf walk) still surfaces. */
  partyMeta: string[];
}

export interface DecodedPrepared {
  /** `act_as` parties from Metadata.submitter_info (authoritative submitter). */
  actAs: string[];
  /** DamlTransaction.roots — node_ids declared as transaction roots. */
  roots: string[];
  /** EVERY node in DamlTransaction.nodes, fully accounted (recognized or not). */
  nodes: DecodedNode[];
  /** Convenience view: every recognized Exercise node's choice id + chosen value
   *  (backwards-compatible with callers that only inspected exercises). */
  exercises: DecodedExercise[];
  /** Metadata.synchronizer_id (proto field 3, in the SIGNED block). undefined if
   *  absent. Pinned to caller intent by the arms when supplied. */
  synchronizerId?: string | undefined;
  /** SIGNED Metadata timing fields, microseconds since the Unix epoch, as
   *  BigInts (undefined if absent). All in the proto's "needs to be signed"
   *  block, so the agent's signature covers them; the arms sanity-bound them. */
  preparationTime?: bigint | undefined;
  minLedgerEffectiveTime?: bigint | undefined;
  maxLedgerEffectiveTime?: bigint | undefined;
  maxRecordTime?: bigint | undefined;
  /** Every Create `argument` Value carried in Metadata.input_contracts (proto
   *  field 7, SIGNED): the authenticated input-contract set. Scanned by the
   *  foreign-party backstop so a party that appears ONLY inside an input
   *  contract's payload (never in a transaction node) still surfaces. */
  inputContractValues: Uint8Array[];
  /** The node-level `repeated string party` fields of each Metadata.input_contracts
   *  Create — signatories (field 6) + stakeholders (field 7) + any contract-key
   *  parties (field 8). The V2 metadata hasher binds disclosed/input contracts via
   *  `hashNode(toCreateNode)` → addCreateNode, which hashes argument + signatories
   *  + stakeholders, so these party fields ARE covered by the agent's signature;
   *  the backstop scans them so a foreign party placed ONLY as an input-contract
   *  signatory/stakeholder (not in its argument) still surfaces. */
  inputContractPartyMeta: string[];
  /** The SAME authenticated input contracts, GROUPED and carrying identity +
   *  template. The flattened lists above are unchanged and remain the generic
   *  backstop's input; this grouped view exists so a party occurrence can be
   *  related to the contract that explains it (provenance) instead of being
   *  accepted by value. */
  inputContracts: DecodedInputContract[];
}

/**
 * All values of a repeated `string` field, decoded UTF-8 (in order).
 *
 * @param fields
 * @param field
 */
function stringFields(fields: WireField[], field: number): string[] {
  return lenFields(fields, field).map(utf8);
}

/**
 * Decode an `Identifier` (value.proto) to its `module:entity` qualified name.
 * The package id (field 1) is deliberately DROPPED: it changes across package
 * upgrades, so pinning it would break honest transfers; module + entity together
 * unambiguously name the template. Returns undefined if the identifier is empty
 * or does not carry both names.
 *
 * @param idBytes
 */
function identifierQualifiedName(idBytes: Uint8Array): string | undefined {
  // An Identifier may be serialized either as the structured message
  // {package_id=1, module_name=2, entity_name=3} OR (in some Canton encodings of
  // the interactive node template_id) as a single flat string "pkg:module:entity"
  // / "module:entity". Handle both: try the structured fields first; only if a
  // structured decode succeeds AND carries a module/entity field do we use it. A
  // flat string is NOT valid protobuf, so `decodeMessage` may throw — fall back
  // to the flat-string interpretation in that case.
  let moduleName: Uint8Array | undefined;
  let entityName: Uint8Array | undefined;
  let structuredHadOtherFields = false;
  try {
    const f = decodeMessage(idBytes);
    moduleName = lenFieldUnique(f, ID_MODULE_NAME, "Identifier.module_name");
    entityName = lenFieldUnique(f, ID_ENTITY_NAME, "Identifier.entity_name");
    structuredHadOtherFields = f.some(x => x.field === ID_PACKAGE_ID);
  } catch {
    /* not structured protobuf — treat as a flat string below */
  }
  if (moduleName !== undefined && entityName !== undefined) {
    return `${utf8(moduleName)}:${utf8(entityName)}`;
  }
  // A structured Identifier with a package_id but no module/entity is malformed
  // for our purpose; only fall through to flat-string when it did NOT look like a
  // structured Identifier at all.
  if (structuredHadOtherFields) return undefined;
  // Flat-string form. A template id string is "package:Module.Path:Entity" or
  // "Module.Path:Entity"; normalize to the trailing two colon-separated segments
  // (module:entity), dropping a leading package-id when present.
  let flat: string;
  try {
    flat = utf8(idBytes);
  } catch {
    return undefined;
  }
  if (flat.length === 0 || flat.includes("\u0000")) return undefined;
  const parts = flat.split(":");
  if (parts.length >= 3) return `${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
  if (parts.length === 2) return flat;
  return undefined;
}

/**
 * Decode the inner `transaction.v1.Node` (the node_type oneof). Returns the
 * single set member and the per-kind payload we validate. A node that sets NO
 * known member, or MORE THAN ONE, is reported as `kind: undefined` so the
 * invariant layer rejects it (fail closed — an ambiguous/opaque node could be
 * executed by the participant as something other than what we read).
 *
 * Beyond the Daml `Value` payloads we also collect every node-level
 * `repeated string party` field (signatories/stakeholders/acting_parties/
 * choice_observers and a QueryByKey's key maintainers) into `partyMeta`, so the
 * foreign-party backstop sees a party placed in authorization/visibility
 * metadata (a position outside the Value-leaf walk), and the exercised
 * template's `module:entity` so the arm can pin WHICH template the choice runs
 * against.
 *
 * @param v1Body
 */
function decodeV1Node(v1Body: Uint8Array): {
  kind?: NodeKind | undefined;
  exercise?: DecodedExercise | undefined;
  create?:
    | { templateQualifiedName?: string | undefined; argument?: Uint8Array | undefined }
    | undefined;
  children: string[];
  values: Uint8Array[];
  partyMeta: string[];
} {
  const v1n = decodeMessage(v1Body);
  // Detect which (if any) node_type oneof members are present. Each is
  // non-repeated; a duplicate is ambiguous under last-wins so reject via the
  // unique accessor. Count DISTINCT members set — more than one ⇒ reject.
  const create = lenFieldUnique(v1n, V1NODE_CREATE, "v1.Node.create");
  const fetch = lenFieldUnique(v1n, V1NODE_FETCH, "v1.Node.fetch");
  const exercise = lenFieldUnique(v1n, V1NODE_EXERCISE, "v1.Node.exercise");
  const rollback = lenFieldUnique(v1n, V1NODE_ROLLBACK, "v1.Node.rollback");
  const queryByKey = lenFieldUnique(v1n, V1NODE_QUERY_BY_KEY, "v1.Node.query_by_key");
  const present = [create, fetch, exercise, rollback, queryByKey].filter(m => m !== undefined);
  if (present.length === 0) return { children: [], values: [], partyMeta: [] }; // kind undefined ⇒ reject
  if (present.length > 1) return { children: [], values: [], partyMeta: [] }; // ambiguous oneof ⇒ reject

  if (exercise !== undefined) {
    const exFields = decodeMessage(exercise);
    const choiceIdBytes = lenFieldUnique(exFields, EX_CHOICE_ID, "Exercise.choice_id");
    const chosen = lenFieldUnique(exFields, EX_CHOSEN_VALUE, "Exercise.chosen_value");
    const result = lenFieldUnique(exFields, EX_RESULT, "Exercise.exercise_result");
    const children = lenFields(exFields, EX_CHILDREN).map(utf8);
    const tmpl = lenFieldUnique(exFields, EX_TEMPLATE_ID, "Exercise.template_id");
    const cidBytes = lenFieldUnique(exFields, EX_CONTRACT_ID, "Exercise.contract_id");
    const values: Uint8Array[] = [];
    if (chosen !== undefined) values.push(chosen);
    if (result !== undefined) values.push(result);
    const partyMeta = [
      ...stringFields(exFields, EX_SIGNATORIES),
      ...stringFields(exFields, EX_STAKEHOLDERS),
      ...stringFields(exFields, EX_ACTING_PARTIES),
      ...stringFields(exFields, EX_CHOICE_OBSERVERS),
    ];
    // Exercise.key (field 15, optional GlobalKeyWithMaintainers): a contract-key
    // party (maintainer or inner key Value leaf) is a position the agent's
    // signature covers under V3 hashing — scan it so a relay cannot hide a
    // foreign party there (closes the contract-key backstop blind spot).
    const exKey = lenFieldUnique(exFields, EX_KEY, "Exercise.key");
    if (exKey !== undefined) collectGlobalKeyWithMaintainersParties(exKey, partyMeta, 0);
    const dec: DecodedExercise | undefined =
      choiceIdBytes !== undefined && chosen !== undefined
        ? {
            choiceId: utf8(choiceIdBytes),
            chosenValue: chosen,
            contractId: cidBytes !== undefined ? utf8(cidBytes) : undefined,
            templateQualifiedName: tmpl !== undefined ? identifierQualifiedName(tmpl) : undefined,
          }
        : undefined;
    return { kind: "exercise", exercise: dec, children, values, partyMeta };
  }
  if (create !== undefined) {
    const cFields = decodeMessage(create);
    const arg = lenFieldUnique(cFields, CREATE_ARGUMENT, "Create.argument");
    const cTmpl = lenFieldUnique(cFields, CREATE_TEMPLATE_ID, "Create.template_id");
    const partyMeta = [
      ...stringFields(cFields, CREATE_SIGNATORIES),
      ...stringFields(cFields, CREATE_STAKEHOLDERS),
    ];
    // Create.key (field 8, optional GlobalKeyWithMaintainers): scan the key
    // maintainers + inner contract-key Value so a foreign party placed ONLY in a
    // consequence Create's key (a position the V3 hash signs) surfaces.
    const cKey = lenFieldUnique(cFields, CREATE_KEY, "Create.key");
    if (cKey !== undefined) collectGlobalKeyWithMaintainersParties(cKey, partyMeta, 0);
    return {
      kind: "create",
      // Capture the created template + argument so an arm can pin a NUMERIC
      // (non-party) field of a consequence create (e.g. X402Escrow.amount), which
      // the party-leaf backstop cannot see.
      create: {
        templateQualifiedName: cTmpl !== undefined ? identifierQualifiedName(cTmpl) : undefined,
        argument: arg,
      },
      children: [],
      values: arg !== undefined ? [arg] : [],
      partyMeta,
    };
  }
  if (rollback !== undefined) {
    const rFields = decodeMessage(rollback);
    const children = lenFields(rFields, ROLLBACK_CHILDREN).map(utf8);
    return { kind: "rollback", children, values: [], partyMeta: [] };
  }
  if (fetch !== undefined) {
    // Fetch carries no Daml `Value` argument, but DOES carry node-level party
    // lists (signatories/stakeholders/acting_parties) — collect them so the
    // backstop sees a foreign party smuggled onto a fetch consequence.
    const fFields = decodeMessage(fetch);
    const partyMeta = [
      ...stringFields(fFields, FETCH_SIGNATORIES),
      ...stringFields(fFields, FETCH_STAKEHOLDERS),
      ...stringFields(fFields, FETCH_ACTING_PARTIES),
    ];
    // Fetch.key (field 9, optional GlobalKeyWithMaintainers): scan its parties
    // (maintainers + inner key Value) too.
    const fKey = lenFieldUnique(fFields, FETCH_KEY, "Fetch.key");
    if (fKey !== undefined) collectGlobalKeyWithMaintainersParties(fKey, partyMeta, 0);
    return { kind: "fetch", children: [], values: [], partyMeta };
  }
  // query_by_key — carries no Value argument, but its GlobalKeyWithMaintainers
  // carries key maintainer parties AND an inner contract-key Value that can hold
  // a party leaf; collect BOTH for the backstop (previously only maintainers
  // were scanned, so a party hidden in the inner key Value escaped).
  const qFields = decodeMessage(queryByKey as Uint8Array);
  const partyMeta: string[] = [];
  const key = lenFieldUnique(qFields, QBK_KEY, "QueryByKey.key");
  if (key !== undefined) collectGlobalKeyWithMaintainersParties(key, partyMeta, 0);
  return { kind: "query_by_key", children: [], values: [], partyMeta };
}

/**
 * Decode a base64 `PreparedTransaction` into the bits we validate.
 *
 * Enumerates EVERY node in DamlTransaction.nodes — every node-version member and
 * every node-type oneof member — recording unrecognized ones as
 * present-but-unvalidated (never silently skipping them). The single allowed
 * root exercise, no-orphan reachability, and the all-nodes value backstop are
 * enforced by the per-arm invariant (`assertSingleAllowedRootExercise`).
 *
 * @param preparedTransactionB64
 */
export function decodePrepared(preparedTransactionB64: string): DecodedPrepared {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(preparedTransactionB64, "base64");
  } catch {
    throw new PreparedDecodeError("preparedTransaction is not valid base64");
  }
  if (bytes.length === 0)
    throw new PreparedDecodeError("preparedTransaction decoded to empty bytes");

  const top = decodeMessage(bytes);

  // metadata.submitter_info.act_as.  `transaction` and `metadata` are
  // non-repeated: a duplicate would let a last-wins participant read a different
  // one than we validate, so reject duplicates (act_as / nodes stay repeated).
  const actAs: string[] = [];
  let synchronizerId: string | undefined;
  let preparationTime: bigint | undefined;
  let minLedgerEffectiveTime: bigint | undefined;
  let maxLedgerEffectiveTime: bigint | undefined;
  let maxRecordTime: bigint | undefined;
  const inputContractValues: Uint8Array[] = [];
  const inputContractPartyMeta: string[] = [];
  const inputContracts: DecodedInputContract[] = [];
  const metadata = lenFieldUnique(top, PT_METADATA, "PreparedTransaction.metadata");
  if (metadata !== undefined) {
    const md = decodeMessage(metadata);
    const si = lenFieldUnique(md, MD_SUBMITTER_INFO, "Metadata.submitter_info");
    if (si !== undefined) {
      for (const a of lenFields(decodeMessage(si), SI_ACT_AS)) actAs.push(utf8(a));
    }
    // synchronizer_id (field 3) — SIGNED; pinned to caller intent by the arms.
    const sync = lenFieldUnique(md, MD_SYNCHRONIZER_ID, "Metadata.synchronizer_id");
    if (sync !== undefined) synchronizerId = utf8(sync);
    // SIGNED timing fields (uint64 µs). Read BigInt-precise; the arms sanity-bound.
    preparationTime = varintFieldUnique(md, MD_PREPARATION_TIME, "Metadata.preparation_time");
    minLedgerEffectiveTime = varintFieldUnique(
      md,
      MD_MIN_LEDGER_EFFECTIVE_TIME,
      "Metadata.min_ledger_effective_time",
    );
    maxLedgerEffectiveTime = varintFieldUnique(
      md,
      MD_MAX_LEDGER_EFFECTIVE_TIME,
      "Metadata.max_ledger_effective_time",
    );
    maxRecordTime = varintFieldUnique(md, MD_MAX_RECORD_TIME, "Metadata.max_record_time");
    // input_contracts (field 7, repeated, SIGNED): descend each InputContract's
    // Create v1 argument so the foreign-party backstop covers parties that appear
    // ONLY inside the authenticated input-contract set (never in a tx node). We
    // ALSO read the Create's signatories/stakeholders/key — the V2 metadata hasher
    // binds disclosed/input contracts via hashNode(toCreateNode) → addCreateNode,
    // which hashes argument + signatories + stakeholders, so those party fields are
    // covered by the agent's signature and a foreign party placed ONLY there must
    // surface to the backstop (closes the input-contract party-coverage asymmetry).
    for (const ic of lenFields(md, MD_INPUT_CONTRACTS)) {
      const icFields = decodeMessage(ic);
      const v1create = lenFieldUnique(icFields, IC_V1, "InputContract.v1");
      if (v1create === undefined) {
        // The InputContract sets no known `contract` oneof member (v1 = field 1).
        // It is carried under an unknown/future encoding whose Create argument we
        // cannot scan — fail closed (mirror the recognized=false treatment of
        // transaction nodes). A foreign party hidden in such an input contract
        // would otherwise escape the all-nodes backstop. (created_at/event_blob
        // are high-numbered non-oneof fields, so an honest InputContract always
        // carries the v1 member here.)
        throw new PreparedDecodeError(
          "Metadata.input_contracts entry sets no known `contract` member (expected v1) — " +
            "refusing to sign (uninspectable input contract that could carry a foreign party)",
        );
      }
      const createFields = decodeMessage(v1create);
      const arg = lenFieldUnique(createFields, CREATE_ARGUMENT, "InputContract.v1.argument");
      if (arg !== undefined) inputContractValues.push(arg);
      const icSignatories = stringFields(createFields, CREATE_SIGNATORIES);
      const icStakeholders = stringFields(createFields, CREATE_STAKEHOLDERS);
      inputContractPartyMeta.push(...icSignatories);
      inputContractPartyMeta.push(...icStakeholders);
      const icKey = lenFieldUnique(createFields, CREATE_KEY, "InputContract.v1.key");
      if (icKey !== undefined) {
        collectGlobalKeyWithMaintainersParties(icKey, inputContractPartyMeta, 0);
      }
      // GROUPED view of the same authenticated input contract. The flattened
      // lists above stay exactly as they were (every existing consumer is
      // untouched); this adds the identity + template needed to relate a party
      // occurrence to the contract that explains it, instead of accepting a
      // party by VALUE alone.
      const icTmpl = lenFieldUnique(
        createFields,
        CREATE_TEMPLATE_ID,
        "InputContract.v1.template_id",
      );
      const icCid = lenFieldUnique(
        createFields,
        CREATE_CONTRACT_ID,
        "InputContract.v1.contract_id",
      );
      const icQualified = icTmpl !== undefined ? identifierQualifiedName(icTmpl) : undefined;
      inputContracts.push({
        ...(icCid !== undefined ? { contractId: utf8(icCid) } : {}),
        ...(icQualified !== undefined ? { templateQualifiedName: icQualified } : {}),
        ...(arg !== undefined ? { argument: arg } : {}),
        signatories: icSignatories,
        stakeholders: icStakeholders,
      });
    }
  }

  const transaction = lenFieldUnique(top, PT_TRANSACTION, "PreparedTransaction.transaction");
  if (transaction === undefined) {
    throw new PreparedDecodeError("PreparedTransaction has no transaction");
  }
  const dt = decodeMessage(transaction);
  const roots = lenFields(dt, DT_ROOTS).map(utf8);

  if (roots.length > MAX_ROOTS) {
    throw new PreparedDecodeError(
      `transaction declares ${roots.length} roots, over the ${MAX_ROOTS} cap`,
    );
  }

  const nodes: DecodedNode[] = [];
  const exercises: DecodedExercise[] = [];
  const nodeBodies = lenFields(dt, DT_NODES);
  // Counted BEFORE the loop: bailing part-way would still have paid for the
  // nodes already decoded, which is the cost this bound exists to refuse.
  if (nodeBodies.length > MAX_NODES) {
    throw new PreparedDecodeError(
      `transaction carries ${nodeBodies.length} nodes, over the ${MAX_NODES} cap`,
    );
  }
  for (const node of nodeBodies) {
    const n = decodeMessage(node);
    // node_id is non-repeated; reject a duplicate (a last-wins parser could
    // disagree about which id this node carries, breaking roots/children
    // reachability matching).
    const nodeIdBytes = lenFieldUnique(n, NODE_ID, "Node.node_id");
    const nodeId = nodeIdBytes !== undefined ? utf8(nodeIdBytes) : "";
    // Versioned-node oneof: the ONLY known member is v1 (1000). If v1 is absent
    // OR any OTHER length-delimited member (beyond node_id) is present, the node
    // is carried under a version we cannot read → record it unrecognized so the
    // invariant rejects it (closes the "hidden under node-version 1001" bypass).
    const v1 = lenFieldUnique(n, NODE_V1, "Node.v1");
    const extraVersioned = n.some(
      f => f.wire === WIRE_LEN && f.field !== NODE_ID && f.field !== NODE_V1,
    );
    if (v1 === undefined || extraVersioned) {
      nodes.push({ nodeId, recognizedVersion: false, children: [], values: [], partyMeta: [] });
      continue;
    }
    const dv = decodeV1Node(v1);
    nodes.push({
      nodeId,
      recognizedVersion: true,
      kind: dv.kind,
      exercise: dv.exercise,
      create: dv.create,
      children: dv.children,
      values: dv.values,
      partyMeta: dv.partyMeta,
    });
    if (dv.kind === "exercise" && dv.exercise !== undefined) exercises.push(dv.exercise);
  }
  return {
    actAs,
    roots,
    nodes,
    exercises,
    synchronizerId,
    preparationTime,
    minLedgerEffectiveTime,
    maxLedgerEffectiveTime,
    maxRecordTime,
    inputContractValues,
    inputContractPartyMeta,
    inputContracts,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Shared node-traversal INVARIANT (fix for the fund-redirection bypass).
 *
 * The strong typed-decode core proves the matched exercise's args equal intent.
 * But a signature authorizes the WHOLE DamlTransaction, so verify must also
 * prove there is NOTHING ELSE in the transaction. This invariant, enforced by
 * BOTH the cip56 and v1 arms, requires fail-closed (in this order — the first
 * three preserve the long-standing per-arm rejection messages, the rest close
 * the newly-found node-traversal bypasses):
 *
 *   1. EXACTLY ONE exercise of the allowed choice, and NO other exercise of any
 *      choice (extra-leg / wrong-choice / no-exercise contract — unchanged).
 *   2. EVERY node is recognized — known node version (v1) AND a single known
 *      node type. Any unrecognized version or unknown/ambiguous node type ⇒
 *      reject (closes the non-1000 node-version and unknown-node-type bypasses).
 *   3. EXACTLY ONE root, and that root node is THE single allowed exercise with
 *      the expected choice id. >1 root, or a root that is not that exercise ⇒
 *      reject (closes the sibling-Create / second-root extra-leg bypass).
 *   4. NO ORPHANS — every other node is reachable from the root via the
 *      exercise/rollback children chain. An unreferenced sibling node (even if
 *      `roots` lists only the honest id) ⇒ reject.
 *
 * The authoritative-submitter (act_as) check and the position-aware all-message
 * value backstop are applied by the arm AFTER its money-critical field comparison
 * (so a consistent-attacker tx still surfaces as a field mismatch first), via
 * `assertActAsIsSender` / `collectSplitPartyLeaves` + `assertNoForeignParties`.
 *
 * Returns the single validated root exercise (and its node id, for the
 * position-aware backstop) so the arm can extract+compare its money-critical
 * fields. `allowedChoiceId` is the only choice the root may be.
 */
/** A choice permitted as a CONSEQUENCE of the single allowed root exercise.
 *  Bare string = permitted on any template (template-defined choices, where the
 *  name identifies the code). Object form additionally PINS the templates the
 *  choice may run on — mandatory for interface choices. */
type ConsequenceChoiceRule =
  | string
  | { readonly choiceId: string; readonly templates: readonly string[] };

/** Does `ex` match one of the consequence rules? A pinned rule requires BOTH the
 *  choice id and a template from its whitelist; an exercise whose template we
 *  could not decode never satisfies a pinned rule (fail-closed — we cannot prove
 *
 * @param ex
 * @param rules
 *  - which implementation of the interface would run). */
function isAllowedConsequence(
  ex: DecodedExercise,
  rules: readonly ConsequenceChoiceRule[],
): boolean {
  for (const rule of rules) {
    if (typeof rule === "string") {
      if (rule === ex.choiceId) return true;
      continue;
    }
    if (rule.choiceId !== ex.choiceId) continue;
    if (ex.templateQualifiedName === undefined) continue;
    if (rule.templates.includes(ex.templateQualifiedName)) return true;
  }
  return false;
}

/**
 *
 * @param decoded
 * @param allowedChoiceId
 * @param countNoun
 * @param allowedConsequenceChoices
 */
function assertSingleAllowedRootExercise(
  decoded: DecodedPrepared,
  allowedChoiceId: string,
  /** Human-friendly plural ("transfer" / the choice id) used ONLY in the
   *  exercise-count messages so each arm keeps its historical wording. */
  countNoun: string = allowedChoiceId,
  /** Choices permitted ONLY as CONSEQUENCES (descendants) of the single allowed
   *  root exercise — the accept path's honest settlement side-effects. Empty for
   *  the pay paths (which stay strict). Still bound by the structural guards
   *  below: there is exactly ONE root (the allowed choice) and every node —
   *  these included — must be reachable from it (no sibling-root / orphan drain
   *  leg). A value-MOVING choice is never placed here, so an injected outbound
   *  drain is still refused.
   *
   *  A bare string permits the choice on ANY template — safe only for choices
   *  defined on a TEMPLATE, where the name already identifies the code that
   *  runs (`Archive`, the Splice settlement choices). An INTERFACE choice must
   *  use the pinned object form: its body is `virtual`, chosen by whichever
   *  package implements the interface, so the name alone proves nothing about
   *  what executes. See `EVENT_LOG_HOLDINGS_CHANGE`. */
  allowedConsequenceChoices: readonly ConsequenceChoiceRule[] = [],
): { exercise: DecodedExercise; rootNodeId: string } {
  // (1) Exercise-count contract (unchanged messages): exactly one exercise of
  // the allowed choice, and no other exercise of any choice. This runs first so
  // an extra/duplicate/wrong-choice exercise surfaces with the historical
  // message before the structural (root/orphan) checks below.
  const allowedExercises = decoded.exercises.filter(e => e.choiceId === allowedChoiceId);
  if (allowedExercises.length === 0) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction contains no ${allowedChoiceId} exercise — refusing to sign ` +
        `(possible tampered/compromised relay)`,
    );
  }
  if (allowedExercises.length > 1) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction contains ${allowedExercises.length} ${countNoun} ` +
        `exercises — refusing to sign (possible tampered/compromised relay adding a second leg)`,
    );
  }
  const otherExercises = decoded.exercises.filter(
    e => e.choiceId !== allowedChoiceId && !isAllowedConsequence(e, allowedConsequenceChoices),
  );
  if (otherExercises.length > 0) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction contains unexpected exercise(s) ` +
        `${otherExercises.map(e => JSON.stringify(e.choiceId)).join(", ")} — refusing to sign`,
    );
  }

  // (2) Every node must be fully recognized. An unrecognized node version or an
  // unknown/ambiguous node type is opaque — a participant could execute it under
  // our signature — so fail closed.
  for (const node of decoded.nodes) {
    if (!node.recognizedVersion) {
      throw new PreparedTransferMismatchError(
        `relay-prepared transaction contains a node (id ${JSON.stringify(node.nodeId)}) carried ` +
          `under an unrecognized node version — refusing to sign (cannot prove it does not move ` +
          `value under the agent's authority)`,
      );
    }
    if (node.kind === undefined) {
      throw new PreparedTransferMismatchError(
        `relay-prepared transaction contains a node (id ${JSON.stringify(node.nodeId)}) with an ` +
          `unknown or ambiguous node type — refusing to sign`,
      );
    }
    // A node typed as an exercise whose choice_id/chosen_value we could NOT fully
    // decode (DecodedExercise undefined) is an OPAQUE exercise: it is invisible to
    // the exercise-count checks above (which key off decoded.exercises, populated
    // only for fully-decoded exercises) yet a participant could run it under the
    // agent's single signature. Fail closed — we cannot prove it is the single
    // allowed transfer. (Closes the exercise-count blind spot where a sibling
    // exercise sets the exercise oneof + choice_id but OMITS chosen_value.)
    if (node.kind === "exercise" && node.exercise === undefined) {
      throw new PreparedTransferMismatchError(
        `relay-prepared transaction contains an exercise node (id ${JSON.stringify(node.nodeId)}) ` +
          `whose choice argument could not be decoded (missing choice_id/chosen_value) — refusing ` +
          `to sign (cannot prove it is the intended ${JSON.stringify(allowedChoiceId)} exercise)`,
      );
    }
  }

  // (3) Exactly one root, and it must resolve to the single allowed exercise.
  if (decoded.roots.length !== 1) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction has ${decoded.roots.length} root nodes — expected exactly one ` +
        `(${JSON.stringify(allowedChoiceId)}) — refusing to sign (possible tampered/compromised ` +
        `relay adding a second root leg)`,
    );
  }
  const byId = new Map<string, DecodedNode>();
  for (const node of decoded.nodes) {
    if (byId.has(node.nodeId)) {
      throw new PreparedTransferMismatchError(
        `relay-prepared transaction has duplicate node id ${JSON.stringify(node.nodeId)} — ` +
          `refusing to sign (ambiguous node graph)`,
      );
    }
    byId.set(node.nodeId, node);
  }
  const rootId = decoded.roots[0] as string;
  const rootNode = byId.get(rootId);
  if (rootNode === undefined) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction root id ${JSON.stringify(rootId)} does not match any node — ` +
        `refusing to sign`,
    );
  }
  if (rootNode.kind !== "exercise" || rootNode.exercise === undefined) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction root node is not a ${JSON.stringify(allowedChoiceId)} exercise ` +
        `(got node type ${JSON.stringify(rootNode.kind ?? "unknown")}) — refusing to sign`,
    );
  }
  if (rootNode.exercise.choiceId !== allowedChoiceId) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction root exercise is ${JSON.stringify(rootNode.exercise.choiceId)} — ` +
        `expected ${JSON.stringify(allowedChoiceId)} — refusing to sign`,
    );
  }

  // (4) No orphans: every node must be reachable from the single root via the
  // children chain. An unreferenced sibling (the extra-leg vector) ⇒ reject.
  const reachable = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = byId.get(id);
    if (node === undefined) {
      throw new PreparedTransferMismatchError(
        `relay-prepared transaction references child node id ${JSON.stringify(id)} that does not ` +
          `exist — refusing to sign`,
      );
    }
    for (const child of node.children) stack.push(child);
  }
  const orphans = decoded.nodes.filter(nd => !reachable.has(nd.nodeId));
  if (orphans.length > 0) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction contains ${orphans.length} node(s) not reachable from the root ` +
        `(ids ${orphans.map(o => JSON.stringify(o.nodeId)).join(", ")}) — refusing to sign ` +
        `(possible tampered/compromised relay hiding an extra leg)`,
    );
  }

  return { exercise: rootNode.exercise, rootNodeId: rootId };
}

/* ────────────────────────────────────────────────────────────────────────
 * Shared SIGNED-Metadata checks (synchronizer + timing). Every field below is
 * in the proto's "Metadata information that needs to be signed" block, so the
 * agent's single signature authorizes them; verify must constrain the ones that
 * decide WHERE (which synchronizer) and WHEN (validity window) the transfer
 * lands, or a malicious relay can land the agent's signature on a wrong domain
 * or with an already-lapsed / implausibly-skewed validity window.
 * ──────────────────────────────────────────────────────────────────────── */

/** Pin Metadata.synchronizer_id to caller intent when the caller supplies one.
 *  Fail-closed: if pinned but absent/different, refuse. (No pin ⇒ unchanged.) */
/**
 * The version-serial suffix a participant deterministically appends to the
 * LOGICAL synchronizer id to form the PHYSICAL one it signs into
 * Metadata.synchronizer_id: `::<protocol-version>-<topology-serial>`, e.g. a
 * logical `global-domain::1220<fingerprint>` is signed as
 * `global-domain::1220<fingerprint>::35-2`. STRICT shape: two non-empty decimal
 * runs joined by a single hyphen. (Confirmed on a live TestNet prepared
 * `TransferFactory_Transfer`: prepare REQUIRES the logical id — the participant
 * 400s `INVALID_FIELD synchronizer_id` on the physical form — yet the bytes it
 * returns carry the physical `::35-2` suffix, so an exact-equality pin against
 * the logical caller intent false-rejects a legitimate tx.) */
const PHYSICAL_SYNCHRONIZER_SUFFIX = /^[0-9]+-[0-9]+$/;

/**
 * Pin Metadata.synchronizer_id to caller intent. Fail-closed: a different domain
 * is refused. The caller threads the LOGICAL synchronizer id (`<name>::<namespace
 * fingerprint>`) — the value the participant accepts on prepare — but the SIGNED
 * bytes carry the PHYSICAL id (logical + `::<version>-<serial>`). We therefore
 * accept the signed id iff it is EXACTLY the expected logical id, OR the expected
 * id followed by a single `::<version>-<serial>` suffix of the strict
 * physical-synchronizer shape.
 *
 * This is NOT a weakening: the security-relevant identity is the logical id,
 * whose `1220…` is the domain's cryptographic NAMESPACE fingerprint — an attacker
 * cannot forge a different domain that shares it, so anything matching
 * `expected + "::<n>-<m>"` is provably the SAME domain (same namespace owner) at
 * a participant-chosen protocol-version/topology-serial. A genuinely different
 * domain (different name or fingerprint), a non-suffix extension, or a
 * garbage/empty suffix does NOT match and is still rejected.
 *
 * @param synchronizerId
 * @param expected
 */
function assertSynchronizerMatches(
  synchronizerId: string | undefined,
  expected: string | undefined,
): void {
  if (expected === undefined) return; // caller did not pin — unchanged behaviour
  if (synchronizerId === undefined) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction has no synchronizer_id but caller intent pins ` +
        `${JSON.stringify(expected)} — refusing to sign`,
    );
  }
  let matches = synchronizerId === expected;
  if (!matches && synchronizerId.startsWith(expected + "::")) {
    // The remainder after the logical id MUST be exactly one physical-suffix
    // segment `<version>-<serial>` — no further `::` segments, no empty/garbage.
    const suffix = synchronizerId.slice(expected.length + 2);
    matches = PHYSICAL_SYNCHRONIZER_SUFFIX.test(suffix);
  }
  if (!matches) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction synchronizer_id is ${JSON.stringify(synchronizerId)} — expected ` +
        `${JSON.stringify(expected)} (optionally with a ::<version>-<serial> physical suffix) — ` +
        `refusing to sign (relay-chosen synchronizer/domain)`,
    );
  }
}

/** A generous skew (24h) for sanity-bounding the SIGNED Metadata timing fields.
 *  We are not pinning these to a tight window (the participant enforces the real
 *  ledger-time window); we only reject values that are clearly wrong — already
 *  lapsed, or implausibly far from now — so the agent never blind-signs a command
 *  that can never settle or carries a wildly-skewed timestamp. */
const TIMING_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Microseconds-since-epoch BigInt → milliseconds Number (NaN if not finite).
 *
 * @param micros
 */
function microsToMs(micros: bigint | undefined): number {
  if (micros === undefined) return NaN;
  try {
    return Number(micros / 1000n);
  } catch {
    return NaN;
  }
}

/**
 * Sanity-bound the SIGNED Metadata timing fields against `nowMs`:
 * - preparation_time must be within ±TIMING_SKEW of now (not wildly skewed);
 * - max_record_time / max_ledger_effective_time must not already be in the past
 * (an expired command can never settle — at best a DoS, at worst replays a
 * stale intent). These are best-effort: absent fields are skipped.
 *
 * @param decoded
 * @param nowMs
 */
function assertTimingPlausible(decoded: DecodedPrepared, nowMs: number): void {
  const prep = microsToMs(decoded.preparationTime);
  if (Number.isFinite(prep)) {
    if (prep > nowMs + TIMING_SKEW_MS || prep < nowMs - TIMING_SKEW_MS) {
      throw new PreparedTransferMismatchError(
        `relay-prepared transaction preparation_time (${new Date(prep).toISOString()}) is ` +
          `implausibly far from now — refusing to sign`,
      );
    }
  }
  const maxRecord = microsToMs(decoded.maxRecordTime);
  if (Number.isFinite(maxRecord) && maxRecord <= nowMs) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction max_record_time (${new Date(maxRecord).toISOString()}) is ` +
        `already in the past — refusing to sign (command could never be recorded)`,
    );
  }
  const maxLet = microsToMs(decoded.maxLedgerEffectiveTime);
  if (Number.isFinite(maxLet) && maxLet <= nowMs) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction max_ledger_effective_time (${new Date(maxLet).toISOString()}) ` +
        `is already in the past — refusing to sign`,
    );
  }
  // min_ledger_effective_time is SIGNED and was DECODED but previously not bounded
  // (an asymmetry vs the fields above). A relay-chosen value implausibly far in
  // the future would make the agent sign a command pinned to an unreachable
  // validity window (it can never become ledger-valid before it expires). Reject
  // it like the others; near-now / absent values pass.
  const minLet = microsToMs(decoded.minLedgerEffectiveTime);
  if (Number.isFinite(minLet) && minLet > nowMs + TIMING_SKEW_MS) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction min_ledger_effective_time (${new Date(minLet).toISOString()}) ` +
        `is implausibly far in the future — refusing to sign (command pinned to an unreachable ` +
        `validity window)`,
    );
  }
}

/**
 * Pin WHICH template the validated root exercise runs against. The choice NAME
 * and ARGUMENT are pinned elsewhere; this closes the template/contract-confusion
 * surface by additionally requiring the exercised template's `module:entity`
 * qualified name to equal caller intent (the package id is intentionally not
 * pinned — it changes across upgrades). No pin ⇒ unchanged behaviour.
 *
 * @param ex
 * @param expected
 */
function assertTemplateMatches(ex: DecodedExercise, expected: string | undefined): void {
  if (expected === undefined) return;
  if (ex.templateQualifiedName === undefined) {
    throw new PreparedTransferMismatchError(
      `relay-prepared exercise carries no decodable template_id but caller intent pins ` +
        `${JSON.stringify(expected)} — refusing to sign`,
    );
  }
  if (ex.templateQualifiedName !== expected) {
    throw new PreparedTransferMismatchError(
      `relay-prepared exercise runs against template ${JSON.stringify(ex.templateQualifiedName)} — ` +
        `expected ${JSON.stringify(expected)} — refusing to sign (template/contract confusion)`,
    );
  }
}

/**
 * Pin WHICH contract the validated root exercise is exercised on
 * (Exercise.contract_id). Defense-in-depth, OPT-IN: when the caller supplies the
 * exact target cid it built the command against (the factory / EPAR contract id
 * the relay resolved to it), the verifier requires the prepared exercise to
 * target the SAME contract and fails closed otherwise — closing the
 * resolve→prepare TOCTOU where a relay resolves one contract to the agent but
 * prepares the exercise against another. No pin ⇒ unchanged behaviour (the
 * all-nodes party backstop still contains any fund redirect a substituted target
 * could attempt, since the redirect needs a foreign-party consequence).
 *
 * @param ex
 * @param expected
 */
function assertContractIdMatches(ex: DecodedExercise, expected: string | undefined): void {
  if (expected === undefined) return;
  if (ex.contractId === undefined) {
    throw new PreparedTransferMismatchError(
      `relay-prepared exercise carries no decodable contract_id but caller intent pins ` +
        `${JSON.stringify(expected)} — refusing to sign`,
    );
  }
  if (ex.contractId !== expected) {
    throw new PreparedTransferMismatchError(
      `relay-prepared exercise targets contract ${JSON.stringify(ex.contractId)} — ` +
        `expected ${JSON.stringify(expected)} — refusing to sign ` +
        `(relay points the choice at a contract other than the one it resolved)`,
    );
  }
}

/**
 * Party leaves split by WHERE they appear, for the position-aware foreign-party
 * backstop (the fix for the unpinned-admin/dso neutralization bypass):
 *   - `rootArg`     : party leaves inside the validated root exercise's
 *                     chosen_value (where the admin/dso legitimately sits, at a
 *                     known field position).
 *   - `elsewhere`   : EVERY other party occurrence anywhere else in the signed
 *                     message — sibling/consequence node Value payloads, the
 *                     node-level `repeated string party` metadata
 *                     (signatories/stakeholders/acting_parties/choice_observers/
 *                     key-maintainers) of ANY node, and the Create arguments of
 *                     Metadata.input_contracts. The admin/dso is NOT auto-allowed
 *                     here just because it equals the relay-supplied value at its
 *                     root position (that value-global exemption is exactly the
 *                     neutralization hole); it is allowed here ONLY if pinned to
 *                     an independently-trusted value. Without a trusted pin a
 *                     relay-controlled admin/dso appearing here is FOREIGN (fail
 *                     closed) — a value-moving caller must plumb a trusted pin.
 */
/** One authenticated `Metadata.input_contracts` entry, grouped (see
 *  {@link DecodedPrepared.inputContracts}). */
export interface DecodedInputContract {
  contractId?: string;
  templateQualifiedName?: string;
  argument?: Uint8Array;
  signatories: string[];
  stakeholders: string[];
}

/** Party leaves tagged with the payload they came from, so an exception can be
 *  granted for a PROTOCOL ROLE at its protocol position without widening the
 *  allowlist globally. */
interface TaggedLeaves {
  templateQualifiedName: string | undefined;
  parties: string[];
}

interface SplitPartyLeaves {
  /** Root exercise chosen_value. The transfer record itself: no role exception
   *  is ever granted here. */
  rootArg: string[];
  /** Node-level party METADATA (signatories / stakeholders / acting_parties /
   *  choice_observers / contract-key maintainers) of every node, plus the same
   *  metadata on input contracts. These are authorization + visibility
   *  positions; ownership never lives here, it lives in arguments (which are
   *  tagged separately below). */
  elsewhere: string[];
  /** Every node VALUE payload other than the root chosen_value, tagged with the
   *  node's template when it is a Create. A Create argument is a MONEY-OWNER
   *  position, so this bucket is where an injected recipient would have to
   *  appear — it is gated far more tightly than `elsewhere`. */
  nodeValues: TaggedLeaves[];
  /** Authenticated input-contract ARGUMENTS, tagged by template. */
  inputArgs: TaggedLeaves[];
}

/**
 * Collect party leaves across the WHOLE signed message, split by position
 * relative to the validated root exercise (`rootNodeId`). Reuses the strong,
 * fail-closed `collectPartyLeaves` primitive on each Value payload, and adds the
 * node-level party-metadata strings + Metadata.input_contracts Create arguments
 * so a party introduced anywhere the agent's signature covers is visible.
 *
 * @param decoded
 * @param rootNodeId
 */
function collectSplitPartyLeaves(decoded: DecodedPrepared, rootNodeId: string): SplitPartyLeaves {
  const rootArg: string[] = [];
  const elsewhere: string[] = [];
  const nodeValues: TaggedLeaves[] = [];
  const inputArgs: TaggedLeaves[] = [];
  for (const node of decoded.nodes) {
    const isRoot = node.nodeId === rootNodeId;
    // A node's VALUE payloads carry ownership (a Create argument names the owner
    // of what it creates), so they are tagged with the node's template and kept
    // OUT of the loose `elsewhere` bucket. For the generic (no role exception)
    // case they are checked with exactly the same rule as `elsewhere`, so this
    // split is behaviour-preserving.
    const tag = node.create?.templateQualifiedName;
    const collectValue = (value: Uint8Array): void => {
      const parties: string[] = [];
      collectPartyLeaves(value, parties, 0);
      if (parties.length > 0) nodeValues.push({ templateQualifiedName: tag, parties });
    };
    if (isRoot && node.exercise !== undefined) {
      // The root exercise's chosen_value is the only place the admin/dso may sit
      // at its pinned position; its exercise_result (also in node.values) is a
      // consequence, so treat it as a tagged value payload.
      collectPartyLeaves(node.exercise.chosenValue, rootArg, 0);
      for (const value of node.values) {
        if (value !== node.exercise.chosenValue) collectValue(value);
      }
    } else {
      for (const value of node.values) collectValue(value);
    }
    // Node-level party metadata (authorization/visibility parties) — for ALL
    // nodes including the root — are never a place the relay may introduce an
    // unexpected party, so they go in `elsewhere`.
    for (const p of node.partyMeta) elsewhere.push(p);
  }
  // Authenticated input-contract ARGUMENTS, tagged by their template so a
  // protocol role can be recognised at the exact contract that explains it.
  for (const ic of decoded.inputContracts) {
    if (ic.argument === undefined) continue;
    const parties: string[] = [];
    collectPartyLeaves(ic.argument, parties, 0);
    if (parties.length > 0) {
      inputArgs.push({ templateQualifiedName: ic.templateQualifiedName, parties });
    }
  }
  // Metadata.input_contracts Create signatories/stakeholders/key (also SIGNED via
  // the V2 metadata hasher's disclosed-contract hashNode): authorization
  // metadata, same treatment as node metadata.
  for (const p of decoded.inputContractPartyMeta) elsewhere.push(p);
  return { rootArg, elsewhere, nodeValues, inputArgs };
}

/**
 * The foreign-party backstop, position-aware so a relay-supplied admin/dso can
 * never widen the recipient set across the whole transaction.
 *
 * @param leaves
 * @param allowed         - {sender, receiver, (delegate)} — recipients pinned to intent.
 * @param adminDso        - the admin/dso value read at its OWN root position (or undefined).
 * @param adminDsoRootMax - how many times `adminDso` may legitimately appear in the
 *                        root chosen_value (cip56: 2 = expectedAdmin + instrumentId.admin;
 *                        v1: 1 = expectedDso).
 * @param adminDsoTrusted - true iff `adminDso` was pinned to an independently-trusted
 *                        caller value — only then is it safe to value-exclude it
 *                        OUTSIDE its root position (consequence/meta/input nodes).
 * @param preapprovalProvider
 * @param trustedRegistryParties
 */
function assertNoForeignParties(
  leaves: SplitPartyLeaves,
  allowed: Set<string>,
  adminDso: string | undefined,
  adminDsoRootMax: number,
  adminDsoTrusted: boolean,
  /** The `provider` of the MATCHED standard TransferPreapproval, when one was
   *  proven to belong to this exact transfer (see matchPreapprovalProvider).
   *  undefined → no exception at all, and every bucket below behaves exactly as
   *  it did before this role existed. */
  preapprovalProvider?: string | undefined,
  /** OUT-OF-BAND-trusted registry infrastructure parties (see
   *  PreparedTransferExpectation.trustedRegistryParties). Admitted in the non-root
   *  buckets ONLY, exactly like a trusted admin — registry infra are signatories/
   *  observers, never money owners (the consequence-choice whitelist + pinned
   *  receiver keep that true). Empty → byte-identical to the Amulet behaviour. */
  trustedRegistryParties: ReadonlySet<string> = new Set(),
): void {
  const foreign: string[] = [];
  /** Templates at which the matched provider legitimately appears INSIDE a
   *  payload. Everything else, including any Amulet/holding create, stays
   *  foreign — that is the single loss barrier this exception rests on. */
  const providerArgTemplates = new Set([
    PREAPPROVAL_TEMPLATE, // its own provider field (declaration position 2)
    FEATURED_APP_RIGHT_TEMPLATE, // the provider's featured-app right, fetched
    FEATURED_APP_MARKER_TEMPLATE, // the reward marker naming it as beneficiary
  ]);
  const providerAllowedIn = (template: string | undefined): boolean =>
    preapprovalProvider !== undefined &&
    template !== undefined &&
    providerArgTemplates.has(template);
  // Root chosen_value: allow recipients freely; allow adminDso up to its known
  // count at its pinned position(s); a SECOND/extra occurrence (e.g. a smuggled
  // extra recipient leaf that happens to equal the admin/dso value) is foreign.
  let adminDsoBudget = adminDso !== undefined ? adminDsoRootMax : 0;
  for (const p of leaves.rootArg) {
    if (allowed.has(p)) continue;
    if (adminDso !== undefined && p === adminDso && adminDsoBudget > 0) {
      adminDsoBudget--;
      continue;
    }
    foreign.push(p);
  }
  // Everywhere else (consequence/sibling node Value payloads, ANY node's party
  // metadata, Metadata.input_contracts arguments): allow recipients freely; allow
  // adminDso ONLY when it is independently TRUSTED (caller-pinned to an out-of-band
  // value). A relay-chosen, UNPINNED admin/dso that reappears outside its root
  // position is treated as FOREIGN — this closes the "alias the unpinned
  // admin/dso to an attacker and inject that same value as a consequence /
  // node-metadata / input-contract party" neutralization (the relay controls the
  // unpinned value, so value-excluding it anywhere would whitelist the attacker
  // globally). The honest consequence legitimately carries the real DSO as a
  // payload party + signatory, so a value-moving caller MUST supply a trusted
  // expectedDso/instrumentAdmin (out-of-band; tx.ts plumbs it from
  // CANTON_AGENT_DSO_PARTY) — without it we fail closed here rather than trust a
  // relay-supplied value. The previous no-trusted-pin value-global fallback is
  // REMOVED: it was exactly the residual neutralization an adversary exploits.
  for (const p of leaves.elsewhere) {
    if (allowed.has(p)) continue;
    if (adminDso !== undefined && adminDsoTrusted && p === adminDso) continue;
    if (trustedRegistryParties.has(p)) continue;
    // AUTHORIZATION / VISIBILITY metadata only. The matched preapproval provider
    // is a signatory of its own contract and an authorizer of the delivery
    // exercise, so it necessarily appears here. Ownership is NOT expressible in
    // this bucket — it lives in the tagged argument buckets below — so granting
    // the role here cannot create a second money destination.
    if (preapprovalProvider !== undefined && p === preapprovalProvider) continue;
    foreign.push(p);
  }
  // VALUE payloads (consequence Create arguments + exercise results). Identical
  // rule to `elsewhere` for everyone EXCEPT the provider, which is admitted only
  // inside the reward marker that names it as beneficiary. Any other create —
  // above all `Splice.Amulet:Amulet` — keeps rejecting it, so the provider can
  // never become an owner of value.
  for (const bucket of leaves.nodeValues) {
    for (const p of bucket.parties) {
      if (allowed.has(p)) continue;
      if (adminDso !== undefined && adminDsoTrusted && p === adminDso) continue;
      if (trustedRegistryParties.has(p)) continue;
      if (
        preapprovalProvider !== undefined &&
        p === preapprovalProvider &&
        providerAllowedIn(bucket.templateQualifiedName)
      ) {
        continue;
      }
      foreign.push(p);
    }
  }
  // Authenticated input-contract ARGUMENTS. Same rule; the provider is admitted
  // only inside the preapproval it provides and its own featured-app right.
  for (const bucket of leaves.inputArgs) {
    for (const p of bucket.parties) {
      if (allowed.has(p)) continue;
      if (adminDso !== undefined && adminDsoTrusted && p === adminDso) continue;
      if (trustedRegistryParties.has(p)) continue;
      if (
        preapprovalProvider !== undefined &&
        p === preapprovalProvider &&
        providerAllowedIn(bucket.templateQualifiedName)
      ) {
        continue;
      }
      foreign.push(p);
    }
  }
  if (foreign.length > 0) {
    const uniq = [...new Set(foreign)];
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction references unexpected part${uniq.length === 1 ? "y" : "ies"} ` +
        `${uniq.map(f => JSON.stringify(f)).join(", ")} — refusing to sign ` +
        `(possible tampered/compromised relay redirecting funds)`,
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Standard validator-provided TransferPreapproval.
 *
 * A Splice `TransferPreapproval` is `signatory receiver, provider, dso`. The
 * merchant may create it through its OWN validator, in which case `provider` is
 * the validator operator party — a THIRD party, distinct from sender/receiver.
 * That is the stock shape (it keeps validator renewal automation and the
 * provider's featured-app attribution), so the payer wallet MUST be able to sign
 * such a transfer. Before this, the generic backstop read the provider as an
 * injected recipient and refused; only `provider == receiver` happened to pass.
 *
 * THE PROVIDER IS NEVER TRUSTED. It is read out of relay-supplied bytes, so it
 * is bound as a local PROTOCOL ROLE and only after proving, structurally, that
 * it is the provider of the exact preapproval this transfer delivers through:
 *
 *   1. exactly ONE authenticated input contract is a TransferPreapproval;
 *   2. its `receiver` equals the caller's intended receiver;
 *   3. its `dso` equals the transfer's instrument admin;
 *   4. its signatory set is exactly {receiver, provider, dso};
 *   5. a consequence exercises `TransferPreapproval_Send`/`_SendV2` on the
 *      TransferPreapproval template, targeting THAT contract id.
 *
 * The role then buys exactly one thing: the provider stops being "foreign" in
 * authorization metadata and inside the three payloads that structurally must
 * name it. It is still foreign in the root transfer record and in every
 * value-owning position, so it can never become a second money destination.
 *
 * Residual, accepted knowingly: a fabricated-but-self-consistent preapproval can
 * satisfy 1-5 locally, because contract EXISTENCE is proven downstream by the
 * ledger, not here. The outcome of that is a signed transaction the participant
 * refuses to execute — denial and retry, never payer-fund loss, because the
 * money-position rule holds regardless.
 * ──────────────────────────────────────────────────────────────────────── */

const PREAPPROVAL_TEMPLATE = "Splice.AmuletRules:TransferPreapproval";
const FEATURED_APP_RIGHT_TEMPLATE = "Splice.Amulet:FeaturedAppRight";
const FEATURED_APP_MARKER_TEMPLATE = "Splice.Amulet:FeaturedAppActivityMarker";
/** Delivery choices that consume a TransferPreapproval. `_Send` is the legacy
 *  name; the live TransferFactory path uses `_SendV2`. Both are already in
 *  TRANSFER_CONSEQUENCE_CHOICES, so this set only identifies the delivery node. */
const PREAPPROVAL_SEND_CHOICES = new Set([
  "TransferPreapproval_Send",
  "TransferPreapproval_SendV2",
]);

interface ExtractedTransferPreapproval {
  dso: string;
  receiver: string;
  provider: string;
}

/**
 * Read `TransferPreapproval` by DAML DECLARATION ORDER — [0] dso, [1] receiver,
 * [2] provider — with the same label/position-divergence guard the money fields
 * use, so a relay cannot relabel fields to move the provider slot. Order
 * CONFIRMED against a real MainNet input contract (see src/__fixtures__/).
 * Returns undefined when the record does not have that exact shape; the caller
 * then grants no role and the generic backstop refuses as before.
 *
 * @param argument
 */
function extractTransferPreapproval(
  argument: Uint8Array,
): ExtractedTransferPreapproval | undefined {
  let entries;
  try {
    entries = recordEntries(argument);
  } catch {
    return undefined;
  }
  const dsoE = entryByDeclOrder(entries, 0, "dso");
  const receiverE = entryByDeclOrder(entries, 1, "receiver");
  const providerE = entryByDeclOrder(entries, 2, "provider");
  if (!dsoE || !receiverE || !providerE) return undefined;
  const dso = leafOf(dsoE.value);
  const receiver = leafOf(receiverE.value);
  const provider = leafOf(providerE.value);
  if (dso?.kind !== "party" || receiver?.kind !== "party" || provider?.kind !== "party") {
    return undefined;
  }
  return { dso: dso.value, receiver: receiver.value, provider: provider.value };
}

/**
 * Prove that this transfer delivers through a standard TransferPreapproval and
 * return ITS provider, or undefined when nothing may be granted. See the block
 * comment above for the five binding rules and the threat argument.
 *
 * Deliberately returns undefined (no role, generic backstop applies) rather than
 * throwing: a transfer that never touches a preapproval, or an ambiguous set of
 * them, must keep the pre-existing behaviour exactly.
 *
 * @param decoded
 * @param expectedReceiver
 * @param instrumentAdmin
 */
function matchPreapprovalProvider(
  decoded: DecodedPrepared,
  expectedReceiver: string,
  instrumentAdmin: string,
): string | undefined {
  // 1. EXACTLY one authenticated preapproval input. Zero → nothing to grant.
  //    Two or more → ambiguous, and picking one would let a relay pair an honest
  //    preapproval with a decoy whose provider it controls. Refuse to grant.
  const candidates = decoded.inputContracts.filter(
    ic => ic.templateQualifiedName === PREAPPROVAL_TEMPLATE,
  );
  if (candidates.length !== 1) return undefined;
  const ic = candidates[0]!;
  if (ic.argument === undefined || ic.contractId === undefined) return undefined;

  const pre = extractTransferPreapproval(ic.argument);
  if (pre === undefined) return undefined;

  // 2 + 3. The preapproval must be FOR the payment we intend: our receiver, our
  //        instrument admin. A preapproval belonging to anyone else grants
  //        nothing, so a provider harvested from an unrelated contract is inert.
  if (pre.receiver !== expectedReceiver) return undefined;
  if (pre.dso !== instrumentAdmin) return undefined;

  // 4. Signatories must be exactly the protocol trio. A relay that appends an
  //    extra signatory is not presenting a stock preapproval.
  const sigs = new Set(ic.signatories);
  if (sigs.size !== 3) return undefined;
  for (const p of [pre.dso, pre.receiver, pre.provider]) {
    if (!sigs.has(p)) return undefined;
  }

  // The provider must never be aliased to a money party — that would smuggle a
  // money party into the role exception and exempt it everywhere.
  if (pre.provider === pre.receiver && pre.provider === pre.dso) return undefined;

  // 5. The delivery consequence must exercise the preapproval template on THAT
  //    contract id. This binds the role to the node that actually spends it,
  //    rather than to a contract merely present in the input set.
  const delivered = decoded.nodes.some(
    n =>
      n.exercise !== undefined &&
      PREAPPROVAL_SEND_CHOICES.has(n.exercise.choiceId) &&
      n.exercise.templateQualifiedName === PREAPPROVAL_TEMPLATE &&
      n.exercise.contractId === ic.contractId,
  );
  if (!delivered) return undefined;

  return pre.provider;
}

/**
 * Cross-check the authoritative submitter (Metadata.submitter_info.act_as):
 * REQUIRE a non-empty act_as whose only party is the sender. The non-empty
 * requirement closes GAP A3 (an empty act_as previously skipped this check
 * silently). Called by both arms AFTER the money-critical field comparison so a
 * consistent-attacker transaction surfaces as a field mismatch first.
 *
 * @param actAs
 * @param sender
 */
function assertActAsIsSender(actAs: string[], sender: string): void {
  if (actAs.length === 0) {
    throw new PreparedTransferMismatchError(
      "relay-prepared transaction has an empty act_as (authoritative submitter) — " +
        "refusing to sign (the submitter must be positively proven to be the agent)",
    );
  }
  const unexpected = actAs.filter(p => p !== sender);
  if (unexpected.length > 0 || !actAs.includes(sender)) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transaction acts as ${JSON.stringify(actAs)} — expected only ` +
        `${JSON.stringify(sender)} — refusing to sign`,
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Transfer extraction from the TransferFactory_Transfer choice argument.
 *
 * choiceArgument :: Record {
 *   expectedAdmin : Party,
 *   transfer      : Record {
 *     sender       : Party,
 *     receiver     : Party,
 *     amount       : Numeric,
 *     instrumentId : Record { admin : Party, id : Text },
 *     ...timestamps, inputHoldingCids, meta...
 *   },
 *   extraArgs : ...
 * }
 *
 * We locate the `transfer` sub-record STRICTLY at its Daml declaration position
 * (outer position 1, what the participant binds — labels are advisory), then read
 * sender/receiver/amount/instrumentId.id from it BY TYPE at their positions. We
 * do NOT search for a transfer-shaped record elsewhere: a shape-based fallback
 * let a relay type-diverge the real position-1 record and substitute a decoy.
 * ──────────────────────────────────────────────────────────────────────── */

interface ExtractedTransfer {
  sender: string;
  receiver: string;
  amount: string;
  instrumentAdmin: string;
  instrumentId: string;
  /** `transfer.inputHoldingCids` — the holdings this transfer spends, in wire
   *  order. Read for the scheme's input rule; empty when the field is absent. */
  inputHoldingCids: string[];
  /** `transfer.executeBefore` in epoch MILLISECONDS, when present. The wire
   *  value is a Daml `Time` (microseconds); it is reduced here so callers
   *  compare against a clock rather than re-deriving the unit. */
  executeBeforeMs: number | undefined;
  /** `transfer.meta.values["x402.memo"]`, when present. Undefined means the
   *  entry is absent — which is NOT the same as an empty memo, so callers that
   *  require a memo must distinguish them. */
  memo: string | undefined;
}

/**
 * Read a Daml `Time` leaf as epoch milliseconds. Returns undefined when the
 * field is not a timestamp — the caller then has no deadline and must refuse
 * rather than assume one.
 *
 * @param value
 */
function readTimestampMs(value: Uint8Array): number | undefined {
  const leaf = leafOf(value);
  if (!leaf || leaf.kind !== "timestamp") return undefined;
  const micros = BigInt(leaf.value);
  return Number(micros / 1000n);
}

/**
 * Read `transfer.inputHoldingCids` — a List of ContractId.
 *
 * Every element must actually BE a contract id: a list carrying anything else
 * is a shape the honest producer never emits, and silently skipping such an
 * element would undercount the inputs a caller is about to reason over.
 *
 * @param value
 */
function readInputHoldingCids(value: Uint8Array): string[] {
  assertSingleValueMember(value);
  const list = lenFieldUnique(decodeMessage(value), V_LIST, "Value.list");
  if (list === undefined) {
    throw new PreparedDecodeError("transfer.inputHoldingCids is not a list");
  }
  const out: string[] = [];
  for (const el of lenFields(decodeMessage(list), LIST_ELEMENTS)) {
    // Read Value.contract_id directly: `leafOf` deliberately reports only the
    // leaf kinds the party backstop cares about, and a contract id is not one
    // of them. assertSingleValueMember still refuses an element that sets more
    // than one Value member, so this cannot be pointed at a decoy.
    assertSingleValueMember(el);
    const cid = lenFieldUnique(decodeMessage(el), V_CONTRACT_ID, "Value.contract_id");
    if (cid === undefined) {
      throw new PreparedDecodeError("transfer.inputHoldingCids carries a non-contract-id element");
    }
    out.push(utf8(cid));
  }
  return out;
}

/**
 * Read `transfer.meta.values["x402.memo"]`.
 *
 * `meta` is a Metadata RECORD whose single declared field `values` is the
 * TextMap — not a TextMap directly. That shape was confirmed against the real
 * MainNet transfer, where the map is present and empty.
 *
 * A duplicate `x402.memo` key is refused rather than resolved: two entries mean
 * two answers to "what memo did the payer commit to", and any last-wins rule
 * would let a producer show one value to a reader and another to the engine.
 *
 * @param value
 */
function readMemo(value: Uint8Array): string | undefined {
  // `recordEntries` takes the VALUE and unwraps the record itself — passing it
  // an already-unwrapped Record double-unwraps and reads nothing.
  const entries = recordEntries(value);
  const valuesE = entryByDeclOrder(entries, 0, "values");
  if (!valuesE) return undefined;
  assertSingleValueMember(valuesE.value);
  const tm = lenFieldUnique(decodeMessage(valuesE.value), V_TEXT_MAP, "Value.text_map");
  if (tm === undefined) return undefined;

  let found: string | undefined;
  for (const entry of lenFields(decodeMessage(tm), TEXT_MAP_ENTRIES)) {
    const ef = decodeMessage(entry);
    const key = lenFieldUnique(ef, TM_KEY, "TextMap.Entry.key");
    if (key === undefined || utf8(key) !== X402_MEMO_KEY) continue;
    const v = lenFieldUnique(ef, TM_VALUE, "TextMap.Entry.value");
    const leaf = v !== undefined ? leafOf(v) : undefined;
    if (!leaf || leaf.kind !== "text") {
      throw new PreparedDecodeError("transfer.meta x402.memo is not text");
    }
    if (found !== undefined) {
      throw new PreparedDecodeError("transfer.meta carries x402.memo twice — refusing to pick one");
    }
    found = leaf.value;
  }
  return found;
}

/**
 * Read a money-critical record field BY ITS DAML DECLARATION-ORDER POSITION,
 * cross-checking labels — the fix for the label-vs-positional binding divergence
 * (amount inflation / receiver swap via relabeled/reordered fields).
 *
 * WHY POSITIONAL: a Daml-LF record is POSITIONAL. The participant binds the
 * choice argument by the choice type's field ORDER; the wire `RecordField.label`
 * is advisory. A reader that prefers LABELS can be made to diverge from the
 * engine: a malicious relay places the honest value at a field LABELED "amount"
 * but at a wire position the engine does NOT read as amount, and an INFLATED
 * Numeric at the wire position the engine binds as amount (under a junk label) —
 * a by-label read sees the honest decoy and passes while the engine moves the
 * inflated amount. We therefore read the field at its declaration-order
 * `position` (what the engine reads) and additionally FAIL CLOSED on any
 * label/position inconsistency:
 * (a) the entry AT `position`, if labelled, must carry exactly `label`; and
 * (b) NO OTHER entry may carry `label` (a decoy field re-using a money-critical
 * label at the wrong position).
 * Honest encodings — fully labelled in declaration order, OR label-free
 * (normalized) — both pass; only a label/position-divergent record is rejected.
 * `expectedAt` lets the caller reject a field that the engine would bind at a
 * position the record does not even have (arity check for that field).
 *
 * @param entries
 * @param position
 * @param label
 */
function entryByDeclOrder(
  entries: RecordEntry[],
  position: number,
  label: string,
): RecordEntry | undefined {
  // (b) a money-critical label may appear at most once, and only at its own
  // declaration-order position. A decoy field re-using the label elsewhere is a
  // divergence attempt — fail closed.
  for (let i = 0; i < entries.length; i++) {
    if (i !== position && entries[i]?.label === label) {
      throw new PreparedDecodeError(
        `record field labelled ${JSON.stringify(label)} appears at position ${i} but the Daml ` +
          `declaration order binds it at position ${position} — refusing to sign ` +
          `(label/position divergence, possible amount/receiver tamper)`,
      );
    }
  }
  const e = entries[position];
  if (e === undefined) return undefined;
  // (a) the entry the engine binds at `position`, if labelled, must be THIS field.
  if (e.label !== "" && e.label !== label) {
    throw new PreparedDecodeError(
      `record field at Daml declaration position ${position} is labelled ${JSON.stringify(e.label)} ` +
        `but ${JSON.stringify(label)} is expected there — refusing to sign ` +
        `(label/position divergence, possible amount/receiver tamper)`,
    );
  }
  return e;
}

/** Read instrumentId {admin, id} from a record entry that is itself a record.
 *  Declaration order: [0] admin:Party [1] id:Text. Read positionally with the
 *
 * @param value
 *  - same label/position-divergence guard as the transfer fields. */
function readInstrument(value: Uint8Array): { admin: string; id: string } {
  const entries = recordEntries(value);
  const adminE = entryByDeclOrder(entries, 0, "admin");
  const idE = entryByDeclOrder(entries, 1, "id");
  const adminLeaf = adminE ? leafOf(adminE.value) : undefined;
  const idLeaf = idE ? leafOf(idE.value) : undefined;
  if (!adminLeaf || adminLeaf.kind !== "party") {
    throw new PreparedDecodeError("instrumentId.admin is not a party");
  }
  if (!idLeaf || idLeaf.kind !== "text") {
    throw new PreparedDecodeError("instrumentId.id is not text");
  }
  return { admin: adminLeaf.value, id: idLeaf.value };
}

/**
 * Extract the transfer body (sender/receiver/amount/instrument) from a
 * TransferFactory_Transfer choice argument, BY TYPE at its structural position.
 *
 * @param chosenValue
 */
export function extractTransfer(chosenValue: Uint8Array): ExtractedTransfer {
  const top = recordEntries(chosenValue);
  // Locate the `transfer` sub-record STRICTLY at its Daml declaration position.
  // The outer choiceArgument is
  //   [0]expectedAdmin:Party [1]transfer:Record [2]extraArgs:Record
  // so the participant binds `transfer` at declaration position 1, REGARDLESS of
  // labels (a Daml-LF record is positional; the wire `RecordField.label` is
  // advisory). We therefore read position 1 and ONLY position 1, with the same
  // label/position-divergence guard the money fields use.
  //
  // We deliberately do NOT fall back to a shape-based search ("find the first
  // record that looks like a transfer"): that override was a NON-positional read
  // that a malicious relay could weaponize. By type-diverging ONE field of the
  // engine's real position-1 transfer record (e.g. sender as Optional(Party) or
  // receiver as List(Party)) the relay made it fail the shape heuristic, so the
  // search returned a relay-planted, well-typed DECOY transfer record at a
  // DIFFERENT outer position carrying the honest amount — while the engine bound
  // the inflated amount from position 1. The verifier compared the decoy and
  // passed. Reading position 1 directly closes that divergence: the entry the
  // engine binds as `transfer` is the entry we validate, and a type-malformed
  // transfer record is itself a tamper signal — it fails the per-field type
  // checks below and we refuse to sign rather than search elsewhere.
  const transferVal = entryByDeclOrder(top, 1, "transfer")?.value;
  if (!transferVal)
    throw new PreparedDecodeError("could not locate transfer record in choice argument");

  const t = recordEntries(transferVal);

  // Read each money-critical field at its DAML DECLARATION-ORDER POSITION (what
  // the participant binds), NOT by label — and fail closed on any label/position
  // divergence (the amount-inflation / receiver-swap vector). Declaration order:
  //   [0] sender:Party [1] receiver:Party [2] amount:Numeric [3] instrumentId:Record
  // (trailing requestedAt/executeBefore/inputHoldingCids/meta are not money-
  // critical here; party leaves in them are still covered by the backstop).
  //
  // MEMO (merchant memo enforcement): the relay stamps the merchant-required memo
  // into transfer.meta as `x402.memo` — a TextMap *string* value. It is
  // deliberately NOT pinned by verify-before-sign: extractTransfer reads only
  // positions 0–3, and the foreign-party backstop (collectPartyLeaves →
  // assertNoForeignParties) scans PARTY leaves only, so a text memo value is
  // tolerated and does not alter the transaction STRUCTURE (the meta TextMap is
  // always present — empty today — so this only adds an entry inside it). This is
  // safe by design: the memo is not money-critical, so a relay that alters or
  // drops it can at worst make the MERCHANT's server-side /verify reject the
  // payment (invalid_exact_canton_memo_mismatch) — it can never redirect funds.
  // Pinning it here would only trade that harmless reject for a client-side
  // refuse-to-sign, so we leave the fail-closed money scanner unchanged.
  const senderE = entryByDeclOrder(t, 0, "sender");
  const receiverE = entryByDeclOrder(t, 1, "receiver");
  const amountE = entryByDeclOrder(t, 2, "amount");
  const instrE = entryByDeclOrder(t, 3, "instrumentId");

  const sender = senderE ? leafOf(senderE.value) : undefined;
  const receiver = receiverE ? leafOf(receiverE.value) : undefined;
  const amount = amountE ? leafOf(amountE.value) : undefined;
  const instrumentVal = instrE?.value;

  if (!sender || sender.kind !== "party")
    throw new PreparedDecodeError("transfer.sender is not a party");
  if (!receiver || receiver.kind !== "party")
    throw new PreparedDecodeError("transfer.receiver is not a party");
  if (!amount || amount.kind !== "numeric")
    throw new PreparedDecodeError("transfer.amount is not numeric");
  if (!instrumentVal) throw new PreparedDecodeError("transfer.instrumentId missing");
  const instrument = readInstrument(instrumentVal);

  // Positions 6 and 7 are NOT money-critical in the sign-side sense, but the
  // facilitator must read them: the merchant's memo requirement and the
  // transfer's declared inputs are both promises the payer is making. Absent
  // fields stay absent rather than becoming defaults.
  // Only look these up when the record actually declares that many fields.
  // entryByDeclOrder enforces label/position agreement, and asking about a
  // position a shorter record does not have turns a legitimate shape into a
  // divergence error. Fail-closed is preserved on the facilitator path
  // regardless: a record without inputs trips requireInputHoldings, and a
  // missing memo cannot equal a required one.
  const execE = t.length > 5 ? entryByDeclOrder(t, 5, "executeBefore") : undefined;
  const inputsE = t.length > 6 ? entryByDeclOrder(t, 6, "inputHoldingCids") : undefined;
  const metaE = t.length > 7 ? entryByDeclOrder(t, 7, "meta") : undefined;

  return {
    sender: sender.value,
    receiver: receiver.value,
    amount: amount.value,
    instrumentAdmin: instrument.admin,
    instrumentId: instrument.id,
    executeBeforeMs: execE ? readTimestampMs(execE.value) : undefined,
    inputHoldingCids: inputsE ? readInputHoldingCids(inputsE.value) : [],
    memo: metaE ? readMemo(metaE.value) : undefined,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Public API.
 * ──────────────────────────────────────────────────────────────────────── */

export interface PreparedTransferExpectation {
  /** The agent's own party — must be the transfer sender (caller intent). */
  sender: string;
  /** The intended recipient (merchant payTo / withdraw target) — caller intent. */
  receiver: string;
  /** The EXACT amount string the agent asked to transfer — caller intent. */
  amount: string;
  /**
   * The instrument id the agent expects (e.g. "Amulet"). Caller intent — the
   * agent chooses what asset to pay in. The instrument ADMIN (DSO party) is
   * resolved by the relay and is deliberately NOT used as a trust anchor: we
   * never whitelist a relay-supplied party. Pass it only if you have an
   * independently-trusted value to additionally pin.
   */
  instrumentId: string;
  /** Optional, independently-trusted instrument admin (the DSO party) to pin. When
   *  supplied it is pinned by exact equality AND becomes the ONLY admin/dso value
   *  the foreign-party backstop excludes outside its root position — closing the
   *  "alias the unpinned admin to the attacker and inject it as a consequence
   *  recipient" neutralization. Pass it whenever you have an out-of-band DSO. */
  instrumentAdmin?: string;
  /** Facilitator-side: require the transfer to declare at least one input
   *  holding (scheme Rule 13). Off by default so the client's verify-before-sign
   *  contract is unchanged. Duplicate inputs are refused for every caller
   *  regardless. */
  requireInputHoldings?: boolean;
  /** Optional, caller-intent memo. When supplied, the transfer's
   *  `meta.values["x402.memo"]` MUST equal it exactly; absent counts as a
   *  mismatch. Leave undefined when the merchant requires no memo. */
  memo?: string;
  /** Optional, caller-intent synchronizer id (the merchant-advertised domain).
   *  When supplied, the SIGNED Metadata.synchronizer_id is pinned to it (fail-
   *  closed if absent/different) so a relay cannot land the agent's signature on a
   *  domain of its choosing. */
  synchronizerId?: string;
  /** Optional, caller-intent template `module:entity` qualified name of the
   *  TransferFactory the choice runs against (e.g. the token-standard transfer
   *  factory). When supplied, the exercise's template_id is pinned, closing the
   *  template/contract-confusion surface. */
  templateQualifiedName?: string;
  /** Optional, caller-intent contract id of the factory the exercise targets.
   *  When supplied, Exercise.contract_id is pinned by exact equality (fail-closed
   *  on divergence) — defense-in-depth closing the resolve→prepare TOCTOU. No-op
   *  when omitted (the all-nodes party backstop still contains any redirect). */
  expectedContractId?: string;
  /** Optional, OUT-OF-BAND-trusted registry infrastructure parties for a non-Amulet
   *  CIP-56 registry token (e.g. the DA Registry Utility operator and, for USDCx,
   *  the xReserve Bridge-Operator). A real registry `TransferFactory_Transfer`
   *  names these as signatories/observers of the holding + rule + preapproval
   *  contracts, so without admitting them the foreign-party backstop rejects an
   *  honest transfer. They are admitted EXACTLY like a trusted `instrumentAdmin`
   *  (in the non-root buckets — authorization metadata, consequence Value payloads,
   *  input-contract args), NEVER as extra root-arg recipients, and the money
   *  barrier is unchanged: sender/receiver/amount/instrument stay pinned, there is
   *  one transfer root, and the consequence-choice whitelist bounds what may run —
   *  so a trusted party can never become a second money destination.
   *
   *  MUST be sourced out-of-band (registrar id + the registry's `/operator`
   *  endpoint + operator config), NEVER from the relay/402. Undefined/empty →
   *  byte-identical to the pre-existing Amulet behaviour. */
  trustedRegistryParties?: ReadonlySet<string>;
  /** Inject Date.now() for testability of the timing sanity checks. */
  nowMs?: number;
}

/**
 *
 */
export class PreparedDecodeError extends Error {
  /**
   *
   * @param message
   */
  constructor(message: string) {
    super(`preparedTransaction: ${message}`);
    this.name = "PreparedDecodeError";
  }
}

/**
 *
 */
export class PreparedTransferMismatchError extends Error {
  /**
   *
   * @param message
   */
  constructor(message: string) {
    super(message);
    this.name = "PreparedTransferMismatchError";
  }
}

/**
 * Assert the relay-returned `preparedTransaction` encodes EXACTLY the transfer
 * the agent intended. Throws `PreparedTransferMismatchError` on any mismatch
 * and `PreparedDecodeError` if the bytes are not a decodable PreparedTransaction
 * carrying a single transfer exercise. Call this BEFORE signing `hash`.
 *
 * Fail-closed: anything we cannot positively prove matches the intent throws.
 */
/** Choices the honest `TransferFactory_Transfer` consequence subtree carries —
 *  verified against the live participant's prepared transfer: `Archive` of the
 *  consumed input Amulet(s), and — when the RECEIVER holds a TransferPreapproval
 *  — `TransferPreapproval_Send`/`_SendV2` which delivers the amulet to the
 *  receiver instead of locking it in a TransferInstruction. Permitted ONLY as
 *  reachable consequences of the single Transfer root (never as a second root /
 *  orphan). sender/receiver/amount/admin stay pinned by extractTransfer and the
 *  all-nodes foreign-party backstop still runs, so an injected redirect is still
 *  refused. */
/** `EventLog_HoldingsChange` — introduced by splice-amulet 0.1.21, which Canton
 *  MainNet adopted 2026-07-28. It is exercised UNCONDITIONALLY on every amulet
 *  transfer on the external-party path, so leaving it out rejects every payment
 *  (the outage of 2026-08-01/02).
 *
 *  It is declared on the INTERFACE `EventLog`
 *  (splice-api-token-transfer-events-v2), whose body is virtual: the implementing
 *  package decides what runs. Allowlisting the bare NAME would therefore let any
 *  package that implements the same interface run arbitrary code — including
 *  consuming effects on children, which surface as the already-allowed `Archive`.
 *  So we pin the templates whose implementation we have actually inspected: both
 *  route to `eventLog_holdingsChangeDefaultImpl dso`, which only asserts
 *  `admin == dso` and returns an empty record — no create, archive, lock or burn.
 *
 *  Templates measured on a real MainNet prepared accept (26,668 bytes, captured
 *  2026-08-02 via e2e/capture-accept-bytes.mjs): ExternalPartyConfigState twice
 *  as a DIRECT child of the root, AmuletEventLog once as a GRANDCHILD under
 *  LockedAmulet_UnlockV2. Depth therefore varies — never pin it. The node's own
 *  `amount`/`otherside` fields are NOT validated by the choice body, so amount,
 *  receiver and instrument stay pinned exclusively from the root's chosen value,
 *  and the foreign-party backstop still scans this node's leaves. */
const EVENT_LOG_HOLDINGS_CHANGE = {
  choiceId: "EventLog_HoldingsChange",
  templates: [
    "Splice.ExternalPartyConfigState:ExternalPartyConfigState",
    "Splice.AmuletEventLog:AmuletEventLog",
  ],
} as const;

/** DA Registry Utility direct-transfer consequence. A non-Amulet CIP-56 token
 *  whose registrar runs the DA Registry Utility (USDCx and the whole registry
 *  family — cBTC, cETH, …) settles a `direct` transfer by exercising
 *  `TransferRule_DirectTransfer` on the registry's `TransferRule` template as a
 *  consequence of the root `TransferFactory_Transfer` (the registry analogue of
 *  Amulet's `TransferPreapproval_Send`: it delivers the holding to the receiver
 *  in one update instead of leaving a Pending `TransferInstruction`). Pinned to
 *  the TEMPLATE (not a bare name) so only the registrar's audited rule code is
 *  admitted — measured on a real MainNet USDCx prepared transfer (decodePrepared:
 *  root `TransferFactory_Transfer`, consequences `TransferRule_DirectTransfer` +
 *  `Archive` of the spent `Utility.Registry.Holding.V0.Holding:Holding`). Generic
 *  across every DA-registry token because they all share the `Utility.Registry.*`
 *  packages; byte-identical for Amulet, whose tree never carries this choice. */
const REGISTRY_UTILITY_DIRECT_TRANSFER = {
  choiceId: "TransferRule_DirectTransfer",
  templates: ["Utility.Registry.V0.Rule.Transfer:TransferRule"],
} as const;

/** DA Registry Utility SELF-transfer consequence (`merge`). A registry transfer
 *  whose receiver is the sender (`transferKind: "self"`) settles by exercising
 *  `AllocationFactory_TransferInternal` on the registrar's `AllocationFactory`
 *  as a consequence of the root `TransferFactory_Transfer`, archiving the input
 *  holdings and creating the owner's new `Holding`(s) — measured on two real
 *  MainNet USDCx prepared self-transfers (2 inputs → full amount → ONE holding;
 *  2 inputs → 1 atomic → two). The SAME choice is the delivery node of the
 *  registry's two-step (no-preapproval) shape, whose tree additionally creates
 *  a pending `TransferOffer` — which is why it is NOT in the general whitelist:
 *  it is consulted only when the caller's intent is a self-transfer
 *  (`expect.sender === expect.receiver`, proven against the bytes further down)
 *  and, once it fires, every `create` in the tree must be the registry `Holding`
 *  template (REGISTRY_HOLDING_TEMPLATE). A foreign receiver never reaches the
 *  rule; a self receiver with an offer create fails the create pin. */
const REGISTRY_UTILITY_SELF_TRANSFER = {
  choiceId: "AllocationFactory_TransferInternal",
  templates: ["Utility.Registry.App.V0.Service.AllocationFactory:AllocationFactory"],
} as const;
const REGISTRY_HOLDING_TEMPLATE = "Utility.Registry.Holding.V0.Holding:Holding";

const TRANSFER_CONSEQUENCE_CHOICES = [
  "Archive",
  "TransferPreapproval_Send",
  "TransferPreapproval_SendV2",
  EVENT_LOG_HOLDINGS_CHANGE,
  REGISTRY_UTILITY_DIRECT_TRANSFER,
] as const;
const SELF_TRANSFER_CONSEQUENCE_CHOICES = [
  ...TRANSFER_CONSEQUENCE_CHOICES,
  REGISTRY_UTILITY_SELF_TRANSFER,
] as const;

/**
 * Canonicalize a CC amount decimal string to a fixed 10-fractional-digit form
 * for VALUE-equality comparison. Canton encodes amounts at 10 decimals
 * ("0.0200000000"); a caller (e.g. `withdraw --amount 0.02`) may pass a short
 * form, so comparing the raw strings would spuriously fail verify-before-sign
 * even though the numeric value is identical. Pure string math (no float) so
 * large amounts keep full precision. A non-numeric input is returned as-is, so
 * it still mismatches (fail-closed).
 *
 * UNIT-BY-SCHEME invariant: BOTH sides of every amount compare here are
 * on-ledger Daml **Decimals** — `t.amount` is decoded from the prepared tx's
 * `Value.numeric` (always a ledger Decimal) and `expect.amount` is the caller's
 * INTENDED ledger Decimal (the relay/agent path sources `opts.amount` as the
 * Decimal, never the x402 wire atomic value). `canonicalAmount` therefore only
 * pads Decimals; it must NEVER be fed an atomic integer (an atomic "1" would
 * canonicalize to "1.0000000000" and silently mis-compare against the ledger
 * "0.0000000001"). If a future caller ever sources `expect.amount` from an
 * atomic-scheme wire, it MUST first convert via
 * `wireAmountToLedgerDecimal(scheme, amount)` from ./amount.
 *
 * @param raw
 */
export function canonicalAmount(raw: string): string {
  const m = String(raw)
    .trim()
    .match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return raw;
  const frac = m[2] ?? "";
  // Pad SHORT fractions up to 10 ("0.02" -> "0.0200000000"). NEVER truncate a
  // longer fraction — that would hide extra precision (e.g. "1.00000000001"),
  // letting a relay inflate the amount past the 10-decimal canon undetected. A
  // >10-digit fraction is kept verbatim so it still mismatches the canonical
  // intent (fail-closed). Value-equality only for the legit short-form case.
  return `${m[1]}.${frac.length < 10 ? frac.padEnd(10, "0") : frac}`;
}

/**
 *
 * @param preparedTransactionB64
 * @param expect
 */
export function assertPreparedTransferMatches(
  preparedTransactionB64: string,
  expect: PreparedTransferExpectation,
): void {
  const decoded = decodePrepared(preparedTransactionB64);

  // Node-traversal invariant (shared with the v1 arm): exactly one allowed ROOT
  // exercise & no other root; EVERY node recognized (no node hidden under an
  // unknown version/type); EXACTLY ONE root that IS the single allowed
  // TransferFactory_Transfer exercise; no orphan/extra-leg node. The honest
  // settlement consequences (Archive of the input + preapproval delivery) are
  // whitelisted as CONSEQUENCES only. Returns the validated root exercise + its
  // node id (for the position-aware backstop).
  const selfIntent = expect.sender === expect.receiver;
  const { exercise: ex, rootNodeId } = assertSingleAllowedRootExercise(
    decoded,
    TRANSFER_CHOICE,
    "transfer",
    selfIntent ? SELF_TRANSFER_CONSEQUENCE_CHOICES : TRANSFER_CONSEQUENCE_CHOICES,
  );
  const t = extractTransfer(ex.chosenValue);

  // Registry self-transfer create pin (see REGISTRY_UTILITY_SELF_TRANSFER): the
  // admitted internal-transfer node may only create the owner's Holdings. Any
  // other create under it is the two-step shape (a pending TransferOffer) or a
  // shape never measured — refuse. An undecodable create template fails too.
  if (decoded.exercises.some(e => e.choiceId === REGISTRY_UTILITY_SELF_TRANSFER.choiceId)) {
    for (const node of decoded.nodes) {
      if (node.create === undefined) continue;
      const tmpl = node.create.templateQualifiedName;
      if (tmpl !== REGISTRY_HOLDING_TEMPLATE) {
        throw new PreparedTransferMismatchError(
          `registry self-transfer creates ${JSON.stringify(tmpl)} — refusing to sign ` +
            `(a self-transfer may only create the owner's ${REGISTRY_HOLDING_TEMPLATE}; ` +
            `any other create is a pending-instruction shape)`,
        );
      }
    }
  }

  // Scheme Rule 13, the half provable from the bytes alone: the declared input
  // holdings must exist and be DISTINCT. A repeated contract id would let a
  // transfer claim to fund itself twice from one holding — the sum looks
  // sufficient while only one holding actually exists. The other half of the
  // rule (that they sum to the amount plus fees) needs each holding's value,
  // which is NOT in the prepared transaction; it requires a ledger read and is
  // therefore the caller's, not this decoder's.
  // Emptiness is OPT-IN. Distinctness below is not: a duplicate is wrong for
  // every caller. But "must declare inputs" is the FACILITATOR's rule — the
  // client-side verify-before-sign path validates transfers it is about to
  // sign, including shapes where the field is absent, and making this
  // unconditional silently changed the contract of a published package.
  if (expect.requireInputHoldings === true && t.inputHoldingCids.length === 0) {
    throw new PreparedTransferMismatchError(
      "transfer declares no input holdings — nothing would fund it",
    );
  }
  if (new Set(t.inputHoldingCids).size !== t.inputHoldingCids.length) {
    throw new PreparedTransferMismatchError(
      "transfer declares the same input holding more than once — refusing " +
        "(one holding cannot fund a transfer twice)",
    );
  }

  // Scheme Rule 12: when the caller requires a memo, the transfer must carry
  // exactly it under `x402.memo`. Fail-closed on absent as well as different —
  // a transfer with no memo does not satisfy a merchant that demanded one.
  if (expect.memo !== undefined && t.memo !== expect.memo) {
    throw new PreparedTransferMismatchError(
      `transfer memo ${JSON.stringify(t.memo)} does not match the required ` +
        `${JSON.stringify(expect.memo)}`,
    );
  }

  const mismatches: string[] = [];
  if (t.sender !== expect.sender) {
    mismatches.push(
      `sender (got ${JSON.stringify(t.sender)}, intended ${JSON.stringify(expect.sender)})`,
    );
  }
  if (t.receiver !== expect.receiver) {
    mismatches.push(
      `receiver (got ${JSON.stringify(t.receiver)}, intended ${JSON.stringify(expect.receiver)})`,
    );
  }
  if (canonicalAmount(t.amount) !== canonicalAmount(expect.amount)) {
    mismatches.push(
      `amount (got ${JSON.stringify(t.amount)}, intended ${JSON.stringify(expect.amount)})`,
    );
  }
  if (t.instrumentId !== expect.instrumentId) {
    mismatches.push(
      `instrumentId.id (got ${JSON.stringify(t.instrumentId)}, intended ${JSON.stringify(expect.instrumentId)})`,
    );
  }
  // Only pin the admin if the caller supplied an independently-trusted value.
  if (expect.instrumentAdmin !== undefined && t.instrumentAdmin !== expect.instrumentAdmin) {
    mismatches.push(
      `instrumentId.admin (got ${JSON.stringify(t.instrumentAdmin)}, intended ${JSON.stringify(expect.instrumentAdmin)})`,
    );
  }
  if (mismatches.length > 0) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transfer does not match intent: ${mismatches.join("; ")} — ` +
        `refusing to sign (possible tampered/compromised relay redirecting funds)`,
    );
  }

  // The admin/dso must never be aliased to a money role — otherwise a relay could
  // set the (unpinned) admin to the receiver/sender and have the backstop exempt
  // a money party. Reject up front.
  if (t.instrumentAdmin === expect.sender || t.instrumentAdmin === expect.receiver) {
    throw new PreparedTransferMismatchError(
      `relay-prepared transfer instrumentId.admin ${JSON.stringify(t.instrumentAdmin)} equals a ` +
        `transfer party (sender/receiver) — refusing to sign`,
    );
  }

  // Pin WHICH template + WHICH contract the choice runs against
  // (template/contract-confusion + resolve→prepare TOCTOU) and the SIGNED
  // synchronizer + timing metadata (relay-chosen domain / validity window). All
  // no-ops unless the caller supplies the corresponding intent.
  assertTemplateMatches(ex, expect.templateQualifiedName);
  assertContractIdMatches(ex, expect.expectedContractId);
  assertSynchronizerMatches(decoded.synchronizerId, expect.synchronizerId);
  assertTimingPlausible(decoded, expect.nowMs ?? Date.now());

  // Cross-check the authoritative submitter: REQUIRE a non-empty act_as whose
  // only party is the sender (closes GAP A3 — an empty act_as no longer skips
  // this). Placed after the field comparison so a consistent-attacker tx
  // surfaces as a field mismatch first.
  assertActAsIsSender(decoded.actAs, expect.sender);

  // Position-aware foreign-party backstop over the WHOLE signed message (all node
  // Value payloads + node-level party metadata + Metadata.input_contracts): no
  // party other than {sender, receiver} may appear, EXCEPT the instrument admin
  // (DSO) at its known root positions (expectedAdmin + instrumentId.admin = 2).
  // The admin is value-excluded OUTSIDE its root position ONLY when pinned to an
  // independently-trusted value (expect.instrumentAdmin) — so a relay-chosen,
  // unpinned admin can no longer be aliased to the attacker and smuggled in as a
  // consequence/metadata recipient.
  const leaves = collectSplitPartyLeaves(decoded, rootNodeId);
  // Standard validator-provided preapprovals put a THIRD party (the provider)
  // into authorization metadata and three specific payloads. Prove it is the
  // provider of the exact preapproval this transfer delivers through, then admit
  // it ONLY at those positions. undefined → no exception, byte-identical to the
  // pre-existing behaviour (self-provider merchants take this path unchanged,
  // because there the provider IS the receiver and was never foreign).
  const preapprovalProvider = matchPreapprovalProvider(decoded, expect.receiver, t.instrumentAdmin);
  assertNoForeignParties(
    leaves,
    new Set([expect.sender, expect.receiver]),
    t.instrumentAdmin,
    2 /* expectedAdmin + instrumentId.admin */,
    expect.instrumentAdmin !== undefined /* trusted iff caller pinned it */,
    preapprovalProvider,
    expect.trustedRegistryParties ?? new Set(),
  );
}
