/**
 * TEST-ONLY fixture: a faithful Canton `PreparedTransaction` protobuf encoder.
 *
 * NOT shipped — excluded from the package build/typecheck via tsconfig `exclude`
 * (it is imported only by `*.test.ts` files, which vitest resolves directly).
 *
 * Field numbers MATCH the real com.daml.ledger.api.v2 Ledger API protos so the
 * structural verifier in `verify-prepared.ts` is exercised against the SAME wire
 * layout a real participant emits:
 *
 *   PreparedTransaction.transaction = 1, .metadata = 2
 *   Metadata.submitter_info = 2 ; SubmitterInfo.act_as = 1, .command_id = 2
 *   DamlTransaction.version = 1, .nodes = 3
 *   DamlTransaction.Node.node_id = 1, .v1 = 1000
 *   transaction.v1.Node.exercise = 3
 *   Exercise.lf_version = 1, .contract_id = 2, .choice_id = 9, .chosen_value = 10
 *   Value.numeric = 6, .party = 7, .text = 8, .record = 14, .list = 11
 *   Record.fields = 2 ; RecordField.label = 1, .value = 2
 */

export function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
export function tag(field: number, wire: number): Buffer {
  return varint(field * 8 + wire);
}
/** length-delimited field (string / bytes / submessage). */
export function len(field: number, body: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}
export function str(field: number, s: string): Buffer {
  return len(field, Buffer.from(s, "utf-8"));
}
export function vintField(field: number, n: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(n)]);
}
/** fixed64 (wire type 1) field: 8 little-endian bytes. Daml `Value.timestamp`
 *  (`Time`, µs since epoch) is serialized as a protobuf SFIXED64 — NOT a varint —
 *  so the fixture MUST emit it this way to match the real participant wire (a
 *  live TestNet prepared `TransferFactory_Transfer` emits the transfer's
 *  executeBefore deadline as `field 5, wire 1`, 9 bytes total). A varint-encoded
 *  fixture here would falsely pass while the real fixed64 wire failed — the same
 *  fixture-vs-reality trap as the zigzag-nonce / Optional-DSO bugs. */
