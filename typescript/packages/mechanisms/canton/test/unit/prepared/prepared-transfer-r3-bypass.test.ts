/**
 * ROUND-3 ADVERSARY suite for verify-before-sign (post 3bb20d4 round-2 fix).
 *
 * THREAT MODEL: the relay is MALICIOUS; it returns the `preparedTransaction`
 * bytes the agent signs+submits. A single Ed25519 signature authorizes the WHOLE
 * DamlTransaction + its signed Metadata, so ANYTHING verify fails to inspect is
 * authorized — we do NOT rely on the participant's downstream model-conformance
 * or event-blob authentication. Each `it` builds a malicious prepared tx and
 * asserts the SECURE behaviour (rejection). A test that FAILS against current
 * code is a REAL bypass that must be fixed fail-closed in production
 * (verify-prepared.ts / tx.ts). Positive `it`s guard against over-strict
 * regressions and MUST keep verifying.
 *
 * Field numbers are pinned to the published Canton Ledger API protos (see the
 * sibling verify-prepared-v2-bypass.test.ts header for the full field map). The
 * Daml `Value` oneof (com.daml.ledger.api.v2.value.Value):
 *   unit=1 bool=2 int64=3 date=4 timestamp=5 numeric=6 party=7 text=8
 *   contract_id=9 optional=10 list=11 text_map=12 gen_map=13 record=14
 *   variant=15 enum=16
 *
 * DO NOT loosen these tests to make them pass. Fix the production code.
 */
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "../../../src/prepared-transfer.js";
import {
  choiceArgument,
  str,
  len,
  vintField,
  vParty,
  vRecord,
  type TransferOpts,
} from "./prepared-fixture.js";

const SENDER = "agent::1220abcd";
const MERCHANT = "merchant.payments::1220beef";
const DSO = "dso.global::nonhexNS99";
const ATTACKER = "att.acker::1220dead";

/* ── low-level node + metadata builders (raw protobuf, real field numbers) ── */

function v1OuterNode(nodeId: string, v1NodeBody: Buffer): Buffer {
  return Buffer.concat([str(1 /* node_id */, nodeId), len(1000 /* Node.v1 */, v1NodeBody)]);
}

interface V1ExerciseOpts {
  choiceId: string;
  chosenValue?: Buffer; // omit ⇒ NO chosen_value (the round-3 malformed-exercise vector)
  contractId?: string;
  templateId?: string;
  signatories?: string[];
  stakeholders?: string[];
  actingParties?: string[];
  choiceObservers?: string[];
  children?: string[];
  exerciseResult?: Buffer;
}

function v1Exercise(nodeId: string, o: V1ExerciseOpts): Buffer {
  const ex = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, o.contractId ?? "00factory"),
    str(3 /* package_name */, "splice-amulet"),
    str(4 /* template_id */, o.templateId ?? "Splice.AmuletRules:ExternalPartyAmuletRules"),
    ...(o.signatories ?? []).map(s => str(5 /* signatories */, s)),
    ...(o.stakeholders ?? []).map(s => str(6 /* stakeholders */, s)),
    ...(o.actingParties ?? [SENDER]).map(s => str(7 /* acting_parties */, s)),
    str(9 /* choice_id */, o.choiceId),
    ...(o.chosenValue !== undefined ? [len(10 /* chosen_value */, o.chosenValue)] : []),
    vintField(11 /* consuming */, 1),
    ...(o.children ?? []).map(c => str(12 /* children */, c)),
    ...(o.exerciseResult ? [len(13 /* exercise_result */, o.exerciseResult)] : []),
    ...(o.choiceObservers ?? []).map(s => str(14 /* choice_observers */, s)),
  ]);
  return v1OuterNode(nodeId, len(3 /* v1.Node.exercise */, ex));
}

interface V1CreateOpts {
  argument: Buffer;
  contractId?: string;
  templateId?: string;
  signatories?: string[];
  stakeholders?: string[];
}

function v1Create(nodeId: string, o: V1CreateOpts): Buffer {
  const body = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, o.contractId ?? "00child"),
    str(3 /* package_name */, "splice-amulet"),
    str(4 /* template_id */, o.templateId ?? "Splice.AmuletRules:TransferCommand"),
    len(5 /* argument */, o.argument),
    ...(o.signatories ?? [SENDER]).map(s => str(6 /* signatories */, s)),
    ...(o.stakeholders ?? []).map(s => str(7 /* stakeholders */, s)),
  ]);
  return v1OuterNode(nodeId, len(1 /* v1.Node.create */, body));
}

interface MetadataOpts {
  actAs?: string[];
  synchronizerId?: string | null;
  mediatorGroup?: number;
  transactionUuid?: string;
  preparationTimeMicros?: number;
  minLedgerEffectiveTimeMicros?: number;
  maxLedgerEffectiveTimeMicros?: number;
  maxRecordTimeMicros?: number;
  inputContracts?: Buffer[];
}

