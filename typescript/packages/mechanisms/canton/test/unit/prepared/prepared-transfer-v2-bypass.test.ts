/**
 * ROUND-2 ADVERSARY suite for verify-before-sign (post 7c459de node-traversal
 * fix). THREAT MODEL: the relay is MALICIOUS; it returns the `preparedTransaction`
 * bytes the agent signs+submits. A single Ed25519 signature authorizes the WHOLE
 * DamlTransaction + its signed Metadata, so anything verify fails to inspect is
 * authorized. Each `it` below builds a malicious prepared tx and asserts the
 * SECURE behaviour (rejection). A test that FAILS against current code is a REAL
 * bypass that must be fixed in production (verify-prepared.ts / tx.ts).
 *
 * Field numbers are pinned to the published Canton Ledger API protos
 * (interactive_submission_service.proto + interactive transaction v1
 * interactive_submission_data.proto), verified against the digital-asset/canton
 * repo. In particular the Metadata "needs to be signed" block:
 *   submitter_info=2, synchronizer_id=3, mediator_group=4, transaction_uuid=5,
 *   preparation_time=6, input_contracts=7, min_ledger_effective_time=9,
 *   max_ledger_effective_time=10, max_record_time=11
 * and the v1 nodes:
 *   Exercise: lf_version=1 contract_id=2 package_name=3 template_id=4
 *     signatories=5 stakeholders=6 acting_parties=7 choice_id=9 chosen_value=10
 *     consuming=11 children=12 exercise_result=13 choice_observers=14
 *   Create:  lf_version=1 contract_id=2 package_name=3 template_id=4 argument=5
 *     signatories=6 stakeholders=7
 *   Fetch:   lf_version=1 contract_id=2 package_name=3 template_id=4
 *     signatories=5 stakeholders=6 acting_parties=7
 *   QueryByKey: lf_version=1 package_name=2 template_id=3 exhaustive=4 key=5
 *
 * DO NOT loosen these tests to make them pass. Fix the production code fail-closed.
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
  vNumeric,
  vRecord,
  type TransferOpts,
} from "./prepared-fixture.js";

// Legal Canton party ids (dotted hints + non-hex namespaces are all valid).
const SENDER = "agent::1220abcd";
const MERCHANT = "merchant.payments::1220beef";
const DSO = "dso.global::nonhexNS99";
const ATTACKER = "att.acker::1220dead";

/* ────────────────────────────────────────────────────────────────────────
 * Low-level builders (raw protobuf, real Ledger API field numbers) for the
 * node + metadata surfaces the high-level fixture does not expose.
 * ──────────────────────────────────────────────────────────────────────── */

/** A v1 outer DamlTransaction.Node wrapping a v1.Node body, with a node_id. */
function v1OuterNode(nodeId: string, v1NodeBody: Buffer): Buffer {
  return Buffer.concat([str(1 /* node_id */, nodeId), len(1000 /* Node.v1 */, v1NodeBody)]);
}

interface V1ExerciseOpts {
  choiceId: string;
  chosenValue: Buffer;
  contractId?: string;
  templateId?: string; // "module:entity" or "pkg:module:entity"
  signatories?: string[];
  stakeholders?: string[];
  actingParties?: string[];
  choiceObservers?: string[];
  children?: string[];
  exerciseResult?: Buffer;
}

/** A v1.Node Exercise with full control of every (security-relevant) field. */
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
    len(10 /* chosen_value */, o.chosenValue),
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

/** A v1.Node Create with control over node-level party lists. */
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
  synchronizerId?: string | null; // null ⇒ omit field 3
  mediatorGroup?: number;
  transactionUuid?: string;
  preparationTimeMicros?: number;
  minLedgerEffectiveTimeMicros?: number;
  maxLedgerEffectiveTimeMicros?: number;
  maxRecordTimeMicros?: number;
  /** raw extra InputContract bytes (field 7), pre-encoded. */
  inputContracts?: Buffer[];
}