export function fixed64Field(field: number, n: number): Buffer {
  const out = Buffer.alloc(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return Buffer.concat([tag(field, 1), out]);
}

// ── Daml Value builders ──
export function vParty(p: string): Buffer {
  return str(7, p);
}
export function vNumeric(n: string): Buffer {
  return str(6, n);
}
export function vText(t: string): Buffer {
  return str(8, t);
}
/** Value.int64 (oneof tag 3) — Daml `Int`, e.g. TransferCommand.nonce. Daml-LF
 *  serializes int64 as protobuf SINT64, so the wire varint is ZIGZAG-encoded:
 *  zigzag(n) = n>=0 ? 2n : -2n-1 (0→0, 1→2, -1→1, 2→4). This matches what the
 *  participant emits and what zigzagDecodeInt64 reads — a plain-varint fixture
 *  hid the "nonce >= 1 decodes as 2n" bug. */
export function vInt64(n: number): Buffer {
  const zz = n >= 0 ? n * 2 : -n * 2 - 1;
  return vintField(3 /* Value.int64 */, zz);
}
/** Value.timestamp (oneof tag 5) — Daml `Time`, µs since epoch. Serialized as a
 *  protobuf SFIXED64 (wire type 1, 8 little-endian bytes), MATCHING the real
 *  participant wire — NOT a varint. (Verified byte-identical to the canonical
 *  Canton interactive `Value` codec and a live TestNet prepared tx.) */
export function vTimestamp(microsSinceEpoch: number): Buffer {
  return fixed64Field(5 /* Value.timestamp */, microsSinceEpoch);
}
/** ATTACK builder: a single Daml `Value` carrying `Value.timestamp` (tag 5)
 *  TWICE — decoy first, real second — both as fixed64. A first-wins reader sees
 *  `decoy`; a spec-conformant last-wins parser sees `real`. Exercises the
 *  deadline-via-duplicate-fixed64-oneof bypass for the transfer's executeBefore. */
export function vDualTimestamp(decoyMicros: number, realMicros: number): Buffer {
  return Buffer.concat([vTimestamp(decoyMicros), vTimestamp(realMicros)]);
}
/**
 * ATTACK builder: a single Daml `Value` carrying `Value.int64` (oneof tag 3)
 * TWICE — `decoy` first, `real` second. A first-wins reader sees `decoy`; a
 * spec-conformant last-wins parser sees `real`. Exercises the
 * nonce-via-duplicate-varint-oneof bypass for the v1 path.
 */
export function vDualInt64(decoy: number, real: number): Buffer {
  return Buffer.concat([vInt64(decoy), vInt64(real)]);
}
/** Value.record from labelled fields. `label` may be "" to omit (normalized). */
export function vRecord(fields: Array<{ label: string; value: Buffer }>): Buffer {
  const recBody = Buffer.concat(
    fields.map(f => len(2 /* Record.fields */, recordField(f.label, f.value))),
  );
  return len(14 /* Value.record */, recBody);
}
export function recordField(label: string, value: Buffer): Buffer {
  const parts: Buffer[] = [];
  if (label) parts.push(str(1 /* label */, label));
  parts.push(len(2 /* value */, value));
  return Buffer.concat(parts);
}
export function vList(elements: Buffer[]): Buffer {
  const body = Buffer.concat(elements.map(e => len(1 /* List.elements */, e)));
  return len(11 /* Value.list */, body);
}
/**
 * Value.optional (oneof tag 10) wrapping a present `Some(inner)`. Used by the
 * type-divergence attacks: a relay can wrap a money-critical field's Party in an
 * Optional so the record fails a shape heuristic while the engine still binds
 * `transfer` at its declaration position. `inner` is an encoded `Value`.
 */
export function vOptional(inner: Buffer): Buffer {
  return len(10 /* Value.optional */, len(1 /* Optional.value */, inner));
}

/**
 * Value.gen_map (oneof tag 13). Each entry has a Value key (field 1) and a Value
 * value (field 2). A party can hide in EITHER, so the verifier must descend
 * both. `entries` is a list of {key, value} encoded `Value` pairs.
 */
export function vGenMap(entries: Array<{ key: Buffer; value: Buffer }>): Buffer {
  const body = Buffer.concat(
    entries.map(e =>
      len(
        1 /* GenMap.entries */,
        Buffer.concat([len(1 /* Entry.key */, e.key), len(2 /* Entry.value */, e.value)]),
      ),
    ),
  );
  return len(13 /* Value.gen_map */, body);
}

/**
 * ATTACK builder: a single Daml `Value` message carrying `Value.numeric`
 * (oneof tag 6) TWICE — `decoy` first, `real` second. A first-occurrence-wins
 * reader sees `decoy`; a spec-conformant last-occurrence-wins parser (Canton)
 * sees `real`. Exercises the amount-inflation-via-duplicate-oneof bypass.
 */
export function vDualNumeric(decoy: string, real: string): Buffer {
  return Buffer.concat([vNumeric(decoy), vNumeric(real)]);
}

/**
 * ATTACK builder: a Daml `Value` that sets two DIFFERENT oneof members
 * (e.g. numeric + party). A last-wins parser keeps the second; our reader must
 * reject the ambiguity outright.
 */
export function vTwoMembers(a: Buffer, b: Buffer): Buffer {
  return Buffer.concat([a, b]);
}

export interface TransferOpts {
  sender: string;
  receiver: string;
  amount: string;
  admin: string;
  id: string;
  /** drop record-field labels (simulate a normalized, label-free encoding). */
  noLabels?: boolean;
  /**
   * ATTACK hook: replace the raw bytes of the transfer.amount field's `Value`
   * (normally `vNumeric(amount)`). Used to craft a dual-`Value.numeric` amount
   * (decoy first, inflated second) for the last-wins-divergence bypass.
   */
  amountValueOverride?: Buffer;
}

export function instrumentRecord(o: TransferOpts): Buffer {
  return vRecord([
    { label: o.noLabels ? "" : "admin", value: vParty(o.admin) },
    { label: o.noLabels ? "" : "id", value: vText(o.id) },
  ]);
}

export function transferRecord(
  o: TransferOpts,
  extra: Array<{ label: string; value: Buffer }> = [],
): Buffer {
  return vRecord([
    { label: o.noLabels ? "" : "sender", value: vParty(o.sender) },
    { label: o.noLabels ? "" : "receiver", value: vParty(o.receiver) },
    { label: o.noLabels ? "" : "amount", value: o.amountValueOverride ?? vNumeric(o.amount) },
    { label: o.noLabels ? "" : "instrumentId", value: instrumentRecord(o) },
    ...extra,
  ]);
}

/** TransferFactory_Transfer choice arg: {expectedAdmin, transfer, extraArgs}. */
export function choiceArgument(
  o: TransferOpts,
  transferExtra: Array<{ label: string; value: Buffer }> = [],
): Buffer {
  return vRecord([
    { label: o.noLabels ? "" : "expectedAdmin", value: vParty(o.admin) },
    { label: o.noLabels ? "" : "transfer", value: transferRecord(o, transferExtra) },
    {
      label: o.noLabels ? "" : "extraArgs",
      value: vRecord([{ label: o.noLabels ? "" : "meta", value: vRecord([]) }]),
    },
  ]);
}

export interface PreparedOpts extends TransferOpts {
  choiceId?: string;
  actAs?: string[];
  transferExtra?: Array<{ label: string; value: Buffer }>;
  secondExerciseChoice?: string;
  secondExerciseArg?: Buffer;
  /** Metadata.synchronizer_id (field 3); defaults to a placeholder. */
  synchronizerId?: string;
  /** Exercise.contract_id of the root exercise (default "00factory"). Pass the
   *  resolved factory cid to match a caller pinning expectedContractId. */
  contractId?: string;
}

/** Build a DamlTransaction.Node carrying a v1 Exercise. `contractId` defaults to
 *  "00factory" (the historical fixture value, kept so existing tests are
 *  unchanged); pass the resolved factory/EPAR cid to mirror a real participant
 *  that encodes Exercise.contract_id = the exercised contract. */
export function exerciseNode(
  choiceId: string,
  chosenValue: Buffer,
  contractId = "00factory",
): Buffer {
  const exercise = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, contractId),
    str(9 /* choice_id */, choiceId),
    len(10 /* chosen_value */, chosenValue),
    vintField(11 /* consuming */, 1),
  ]);
  const v1node = len(3 /* v1.Node.exercise */, exercise);
  return Buffer.concat([
    str(1 /* node_id */, "0"),
    len(1000 /* DamlTransaction.Node.v1 */, v1node),
  ]);
}