function metadata(o: MetadataOpts = {}): Buffer {
  const actAs = o.actAs ?? [SENDER];
  const submitterInfo = Buffer.concat([
    ...actAs.map(p => str(1 /* act_as */, p)),
    str(2 /* command_id */, "cmd-1"),
  ]);
  const parts: Buffer[] = [len(2 /* submitter_info */, submitterInfo)];
  if (o.synchronizerId !== null) {
    parts.push(str(3 /* synchronizer_id */, o.synchronizerId ?? "sync::1220aaaa"));
  }
  if (o.mediatorGroup !== undefined) parts.push(vintField(4, o.mediatorGroup));
  if (o.transactionUuid !== undefined) parts.push(str(5, o.transactionUuid));
  if (o.preparationTimeMicros !== undefined) parts.push(vintField(6, o.preparationTimeMicros));
  for (const ic of o.inputContracts ?? []) parts.push(len(7 /* input_contracts */, ic));
  if (o.minLedgerEffectiveTimeMicros !== undefined) {
    parts.push(vintField(9 /* min_ledger_effective_time */, o.minLedgerEffectiveTimeMicros));
  }
  if (o.maxLedgerEffectiveTimeMicros !== undefined) {
    parts.push(vintField(10, o.maxLedgerEffectiveTimeMicros));
  }
  if (o.maxRecordTimeMicros !== undefined) parts.push(vintField(11, o.maxRecordTimeMicros));
  return Buffer.concat(parts);
}

function wrap(nodeBodies: Buffer[], roots: string[], md: Buffer = metadata()): string {
  const damlTx = Buffer.concat([
    str(1 /* version */, "2.1"),
    ...roots.map(r => str(2 /* roots */, r)),
    ...nodeBodies.map(n => len(3 /* nodes */, n)),
  ]);
  return Buffer.concat([len(1 /* transaction */, damlTx), len(2 /* metadata */, md)]).toString(
    "base64",
  );
}

/* ── honest building blocks ── */

const CIP_EXPECT: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  instrumentId: "Amulet",
};
const CIP_EXPECT_PINNED: PreparedTransferExpectation = { ...CIP_EXPECT, instrumentAdmin: DSO };
const cipOk: TransferOpts = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  admin: DSO,
  id: "Amulet",
};
function honestCipExercise(over: Partial<TransferOpts> = {}, children: string[] = []): Buffer {
  return v1Exercise("0", {
    choiceId: "TransferFactory_Transfer",
    chosenValue: choiceArgument({ ...cipOk, ...over }),
    actingParties: [SENDER],
    children,
  });
}

/* ════════════════════════════════════════════════════════════════════════
 * SANITY — the honest shapes used below VERIFY (over-strict regression guard).
 * ════════════════════════════════════════════════════════════════════════ */
