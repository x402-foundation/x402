/**
 * ROUND-4 ADVERSARY suite for verify-before-sign (post-e42274e round-3 fix).
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
 * This suite exercises the KEPT `TransferFactory_Transfer` verify primitive
 * (`assertPreparedTransferMatches`), which backs the withdraw + claim paths.
 *
 * Field numbers are pinned to the published Canton Ledger API protos
 * (interactive/transaction/v1/interactive_submission_data.proto and
 * interactive/interactive_submission_common_data.proto), verified against the
 * canton repo:
 *   Create   : lf_version=1 contract_id=2 package_name=3 template_id=4
 *              argument=5 signatories=6 stakeholders=7  key=8 (GlobalKeyWithMaintainers)
 *   Exercise : ... choice_id=9 chosen_value=10 consuming=11 children=12
 *              exercise_result=13 choice_observers=14  key=15 by_key=16
 *   Fetch    : ... signatories=5 stakeholders=6 acting_parties=7 interface_id=8
 *              key=9 by_key=10
 *   QueryByKey: lf_version=1 package_name=2 template_id=3 exhaustive=4
 *               key=5 (GlobalKeyWithMaintainers) result=6
 *   GlobalKeyWithMaintainers: key=1 (GlobalKey) maintainers=2 (repeated party)
 *   GlobalKey : template_id=1 package_name=2 key=3 (Value) hash=4
 *   Node oneof: create=1 fetch=2 exercise=3 rollback=4 query_by_key=5
 *
 * The Daml `Value` oneof (com.daml.ledger.api.v2.value.Value):
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
  instrumentRecord,
  str,
  len,
  vintField,
  vParty,
  vNumeric,
  vRecord,
  type TransferOpts,
} from "./prepared-fixture.js";

const SENDER = "agent::1220abcd";
const MERCHANT = "merchant.payments::1220beef";
const DSO = "dso.global::nonhexNS99";
const ATTACKER = "att.acker::1220dead";
const FUTURE = (Date.now() + 60_000) * 1000; // µs

/* ── low-level node + metadata builders (raw protobuf, real field numbers) ── */

function v1OuterNode(nodeId: string, v1NodeBody: Buffer): Buffer {
  return Buffer.concat([str(1 /* node_id */, nodeId), len(1000 /* Node.v1 */, v1NodeBody)]);
}

/**
 * Build a `GlobalKeyWithMaintainers` (key=1 GlobalKey, maintainers=2 party).
 * GlobalKey = {template_id=1, package_name=2, key=3 Value, hash=4 bytes}. The
 * inner `key` Value can carry ANY Daml Value tree (incl. party leaves).
 */
function globalKeyWithMaintainers(o: {
  keyValue?: Buffer;
  maintainers?: string[];
  templateId?: string;
}): Buffer {
  const globalKey = Buffer.concat([
    str(1 /* GlobalKey.template_id */, o.templateId ?? "Splice.Amulet:Amulet"),
    str(2 /* GlobalKey.package_name */, "splice-amulet"),
    ...(o.keyValue !== undefined ? [len(3 /* GlobalKey.key (Value) */, o.keyValue)] : []),
    len(4 /* GlobalKey.hash */, Buffer.from("deadbeef", "hex")),
  ]);
  return Buffer.concat([
    len(1 /* GKWM.key (GlobalKey) */, globalKey),
    ...(o.maintainers ?? []).map(m => str(2 /* GKWM.maintainers */, m)),
  ]);
}

interface V1ExerciseOpts {
  choiceId: string;
  chosenValue?: Buffer;
  contractId?: string;
  templateId?: string;
  signatories?: string[];
  stakeholders?: string[];
  actingParties?: string[];
  choiceObservers?: string[];
  children?: string[];
  exerciseResult?: Buffer;
  /** Exercise.key (field 15) — GlobalKeyWithMaintainers. */
  key?: Buffer;
}

function v1Exercise(nodeId: string, o: V1ExerciseOpts): Buffer {
  const ex = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, o.contractId ?? "00factory"),
    str(3 /* package_name */, "splice-amulet"),
    str(4 /* template_id */, o.templateId ?? "Splice.AmuletRules:TransferFactory"),
    ...(o.signatories ?? []).map(s => str(5 /* signatories */, s)),
    ...(o.stakeholders ?? []).map(s => str(6 /* stakeholders */, s)),
    ...(o.actingParties ?? [SENDER]).map(s => str(7 /* acting_parties */, s)),
    str(9 /* choice_id */, o.choiceId),
    ...(o.chosenValue !== undefined ? [len(10 /* chosen_value */, o.chosenValue)] : []),
    vintField(11 /* consuming */, 1),
    ...(o.children ?? []).map(c => str(12 /* children */, c)),
    ...(o.exerciseResult ? [len(13 /* exercise_result */, o.exerciseResult)] : []),
    ...(o.choiceObservers ?? []).map(s => str(14 /* choice_observers */, s)),
    ...(o.key !== undefined ? [len(15 /* Exercise.key */, o.key)] : []),
  ]);
  return v1OuterNode(nodeId, len(3 /* v1.Node.exercise */, ex));
}