/** Build a full base64 PreparedTransaction with a single transfer exercise. */
export function buildPrepared(o: PreparedOpts): string {
  const choiceId = o.choiceId ?? "TransferFactory_Transfer";
  const node = exerciseNode(choiceId, choiceArgument(o, o.transferExtra), o.contractId);

  const nodes: Buffer[] = [len(3 /* DamlTransaction.nodes */, node)];
  if (o.secondExerciseChoice) {
    const arg = o.secondExerciseArg ?? choiceArgument(o);
    nodes.push(len(3, exerciseNode(o.secondExerciseChoice, arg)));
  }

  const damlTx = Buffer.concat([str(1 /* version */, "2.1"), str(2 /* roots */, "0"), ...nodes]);

  const actAs = o.actAs ?? [o.sender];
  const submitterInfo = Buffer.concat([
    ...actAs.map(p => str(1 /* act_as */, p)),
    str(2 /* command_id */, "cmd-1"),
  ]);
  const metadata = Buffer.concat([
    len(2 /* submitter_info */, submitterInfo),
    str(3 /* synchronizer_id */, o.synchronizerId ?? "sync::1220aaaa"),
  ]);

  const prepared = Buffer.concat([
    len(1 /* PreparedTransaction.transaction */, damlTx),
    len(2 /* PreparedTransaction.metadata */, metadata),
  ]);
  return prepared.toString("base64");
}

/** Convenience: build an honest prepared tx from sender/receiver/amount only. */
export function buildHonest(
  req: { sender: string; receiver: string; amount: string },
  o: { admin?: string; id?: string; contractId?: string } = {},
): string {
  return buildPrepared({
    sender: req.sender,
    receiver: req.receiver,
    amount: req.amount,
    admin: o.admin ?? "DSO::1220cafe",
    id: o.id ?? "Amulet",
    ...(o.contractId !== undefined ? { contractId: o.contractId } : {}),
  });
}