/** Build a Metadata message with the signed-block fields under our control. */
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
  if (o.mediatorGroup !== undefined) parts.push(vintField(4 /* mediator_group */, o.mediatorGroup));
  if (o.transactionUuid !== undefined) parts.push(str(5 /* transaction_uuid */, o.transactionUuid));
  if (o.preparationTimeMicros !== undefined) {
    parts.push(vintField(6 /* preparation_time */, o.preparationTimeMicros));
  }
  for (const ic of o.inputContracts ?? []) parts.push(len(7 /* input_contracts */, ic));
  if (o.minLedgerEffectiveTimeMicros !== undefined) {
    parts.push(vintField(9 /* min_ledger_effective_time */, o.minLedgerEffectiveTimeMicros));
  }
  if (o.maxLedgerEffectiveTimeMicros !== undefined) {
    parts.push(vintField(10 /* max_ledger_effective_time */, o.maxLedgerEffectiveTimeMicros));
  }
  if (o.maxRecordTimeMicros !== undefined) {
    parts.push(vintField(11 /* max_record_time */, o.maxRecordTimeMicros));
  }
  return Buffer.concat(parts);
}

/** Wrap node bodies + metadata into a complete base64 PreparedTransaction. */
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

/* ════════════════════════════════════════════════════════════════════════
 * Shared honest building blocks for each arm.
 * ════════════════════════════════════════════════════════════════════════ */

const CIP_EXPECT: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  instrumentId: "Amulet",
};
const cipOk: TransferOpts = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  admin: DSO,
  id: "Amulet",
};

/** Honest cip56 TransferFactory_Transfer exercise node (id 0). */
function honestCipExercise(over: Partial<TransferOpts> = {}, children: string[] = []): Buffer {
  return v1Exercise("0", {
    choiceId: "TransferFactory_Transfer",
    chosenValue: choiceArgument({ ...cipOk, ...over }),
    actingParties: [SENDER],
    children,
  });
}

/* ════════════════════════════════════════════════════════════════════════
 * C0 — sanity: the honest shapes (built with these low-level helpers) VERIFY.
 * Guards against over-strict regressions in the fixes below.
 * ════════════════════════════════════════════════════════════════════════ */