interface V1CreateOpts {
  argument: Buffer;
  contractId?: string;
  templateId?: string;
  signatories?: string[];
  stakeholders?: string[];
  /** Create.key (field 8) — GlobalKeyWithMaintainers. */
  key?: Buffer;
}

function v1Create(nodeId: string, o: V1CreateOpts): Buffer {
  const body = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, o.contractId ?? "00child"),
    str(3 /* package_name */, "splice-amulet"),
    str(4 /* template_id */, o.templateId ?? "Splice.Amulet:Amulet"),
    len(5 /* argument */, o.argument),
    ...(o.signatories ?? [SENDER]).map(s => str(6 /* signatories */, s)),
    ...(o.stakeholders ?? []).map(s => str(7 /* stakeholders */, s)),
    ...(o.key !== undefined ? [len(8 /* Create.key */, o.key)] : []),
  ]);
  return v1OuterNode(nodeId, len(1 /* v1.Node.create */, body));
}

interface MetadataOpts {
  actAs?: string[];
  synchronizerId?: string | null;
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
  for (const ic of o.inputContracts ?? []) parts.push(len(7 /* input_contracts */, ic));
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

/**
 * Build a v1 InputContract whose Create v1 carries argument(5) + signatories(6)
 * + stakeholders(7). These are ALL bound into the V2 signed hash (the
 * participant hashes the disclosed contract via toCreateNode → addCreateNode,
 * which hashes argument + signatories + stakeholders), so a party placed in
 * signatories/stakeholders is authorized by the agent's signature.
 */
function inputContractV1(o: {
  argument: Buffer;
  signatories?: string[];
  stakeholders?: string[];
}): Buffer {
  // Layout CORRECTED against a real MainNet capture: lf_version(1),
  // contract_id(2), package_name(3), template_id(4). The previous version put
  // contract_id at 1 and package_name at 2, which was inert while nothing read
  // contract identity — and would have silently mis-taught any rule that does.
  const created = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, "00ic"),
    str(3 /* package_name */, "splice-amulet"),
    str(4 /* template_id */, "Splice.Amulet:Amulet"),
    len(5 /* create_argument */, o.argument),
    ...(o.signatories ?? []).map(s => str(6 /* signatories */, s)),
    ...(o.stakeholders ?? []).map(s => str(7 /* stakeholders */, s)),
  ]);
  return Buffer.concat([
    len(1 /* InputContract.v1 = Created */, created),
    vintField(1000 /* created_at */, FUTURE),
    str(1002 /* event_blob */, "blob"),
  ]);
}

/* ── honest building blocks ── */