/* ════════════════════════════════════════════════════════════════════════
 * v1 (external-party-amulet-rules) — ExternalPartyAmuletRules_CreateTransferCommand
 *
 * The choice argument is a FLAT record:
 *   {sender:Party, receiver:Party, delegate:Party, amount:Numeric,
 *    expiresAt:Time, nonce:Int, description:Optional Text, expectedDso:Optional Party}
 * Field numbers reuse the same Ledger API Value/Record/Exercise layout the
 * cip56 builder uses, so the structural verifier is exercised against the real
 * wire shape.
 * ════════════════════════════════════════════════════════════════════════ */

export interface CreateTransferCommandOpts {
  sender: string;
  receiver: string;
  delegate: string;
  amount: string;
  /** epoch microseconds. Default: now + 60s. */
  expiresAtMicros?: number;
  nonce: number;
  /** JSON description string. Optional Text → we wrap as a present Some(Text). */
  description?: string;
  expectedDso: string;
  /** drop record-field labels (simulate a normalized, label-free encoding). */
  noLabels?: boolean;
  /** ATTACK hook: override the raw `Value` bytes for the amount field. */
  amountValueOverride?: Buffer;
  /** ATTACK hook: override the raw `Value` bytes for the nonce field. */
  nonceValueOverride?: Buffer;
  /** ATTACK hook: extra record fields appended to the choice-arg record (e.g. a
   *  smuggled second receiver party, or a GenMap hiding a foreign party). */
  extraFields?: Array<{ label: string; value: Buffer }>;
  actAs?: string[];
  choiceId?: string;
  /** Metadata.synchronizer_id (field 3). Defaults to a placeholder; set it to the
   *  caller-intent domain so an honest prepared tx matches a pinned synchronizer. */
  synchronizerId?: string;
  /** Exercise.contract_id of the EPAR (default "00factory"). Pass the resolved
   *  EPAR cid to match a caller pinning expectedContractId. */
  contractId?: string;
}

/** Optional Text encoded as Some(text): Value.optional{ value: Value.text }. */
function vSomeText(t: string): Buffer {
  return len(10 /* Value.optional */, len(1 /* Optional.value */, vText(t)));
}

/** Optional Party encoded as Some(party): Value.optional{ value: Value.party }.
 *  This is how the participant ACTUALLY encodes the v1 choice's
 *  `expectedDso : Optional Party` — NOT a bare `Value.party`. The fixture used
 *  the bare shape originally, which hid the "leafOf does not unwrap Optional →
 *  expectedDso reads undefined → every v1 payment rejected" bug. Encoding it as
 *  Some(party) here exercises the real wire shape. */
function vSomeParty(p: string): Buffer {
  return len(10 /* Value.optional */, len(1 /* Optional.value */, vParty(p)));
}

/** Build the CreateTransferCommand choice-argument record. */
export function createTransferCommandArgument(o: CreateTransferCommandOpts): Buffer {
  const lbl = (s: string) => (o.noLabels ? "" : s);
  const expiresAt = o.expiresAtMicros ?? (Date.now() + 60_000) * 1000;
  return vRecord([
    { label: lbl("sender"), value: vParty(o.sender) },
    { label: lbl("receiver"), value: vParty(o.receiver) },
    { label: lbl("delegate"), value: vParty(o.delegate) },
    { label: lbl("amount"), value: o.amountValueOverride ?? vNumeric(o.amount) },
    { label: lbl("expiresAt"), value: vTimestamp(expiresAt) },
    { label: lbl("nonce"), value: o.nonceValueOverride ?? vInt64(o.nonce) },
    {
      label: lbl("description"),
      value: o.description !== undefined ? vSomeText(o.description) : len(10, Buffer.alloc(0)),
    },
    // `expectedDso : Optional Party` — Some(party), matching how the participant
    // actually encodes it on the wire (NOT a bare Value.party).
    { label: lbl("expectedDso"), value: vSomeParty(o.expectedDso) },
    ...(o.extraFields ?? []),
  ]);
}

/** Build a full base64 PreparedTransaction carrying a single
 *  ExternalPartyAmuletRules_CreateTransferCommand exercise. */