describe("C0 sanity — honest shapes built with low-level helpers VERIFY", () => {
  it("cip56: honest single-root exercise verifies", () => {
    expect(() =>
      assertPreparedTransferMatches(wrap([honestCipExercise()], ["0"]), CIP_EXPECT),
    ).not.toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C1 — Foreign-recipient backstop neutralized via the relay-controlled,
 * UNPINNED instrument-admin / expectedDso party. The relay sets the one party
 * field verify reads-but-does-not-pin (cip56 instrumentId.admin / v1
 * expectedDso) to ATTACKER, then injects ATTACKER as a recipient leaf elsewhere
 * (a consequence Create's owner, or an extra leaf in the root chosen_value).
 * Because the backstop excludes the admin/dso by VALUE across ALL nodes, the
 * attacker party becomes globally whitelisted. CONFIRMED.
 * ════════════════════════════════════════════════════════════════════════ */
describe("C1 — unpinned admin/dso aliased to attacker neutralizes the backstop", () => {
  // The consequence-node variants (attacker injected as a CONSEQUENCE recipient
  // whose value equals the relay-chosen, unpinned dso/admin) are structurally
  // indistinguishable from the honest TransferCommand consequence (which legit-
  // imately carries the dso as a payload party + signatory) UNLESS the caller
  // pins the dso/admin to an INDEPENDENTLY-TRUSTED value. So these supply the
  // trusted pin (instrumentAdmin) — the prepared admin=ATTACKER then mismatches
  // the trusted DSO and is refused. The root-extra-leaf variant below is closed
  // WITHOUT any pin (position-aware single-shot root exclusion).
  it("cip56: REJECTS (trusted admin pinned) when instrumentId.admin==ATTACKER and ATTACKER owns a consequence Create", () => {
    const exercise = v1Exercise("0", {
      choiceId: "TransferFactory_Transfer",
      chosenValue: choiceArgument({ ...cipOk, admin: ATTACKER }),
      actingParties: [SENDER],
      children: ["1"],
    });
    const child = v1Create("1", {
      argument: vRecord([
        { label: "owner", value: vParty(ATTACKER) },
        { label: "amount", value: vNumeric("1000000.0") },
      ]),
      signatories: [SENDER],
    });
    const prepared = wrap([exercise, child], ["0"]);
    expect(Buffer.from(prepared, "base64").toString("latin1")).toContain(ATTACKER);
    expect(() =>
      assertPreparedTransferMatches(prepared, { ...CIP_EXPECT, instrumentAdmin: DSO }),
    ).toThrow(PreparedTransferMismatchError);
  });

  it("cip56: REJECTS (no pin) when instrumentId.admin==ATTACKER and ATTACKER is an extra leaf in the root chosen_value", () => {
    const arg = choiceArgument(
      { ...cipOk, admin: ATTACKER },
      [{ label: "", value: vParty(ATTACKER) }], // extra party leaf inside the transfer record
    );
    const exercise = v1Exercise("0", {
      choiceId: "TransferFactory_Transfer",
      chosenValue: arg,
      actingParties: [SENDER],
    });
    const prepared = wrap([exercise], ["0"]);
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C2 — synchronizer_id (Metadata field 3) is SIGNED but never inspected.
 * A relay can set it to an attacker/wrong synchronizer; verify never reads it.
 * CONFIRMED. (Fix: pin to caller-intent synchronizer in both arms.)
 * ════════════════════════════════════════════════════════════════════════ */
describe("C2 — signed Metadata.synchronizer_id is uninspected", () => {
  const INTENDED_SYNC = "sync.intended::1220aaaa";

  it("cip56: REJECTS a relay-chosen synchronizer_id different from caller intent", () => {
    const md = metadata({ synchronizerId: "sync.attacker::1220evil" });
    const prepared = wrap([honestCipExercise()], ["0"], md);
    expect(() =>
      assertPreparedTransferMatches(prepared, {
        ...CIP_EXPECT,
        synchronizerId: INTENDED_SYNC,
      }),
    ).toThrow(PreparedTransferMismatchError);
  });

  it("cip56: ACCEPTS when synchronizer_id matches caller intent", () => {
    const md = metadata({ synchronizerId: INTENDED_SYNC });
    const prepared = wrap([honestCipExercise()], ["0"], md);
    expect(() =>
      assertPreparedTransferMatches(prepared, {
        ...CIP_EXPECT,
        synchronizerId: INTENDED_SYNC,
      }),
    ).not.toThrow();
  });

  // PHYSICAL-SYNCHRONIZER SUFFIX (live-wire regression). The caller pins the
  // LOGICAL id (what the participant accepts on prepare); the SIGNED bytes carry
  // the PHYSICAL id = logical + `::<version>-<serial>`. An exact-equality pin
  // false-rejects this legit tx (observed on TestNet: signed `…::35-2`). The pin
  // must accept the logical id optionally followed by ONE strict `<n>-<m>` suffix,
  // and STILL reject any other domain or any non-conforming suffix.
  it("cip56: ACCEPTS the logical id + a ::<version>-<serial> physical suffix", () => {
    const md = metadata({ synchronizerId: INTENDED_SYNC + "::35-2" });
    const prepared = wrap([honestCipExercise()], ["0"], md);
    expect(() =>
      assertPreparedTransferMatches(prepared, {
        ...CIP_EXPECT,
        synchronizerId: INTENDED_SYNC,
      }),
    ).not.toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C3 — other SIGNED Metadata timing fields are uninspected. preparation_time /
 * ledger-effective-time / max_record_time govern the validity window; a relay
 * can set an already-lapsed or implausibly-skewed value the agent blind-signs.
 * CONFIRMED (integrity/availability). Fix: sanity-bound against now.
 * ════════════════════════════════════════════════════════════════════════ */
describe("C3 — signed Metadata timing fields are unbounded", () => {
  const NOW = Date.now();
  const NOW_US = NOW * 1000;

  it("cip56: REJECTS a max_record_time already in the past", () => {
    const md = metadata({ maxRecordTimeMicros: NOW_US - 3_600_000_000 });
    const prepared = wrap([honestCipExercise()], ["0"], md);
    expect(() => assertPreparedTransferMatches(prepared, { ...CIP_EXPECT, nowMs: NOW })).toThrow(
      PreparedTransferMismatchError,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C5 — node-level repeated-string party fields (signatories / stakeholders /
 * acting_parties / choice_observers) on Create / Exercise are never scanned.
 * An attacker placed as a stakeholder/observer of a consequence node is invisible.
 * ════════════════════════════════════════════════════════════════════════ */
describe("C5 — node-metadata party fields bypass the backstop", () => {
  it("cip56: REJECTS when a consequence Create's stakeholder is ATTACKER", () => {
    const child = v1Create("1", {
      argument: vRecord([{ label: "owner", value: vParty(SENDER) }]),
      signatories: [SENDER],
      stakeholders: [SENDER, ATTACKER],
    });
    const prepared = wrap([honestCipExercise({}, ["1"]), child], ["0"]);
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });
});