describe("R3-0 sanity — honest shapes verify", () => {
  it("cip56: honest single-root exercise verifies", () => {
    expect(() =>
      assertPreparedTransferMatches(wrap([honestCipExercise()], ["0"]), CIP_EXPECT),
    ).not.toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * R3-1 — exercise-count blind spot: a second Exercise node that sets the
 * exercise oneof + choice_id but OMITS chosen_value decodes as kind="exercise"
 * with exercise=undefined. It is NOT in decoded.exercises (so the exercise-count
 * checks miss it) and NOT rejected by the "unknown/ambiguous node type" check
 * (kind is defined). A consuming exercise on an agent contract whose argument
 * verify NEVER decoded is authorized under the single signature.
 * SECURE: reject any kind="exercise" node we cannot fully decode. EXPECT FAIL.
 * ════════════════════════════════════════════════════════════════════════ */
describe("R3-1 — partially-decoded exercise node (choice_id present, chosen_value ABSENT)", () => {
  it("cip56: REJECTS a reachable child exercise node with NO chosen_value", () => {
    const malformed = v1Exercise("1", {
      choiceId: "Amulet_Burn",
      actingParties: [SENDER],
      signatories: [SENDER],
    });
    const prepared = wrap([honestCipExercise({}, ["1"]), malformed], ["0"]);
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * R3-3 — unpinned admin/dso aliased to the attacker, injected into a position
 * the round-2 honest-path fallback still exempts WITHOUT a trusted pin:
 *   (a) a reachable consequence Create's argument,
 *   (b) a node's party metadata (signatory/stakeholder/observer),
 *   (c) a Metadata.input_contracts Create argument.
 * The relay sets the unpinned expectedDso/instrumentId.admin to ATTACKER (a 4th
 * party, ≠ {sender,receiver,delegate}) so the value-global no-pin exemption
 * whitelists ATTACKER everywhere. CONFIRMED. SECURE: a relay-controlled,
 * unpinned admin/dso must NEVER be value-excluded outside its pinned root
 * position. EXPECT FAIL (verify currently exempts via the no-pin fallback).
 * ════════════════════════════════════════════════════════════════════════ */
describe("R3-3 — no-pin admin/dso aliasing whitelists the attacker outside the root", () => {
  it("cip56: REJECTS (no pin) ATTACKER==instrumentId.admin injected into a consequence Create", () => {
    const exercise = v1Exercise("0", {
      choiceId: "TransferFactory_Transfer",
      chosenValue: choiceArgument({ ...cipOk, admin: ATTACKER }),
      actingParties: [SENDER],
      children: ["1"],
    });
    const child = v1Create("1", {
      argument: vRecord([{ label: "owner", value: vParty(ATTACKER) }]),
      signatories: [SENDER],
    });
    const prepared = wrap([exercise, child], ["0"]);
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });

  // POSITIVE — WITH the out-of-band trusted pin, the honest admin-in-consequence
  // shape (pin matches) still VERIFIES (over-strict regression guard).
  it("cip56: ACCEPTS (trusted pin) the honest admin-in-consequence shape", () => {
    const child = v1Create("1", {
      argument: vRecord([
        { label: "admin", value: vParty(DSO) },
        { label: "sender", value: vParty(SENDER) },
        { label: "receiver", value: vParty(MERCHANT) },
      ]),
      signatories: [SENDER, DSO],
      stakeholders: [SENDER, DSO, MERCHANT],
    });
    expect(() =>
      assertPreparedTransferMatches(
        wrap([honestCipExercise({}, ["1"]), child], ["0"]),
        CIP_EXPECT_PINNED,
      ),
    ).not.toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * R3-4 — blind Daml `Value` oneof members. collectPartyLeaves recognizes only
 * party/numeric/text/int64/timestamp leaves + record/list/optional/variant/
 * map containers. A Value carrying an UNKNOWN oneof member (a future/unknown
 * tag) is silently dropped — its whole subtree (which could carry a foreign
 * recipient party) escapes the all-nodes foreign-party backstop.
 * SECURE: fail closed on any Value oneof member outside the complete known set.
 * EXPECT FAIL (verify currently drops the unknown member, missing the party).
 * ════════════════════════════════════════════════════════════════════════ */
describe("R3-4 — unknown Value oneof member hides a party from the backstop", () => {
  /** A Value setting an unknown oneof member (tag 99, LEN) wrapping a sub-Value. */
  const vUnknownWrapping = (inner: Buffer): Buffer => len(99, inner);

  it("cip56: REJECTS a foreign party hidden inside an unknown Value member in a consequence", () => {
    const child = v1Create("1", {
      argument: vRecord([{ label: "x", value: vUnknownWrapping(vParty(ATTACKER)) }]),
      signatories: [SENDER],
    });
    const prepared = wrap([honestCipExercise({}, ["1"]), child], ["0"]);
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(Error);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * R3-8 — signed Metadata.min_ledger_effective_time is DECODED but never
 * asserted (asymmetry vs preparation_time / max_record_time / max_LET). A relay
 * can set it implausibly far in the future, making the agent sign a command
 * pinned to an unreachable validity window. SECURE: bound it like the others.
 * EXPECT FAIL (no min-LET assertion today).
 * ════════════════════════════════════════════════════════════════════════ */
describe("R3-8 — min_ledger_effective_time unbounded (signed timing asymmetry)", () => {
  const farFuture = (Date.now() + 365 * 24 * 60 * 60 * 1000) * 1000; // +1y in µs
  it("cip56: REJECTS a min_ledger_effective_time implausibly far in the future", () => {
    const prepared = wrap(
      [honestCipExercise()],
      ["0"],
      metadata({ minLedgerEffectiveTimeMicros: farFuture }),
    );
    expect(() =>
      assertPreparedTransferMatches(prepared, { ...CIP_EXPECT, nowMs: Date.now() }),
    ).toThrow(PreparedTransferMismatchError);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * DISMISSALS — documented as NON-bypasses; these regression guards assert the
 * SAFE property (verify still pins the money-critical INPUT, and the relay-
 * chosen DoS-only field cannot redirect funds). They MUST pass on current code.
 * ════════════════════════════════════════════════════════════════════════ */

// R3-9 — cip56 synchronizer_id is unpinned by DEFAULT only because the base-CC
// flow has no out-of-band domain. DoS-only (domain routing, not redirect); the
// transfer body is fully validated. The pin MECHANISM works when the caller
// supplies expectSynchronizerId (proven here), so this is a caller-config item,
// not a verify bug.
describe("R3-9 (dismissed) — cip56 synchronizer pin works when an out-of-band domain is supplied", () => {
  it("cip56: REJECTS a relay-chosen synchronizer_id when the caller pins one", () => {
    const prepared = wrap(
      [honestCipExercise()],
      ["0"],
      metadata({ synchronizerId: "relay-domain::beef" }),
    );
    expect(() =>
      assertPreparedTransferMatches(prepared, {
        ...CIP_EXPECT,
        synchronizerId: "intended-domain::cafe",
      }),
    ).toThrow(PreparedTransferMismatchError);
  });
  it("cip56: ACCEPTS when the relay synchronizer_id matches the caller-pinned one", () => {
    const prepared = wrap(
      [honestCipExercise()],
      ["0"],
      metadata({ synchronizerId: "intended-domain::cafe" }),
    );
    expect(() =>
      assertPreparedTransferMatches(prepared, {
        ...CIP_EXPECT,
        synchronizerId: "intended-domain::cafe",
      }),
    ).not.toThrow();
  });
});