export function buildPreparedV1(o: CreateTransferCommandOpts): string {
  const choiceId = o.choiceId ?? "ExternalPartyAmuletRules_CreateTransferCommand";
  const node = exerciseNode(choiceId, createTransferCommandArgument(o), o.contractId);
  const damlTx = Buffer.concat([
    str(1 /* version */, "2.1"),
    str(2 /* roots */, "0"),
    len(3 /* DamlTransaction.nodes */, node),
  ]);
  const actAs = o.actAs ?? [o.sender];
  const submitterInfo = Buffer.concat([
    ...actAs.map(p => str(1 /* act_as */, p)),
    str(2 /* command_id */, "cmd-1"),
  ]);
  const metadata = Buffer.concat([
    len(2 /* submitter_info */, submitterInfo),
    str(3 /* synchronizer_id */, o.synchronizerId ?? "sync::1220aaaa"),
  ]);
  const prepared = Buffer.concat([
    len(1 /* PreparedTransaction.transaction */, damlTx),
    len(2 /* PreparedTransaction.metadata */, metadata),
  ]);
  return prepared.toString("base64");
}
/* ════════════════════════════════════════════════════════════════════════
 * claim path — TransferInstruction_Accept (funds-IN).
 *
 * The accept's choice argument is `{extraArgs: {context, meta}}` — it carries no
 * money-critical fields (the agent is RECEIVING). The verify accept arm only
 * checks the root choice id, act_as, and timing, so a minimal record arg suffices.
 * ════════════════════════════════════════════════════════════════════════ */

export interface AcceptOpts {
  /** The agent (authoritative submitter / act_as). */
  selfParty: string;
  /** Override the root choice id (to simulate a relay returning a DRAIN instead). */
  choiceId?: string;
  /** Override the chosen_value (default: an empty-ish extraArgs record). */
  chosenValue?: Buffer;
  /** Consequence exercise choice ids to attach as CHILDREN of the single Accept
   *  root (e.g. ["LockedAmulet_UnlockV2","Archive"] — the real claim shape, or a
   *  drain like ["TransferCommand_Send"] to prove rejection). */
  consequenceChoiceIds?: string[];
  actAs?: string[];
  synchronizerId?: string;
}

/** Build a full base64 PreparedTransaction carrying a single
 *  TransferInstruction_Accept exercise (the honest claim shape). */
export function buildPreparedAccept(o: AcceptOpts): string {
  const choiceId = o.choiceId ?? "TransferInstruction_Accept";
  const chosen =
    o.chosenValue ??
    vRecord([{ label: "extraArgs", value: vRecord([{ label: "meta", value: vRecord([]) }]) }]);
  const cons = o.consequenceChoiceIds ?? [];
  const childIds = cons.map((_, i) => String(i + 1));
  // Root Accept node "0", with Exercise.children (field 12) referencing the
  // consequence node ids (so they are reachable descendants, not orphans/roots).
  const rootExercise = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, "00factory"),
    str(9 /* choice_id */, choiceId),
    len(10 /* chosen_value */, chosen),
    vintField(11 /* consuming */, 1),
    ...childIds.map(c => str(12 /* Exercise.children */, c)),
  ]);
  const rootNode = Buffer.concat([
    str(1 /* node_id */, "0"),
    len(1000 /* Node.v1 */, len(3 /* v1.Node.exercise */, rootExercise)),
  ]);
  const consNodes = cons.map((cChoice, i) => {
    const ex = Buffer.concat([
      str(1, "2.1"),
      str(2, "00cons" + i),
      str(9, cChoice),
      len(10, vRecord([])),
      vintField(11, 1),
    ]);
    return Buffer.concat([str(1 /* node_id */, String(i + 1)), len(1000, len(3, ex))]);
  });
  const damlTx = Buffer.concat([
    str(1 /* version */, "2.1"),
    str(2 /* roots */, "0"),
    // DamlTransaction.nodes is REPEATED (field 3): wrap EACH node separately.
    ...[rootNode, ...consNodes].map(n => len(3 /* DamlTransaction.nodes */, n)),
  ]);
  const actAs = o.actAs ?? [o.selfParty];
  const submitterInfo = Buffer.concat([
    ...actAs.map(p => str(1 /* act_as */, p)),
    str(2 /* command_id */, "cmd-1"),
  ]);
  const metadata = Buffer.concat([
    len(2 /* submitter_info */, submitterInfo),
    str(3 /* synchronizer_id */, o.synchronizerId ?? "sync::1220aaaa"),
  ]);
  const prepared = Buffer.concat([
    len(1 /* PreparedTransaction.transaction */, damlTx),
    len(2 /* PreparedTransaction.metadata */, metadata),
  ]);
  return prepared.toString("base64");
}