const CIP_EXPECT: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  instrumentId: "Amulet",
  nowMs: Date.now(),
};
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
describe("R4-0 sanity — honest shapes verify", () => {
  it("cip56: honest single-root exercise verifies", () => {
    expect(() =>
      assertPreparedTransferMatches(wrap([honestCipExercise()], ["0"]), CIP_EXPECT),
    ).not.toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * CANDIDATE 1 — contract-key party positions never scanned by the all-nodes
 * foreign-party backstop. A foreign party placed ONLY in a GlobalKeyWithMain-
 * tainers (Create.key=8 / Exercise.key=15 / Fetch.key=9, or QueryByKey.key=5)
 * — as a maintainer (GKWM.maintainers=2) and/or inside the contract-key Value
 * (GlobalKey.key=3) — escapes the backstop. The file's stated invariant is "a
 * party introduced anywhere the agent's signature covers is visible to the
 * backstop"; the all-nodes party set must literally cover every party position.
 * SECURE: reject. CONTROL: the SAME attacker moved to a stakeholder IS rejected.
 * ════════════════════════════════════════════════════════════════════════ */
describe("R4-1 — contract-key party positions (GlobalKeyWithMaintainers) bypass the backstop", () => {
  it("cip56: REJECTS ATTACKER as a consequence Create KEY MAINTAINER", () => {
    const exercise = honestCipExercise({}, ["1"]);
    const child = v1Create("1", {
      argument: vRecord([{ label: "sender", value: vParty(SENDER) }]),
      signatories: [SENDER],
      stakeholders: [SENDER],
      key: globalKeyWithMaintainers({ maintainers: [ATTACKER] }),
    });
    const prepared = wrap([exercise, child], ["0"]);
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });

  it("cip56: REJECTS ATTACKER inside the ROOT Exercise KEY VALUE (GlobalKey.key)", () => {
    const exercise = v1Exercise("0", {
      choiceId: "TransferFactory_Transfer",
      chosenValue: choiceArgument(cipOk),
      actingParties: [SENDER],
      key: globalKeyWithMaintainers({
        keyValue: vRecord([{ label: "owner", value: vParty(ATTACKER) }]),
        maintainers: [SENDER],
      }),
    });
    const prepared = wrap([exercise], ["0"]);
    expect(Buffer.from(prepared, "base64").toString("latin1")).toContain(ATTACKER);
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * CANDIDATE 4 — input-contract Create signatories/stakeholders signed but not
 * scanned. decodePrepared descends each Metadata.input_contracts entry ONLY for
 * its Create `argument` (field 5), never signatories (6) / stakeholders (7). The
 * V2 metadata hasher binds disclosed/input contracts via toCreateNode →
 * addCreateNode, which hashes argument + signatories + stakeholders — so those
 * party fields ARE covered by the agent's signature, yet the backstop never
 * sees them. SECURE: reject.
 * ════════════════════════════════════════════════════════════════════════ */
describe("R4-4 — input-contract Create signatories/stakeholders are signed but unscanned", () => {
  it("cip56: REJECTS ATTACKER as an input-contract Create SIGNATORY", () => {
    const ic = inputContractV1({
      argument: vRecord([{ label: "owner", value: vParty(SENDER) }]),
      signatories: [SENDER, ATTACKER],
    });
    const prepared = wrap([honestCipExercise()], ["0"], metadata({ inputContracts: [ic] }));
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * CANDIDATE 2 — label-vs-positional field-binding divergence (amount inflation).
 * Daml-LF binds the choice argument POSITIONALLY (the choice type's field order);
 * the wire RecordField.label is advisory. extractTransfer reads money-critical
 * fields BY LABEL first. A malicious relay can therefore place the honest amount
 * at a field LABELED "amount" but at a wire POSITION the engine does NOT read as
 * amount, while putting an INFLATED Numeric at the wire position the engine binds
 * as amount (labeled something else). verify-by-label reads the honest decoy and
 * passes; the engine executes the inflated amount.
 *
 * Per the threat model we do NOT rely on the participant's LF re-validation to
 * reject this. SECURE: verify must not diverge from positional binding for a
 * money-critical numeric. EXPECT FAIL if verify accepts.
 * ════════════════════════════════════════════════════════════════════════ */
describe("R4-2 — label/position divergence on the amount field (amount inflation)", () => {
  it("cip56: REJECTS a transfer record carrying an INFLATED numeric at the engine's amount position with a HONEST decoy field labeled 'amount'", () => {
    // Daml transfer record positional order: [0]=sender:Party [1]=receiver:Party
    // [2]=amount:Numeric [3]=instrumentId:Record. The engine binds position [2]
    // as the amount. The relay puts the INFLATED numeric at position [2] under a
    // JUNK label the verifier never reads, and the honest "1.0" at a LATER field
    // labeled "amount" (which the verifier reads by label). All four real labels
    // (sender/receiver/amount/instrumentId) resolve to honest, well-typed values,
    // so the verifier's by-label read passes — yet the engine moves 9999.0.
    // SECURE: verify must read the amount POSITIONALLY (as the engine binds it),
    // or reject a record whose labels disagree with declaration order / arity.
    const transfer = vRecord([
      { label: "sender", value: vParty(SENDER) },
      { label: "receiver", value: vParty(MERCHANT) },
      // position [2] — what the engine binds as `amount` — INFLATED, junk label:
      { label: "___junk", value: vNumeric("9999.0000000000") },
      // decoy field carrying the label the verifier looks up, honest value:
      { label: "amount", value: vNumeric("1.0000000000") },
      { label: "instrumentId", value: instrumentRecord(cipOk) },
    ]);
    const arg = vRecord([
      { label: "expectedAdmin", value: vParty(DSO) },
      { label: "transfer", value: transfer },
      { label: "extraArgs", value: vRecord([{ label: "meta", value: vRecord([]) }]) },
    ]);
    const prepared = wrap(
      [
        v1Exercise("0", {
          choiceId: "TransferFactory_Transfer",
          chosenValue: arg,
          actingParties: [SENDER],
        }),
      ],
      ["0"],
    );
    // Fail-closed rejection: verify reads the amount POSITIONALLY (engine-
    // consistent) and refuses on the label/position divergence — surfacing as a
    // PreparedDecodeError (label/position guard) or an amount mismatch. Either
    // means the agent does not sign.
    expect(() => assertPreparedTransferMatches(prepared, CIP_EXPECT)).toThrow();
  });

  // POSITIVE — the honest fully-labeled encoding still VERIFIES (over-strict
  // regression guard for the extraction hardening).
  it("cip56: ACCEPTS the honest fully-labeled transfer record", () => {
    expect(() =>
      assertPreparedTransferMatches(wrap([honestCipExercise()], ["0"]), CIP_EXPECT),
    ).not.toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * CANDIDATE 3 (R4-3) covered only the retired v1 CreateTransferCommand single-
 * root invariant + numeric-blind backstop; its compensating controls for the
 * kept TransferFactory_Transfer path are exercised by the all-nodes party
 * backstop cases above (R4-1) and in verify-prepared-allocation.test.ts /
 * verify-prepared-withdraw.test.ts. Nothing v1-specific remains.
 * ════════════════════════════════════════════════════════════════════════ */