/* ════════════════════════════════════════════════════════════════════════
 * x402-escrow "Design A" ACCEPT — X402EscrowOffer_Accept (funds-NEUTRAL).
 *
 * The accept's choice argument is empty (the Daml choice has NO `with` block) —
 * we encode an empty-ish record. Its consequences are an Archive of the consumed
 * `X402EscrowOffer` (an EXERCISE node) AND a Create of the `X402Escrow` (a CREATE
 * node) whose argument record carries the parties {facilitator, sender, merchant,
 * amount, instrumentAdmin} in Daml declaration order, with signatories
 * {facilitator, sender}. This mirrors the real wire: the verify escrow-accept arm
 * scans the Create argument's party leaves + the node-level signatories, so the
 * fixture MUST carry them to exercise the foreign-party backstop faithfully.
 *
 * Field numbers match the real protos: a v1 Create node sets
 * transaction.v1.Node.create = 1; Create.argument = 5, .signatories = 6 (repeated
 * string party), .stakeholders = 7. The exercise/root/metadata layout is shared
 * with the other builders.
 * ════════════════════════════════════════════════════════════════════════ */

/** Build a DamlTransaction.Node carrying a v1 Create (consequence) node. The
 *  `argument` is an encoded Value record; `signatories`/`stakeholders` are
 *  repeated string party fields the verifier's backstop also scans. */
export function createNode(
  nodeId: string,
  contractId: string,
  argument: Buffer,
  signatories: string[] = [],
  stakeholders: string[] = [],
  /** Optional Create.template_id (field 4), encoded as a flat
   *  "pkg:Module:Entity" Identifier string (the same flat form the exercise
   *  builder uses), so identifierQualifiedName reads "Module:Entity". When set,
   *  the verifier can identify the created template (e.g. X402Escrow:X402Escrow). */
  templateId?: string,
): Buffer {
  const create = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, contractId),
    ...(templateId !== undefined
      ? [len(4 /* Create.template_id */, Buffer.from(templateId, "utf-8"))]
      : []),
    len(5 /* Create.argument */, argument),
    ...signatories.map(p => str(6 /* Create.signatories */, p)),
    ...stakeholders.map(p => str(7 /* Create.stakeholders */, p)),
  ]);
  return Buffer.concat([
    str(1 /* node_id */, nodeId),
    len(1000 /* Node.v1 */, len(1 /* v1.Node.create */, create)),
  ]);
}

export interface EscrowAcceptOpts {
  /** The agent (authoritative submitter / act_as AND the choice controller =
   *  the offer's sender). Also an X402Escrow signatory. */
  selfParty: string;
  /** The facilitator party (offer signatory + X402Escrow signatory + settler). */
  facilitator: string;
  /** The merchant party recorded (reference-only) on the created X402Escrow.
   *  Defaults to the facilitator (Design A often collapses roles). */
  merchant?: string;
  /** The instrument admin (DSO) recorded on the created X402Escrow. Defaults to a
   *  placeholder DSO; pass a value the caller pins to keep the honest shape valid. */
  instrumentAdmin?: string;
  /** Reference amount stamped on the created X402Escrow (no security role). */
  amount?: string;
  /** Exercise.contract_id of the X402EscrowOffer being accepted. Default
   *  "00offer"; the verify arm pins this to the caller's offerCid. */
  offerCid?: string;
  /** Override the root choice id (to simulate a relay returning a different,
   *  value-MOVING choice instead — e.g. "TransferFactory_Transfer"). */
  choiceId?: string;
  /** Override the exercised template id (Identifier). Default encodes the flat
   *  "x402-escrow:X402Escrow:X402EscrowOffer" so identifierQualifiedName reads
   *  "X402Escrow:X402EscrowOffer". */
  templateId?: string;
  /** Override the root chosen_value (default: an empty-ish extraArgs record). Used
   *  to SMUGGLE a foreign party leaf into the accept argument. */
  chosenValue?: Buffer;
  /** When true, OMIT the Create-of-X402Escrow consequence (only the Archive of the
   *  offer remains). Default false — the honest shape includes the Create. */
  omitEscrowCreate?: boolean;
  /** When set, stamp the X402Escrow Create node with this template id (Identifier
   *  flat string, e.g. "x402-escrow:X402Escrow:X402Escrow"). Default: unset (the
   *  create carries no template id, exercising the self-anchored identification
   *  path). Set it to exercise the created-template identification path. */
  escrowCreateTemplateId?: string;
  /** When set, append a SECOND X402Escrow Create consequence with this amount
   *  (same {facilitator, sender} principals), to prove the amount-pin rejects an
   *  ambiguous "two escrows created" transaction. */
  secondEscrowAmount?: string;
  /** Override the X402Escrow Create argument's party fields / labels to inject a
   *  foreign facilitator / recipient into the created escrow. */
  escrowArgOverride?: Buffer;
  /** Extra consequence EXERCISE choice ids attached as CHILDREN of the single
   *  Accept root (e.g. ["TransferFactory_Transfer"] — a drain to prove rejection).
   *  The honest Archive-of-offer consequence is ALWAYS attached first. */
  extraConsequenceChoiceIds?: string[];
  /** When set, attach an extra consequence CREATE node carrying these party leaves
   *  in its argument (e.g. an injected Amulet/Holding create for a foreign payee)
   *  to prove the backstop rejects it. */
  extraCreateParties?: string[];
  /** Override act_as (e.g. a foreign submitter party) to prove rejection. */
  actAs?: string[];
  synchronizerId?: string;
}

/** The X402Escrow Create argument record: {facilitator, sender, merchant, amount,
 *  instrumentAdmin} in Daml declaration order (matches X402Escrow.daml). */
export function escrowCreateArgument(o: {
  facilitator: string;
  sender: string;
  merchant: string;
  amount: string;
  instrumentAdmin: string;
}): Buffer {
  return vRecord([
    { label: "facilitator", value: vParty(o.facilitator) },
    { label: "sender", value: vParty(o.sender) },
    { label: "merchant", value: vParty(o.merchant) },
    { label: "amount", value: vNumeric(o.amount) },
    { label: "instrumentAdmin", value: vParty(o.instrumentAdmin) },
  ]);
}

/** Build a full base64 PreparedTransaction carrying a single
 *  `X402EscrowOffer_Accept` exercise (the honest Design A accept shape):
 *    root  node 0 : Exercise X402EscrowOffer_Accept on the offer cid, children [1,2…]
 *    cons  node 1 : Exercise Archive on the consumed X402EscrowOffer
 *    cons  node 2 : Create   X402Escrow {facilitator,sender,merchant,amount,admin}
 *  plus any extra consequence exercises / a foreign-recipient create for attacks. */
export function buildPreparedEscrowAccept(o: EscrowAcceptOpts): string {
  const choiceId = o.choiceId ?? "X402EscrowOffer_Accept";
  const offerCid = o.offerCid ?? "00offer";
  const merchant = o.merchant ?? o.facilitator;
  const instrumentAdmin = o.instrumentAdmin ?? "DSO::1220cafe";
  const amount = o.amount ?? "1.0000000000";
  const templateId = o.templateId ?? "x402-escrow:X402Escrow:X402EscrowOffer";
  const chosen =
    o.chosenValue ??
    vRecord([{ label: "extraArgs", value: vRecord([{ label: "meta", value: vRecord([]) }]) }]);

  // Consequence nodes (children of the single Accept root), assigned ids 1..N.
  const consNodes: Buffer[] = [];
  const childIds: string[] = [];
  let nextId = 1;

  // (a) Archive of the consumed X402EscrowOffer — an EXERCISE node.
  {
    const id = String(nextId++);
    childIds.push(id);
    const ex = Buffer.concat([
      str(1, "2.1"),
      str(2, offerCid),
      str(9, "Archive"),
      len(10, vRecord([])),
      vintField(11, 1),
    ]);
    consNodes.push(
      Buffer.concat([str(1 /* node_id */, id), len(1000, len(3 /* v1.Node.exercise */, ex))]),
    );
  }

  // (b) Create of the X402Escrow — a CREATE node carrying the escrow parties.
  if (!o.omitEscrowCreate) {
    const id = String(nextId++);
    childIds.push(id);
    const arg =
      o.escrowArgOverride ??
      escrowCreateArgument({
        facilitator: o.facilitator,
        sender: o.selfParty,
        merchant,
        amount,
        instrumentAdmin,
      });
    consNodes.push(
      createNode(
        id,
        "00escrow",
        arg,
        [o.facilitator, o.selfParty],
        [o.facilitator, o.selfParty],
        o.escrowCreateTemplateId,
      ),
    );
  }

  // (b2) ATTACK: a SECOND X402Escrow Create (same principals, different amount) to
  // prove the amount-pin rejects an ambiguous two-escrow transaction.
  if (o.secondEscrowAmount !== undefined) {
    const id = String(nextId++);
    childIds.push(id);
    const arg = escrowCreateArgument({
      facilitator: o.facilitator,
      sender: o.selfParty,
      merchant,
      amount: o.secondEscrowAmount,
      instrumentAdmin,
    });
    consNodes.push(
      createNode(
        id,
        "00escrow2",
        arg,
        [o.facilitator, o.selfParty],
        [o.facilitator, o.selfParty],
        o.escrowCreateTemplateId,
      ),
    );
  }

  // (c) ATTACK: extra consequence EXERCISE(s) — e.g. an outbound drain.
  for (const cChoice of o.extraConsequenceChoiceIds ?? []) {
    const id = String(nextId++);
    childIds.push(id);
    const ex = Buffer.concat([
      str(1, "2.1"),
      str(2, "00cons" + id),
      str(9, cChoice),
      len(10, vRecord([])),
      vintField(11, 1),
    ]);
    consNodes.push(
      Buffer.concat([str(1 /* node_id */, id), len(1000, len(3 /* v1.Node.exercise */, ex))]),
    );
  }

  // (d) ATTACK: extra consequence CREATE carrying foreign-recipient party leaves
  // (an injected Amulet/Holding create for a foreign payee).
  if (o.extraCreateParties && o.extraCreateParties.length > 0) {
    const id = String(nextId++);
    childIds.push(id);
    const arg = vRecord(o.extraCreateParties.map((p, i) => ({ label: "p" + i, value: vParty(p) })));
    consNodes.push(createNode(id, "00inj", arg, o.extraCreateParties, []));
  }

  // Root Accept node "0", with Exercise.children (field 12) referencing the
  // consequence node ids (so they are reachable descendants, not orphans/roots).
  const rootExercise = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, offerCid),
    len(4 /* Exercise.template_id */, Buffer.from(templateId, "utf-8")),
    str(9 /* choice_id */, choiceId),
    len(10 /* chosen_value */, chosen),
    vintField(11 /* consuming */, 1),
    ...childIds.map(c => str(12 /* Exercise.children */, c)),
  ]);
  const rootNode = Buffer.concat([
    str(1 /* node_id */, "0"),
    len(1000 /* Node.v1 */, len(3 /* v1.Node.exercise */, rootExercise)),
  ]);

  const damlTx = Buffer.concat([
    str(1 /* version */, "2.1"),
    str(2 /* roots */, "0"),
    ...[rootNode, ...consNodes].map(n => len(3 /* DamlTransaction.nodes */, n)),
  ]);
  const actAs = o.actAs ?? [o.selfParty];
  const submitterInfo = Buffer.concat([
    ...actAs.map(p => str(1 /* act_as */, p)),
    str(2 /* command_id */, "cmd-1"),
  ]);
  const metadata = Buffer.concat([
    len(2 /* submitter_info */, submitterInfo),
    str(3 /* synchronizer_id */, o.synchronizerId ?? "sync::1220aaaa"),
  ]);
  const prepared = Buffer.concat([
    len(1 /* PreparedTransaction.transaction */, damlTx),
    len(2 /* PreparedTransaction.metadata */, metadata),
  ]);
  return prepared.toString("base64");
}
