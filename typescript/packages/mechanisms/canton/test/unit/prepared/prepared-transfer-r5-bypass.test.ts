/**
 * ROUND-5 ADVERSARY suite for verify-before-sign (post-34ec377 round-4 fix).
 *
 * THREAT MODEL: the relay is MALICIOUS; it returns the `preparedTransaction`
 * bytes the agent signs+submits. A single Ed25519 signature authorizes the WHOLE
 * DamlTransaction + its signed Metadata, so ANYTHING verify fails to inspect is
 * authorized — we do NOT rely on the participant's downstream model-conformance
 * or event-blob authentication. Each `it` builds a malicious prepared tx and
 * asserts the SECURE behaviour (rejection). A test that FAILS against the code is
 * a REAL bypass that must be fixed fail-closed in production. Positive `it`s
 * guard against over-strict regressions and MUST keep verifying.
 *
 * The candidates exercised here (reported by the round-3/4 adversaries against
 * the post-fix code):
 *
 *   C1 / C5 — extractTransfer's `looksLikeTransferRecord` `.find()` fallback was
 *     a NON-positional override of the declaration-position-1 read. By
 *     type-diverging ONE field of the engine's real position-1 `transfer` record
 *     (sender as Optional(Party), receiver as List(Party)) the relay made it fail
 *     the shape heuristic, so the search returned a relay-planted, well-typed
 *     DECOY transfer record at a DIFFERENT outer position carrying the honest
 *     amount — while the engine bound the INFLATED amount from position 1.
 *     extractTransfer compared the decoy and passed. FIX: read `transfer`
 *     STRICTLY at declaration position 1; a type-malformed transfer record is a
 *     tamper signal and is rejected, not worked around.
 *
 *   C2 — Exercise.contract_id (field 3) is never decoded/pinned, so a relay can
 *     point the choice at an attacker-deployed contract. CONTAINED in depth: any
 *     fund redirect needs a consequence Create owned by a foreign party, which
 *     the all-nodes party backstop rejects. These tests prove the backstop holds
 *     so the unpinned cid cannot be turned into a fund redirect.
 *
 *   C3 — Hash binding. The DEFAULT (no recompute, no opt-in) FAILS CLOSED. The
 *     `trustRelayHash:true` escape hatch is documented + off by default; a
 *     non-matching recompute is rejected. These tests pin that posture.
 *
 * Field numbers are the published Canton Ledger API protos. The Daml `Value`
 * oneof (com.daml.ledger.api.v2.value.Value):
 *   unit=1 bool=2 int64=3 date=4 timestamp=5 numeric=6 party=7 text=8
 *   contract_id=9 optional=10 list=11 text_map=12 gen_map=13 record=14
 *   variant=15 enum=16
 *
 * DO NOT loosen these tests to make them pass. Fix the production code.
 */
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  extractTransfer,
  PreparedTransferMismatchError,
  PreparedDecodeError,
  type PreparedTransferExpectation,
} from "../../../src/prepared-transfer.js";
import {
  str,
  len,
  vintField,
  vParty,
  vNumeric,
  vText,
  vRecord,
  vList,
  vOptional,
} from "./prepared-fixture.js";

const SENDER = "agent::1220abcd";
const RECEIVER = "merchant.payments::1220beef";
const ADMIN = "dso.global::nonhexNS99";
const ATTACKER = "att.acker::1220dead";

const EXPECT: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: RECEIVER,
  amount: "1.0",
  instrumentId: "Amulet",
  nowMs: Date.now(),
};

/* ── low-level builders (raw protobuf, real field numbers) ───────────────── */

/** instrumentId record {admin:Party, id:Text}. Label-free (positional). */
function instrument(admin = ADMIN, id = "Amulet"): Buffer {
  return vRecord([
    { label: "", value: vParty(admin) },
    { label: "", value: vText(id) },
  ]);
}

/**
 * A transfer record {sender, receiver, amount, instrumentId}. Each field's raw
 * `Value` bytes can be overridden so a single field can be TYPE-DIVERGED while
 * the rest stay well-typed.
 */
function transferRecord(o: {
  sender?: Buffer;
  receiver?: Buffer;
  amount?: Buffer;
  instrument?: Buffer;
}): Buffer {
  return vRecord([
    { label: "", value: o.sender ?? vParty(SENDER) },
    { label: "", value: o.receiver ?? vParty(RECEIVER) },
    { label: "", value: o.amount ?? vNumeric("1.0") },
    { label: "", value: o.instrument ?? instrument() },
  ]);
}

/**
 * The TransferFactory_Transfer choice argument is a record
 *   [0] expectedAdmin : Party
 *   [1] transfer      : Record
 *   [2] extraArgs     : Record
 * `pos0`/`pos2` let an attack plant a DECOY record where expectedAdmin/extraArgs
 * normally sit; `transfer` is whatever the engine binds at position 1.
 */
function choiceArg(o: { pos0?: Buffer; transfer: Buffer; pos2?: Buffer }): Buffer {
  return vRecord([
    { label: "", value: o.pos0 ?? vParty(ADMIN) },
    { label: "", value: o.transfer },
    {
      label: "",
      value: o.pos2 ?? vRecord([{ label: "", value: vRecord([]) }]),
    },
  ]);
}

/** A v1 exercise node carrying TransferFactory_Transfer with `chosen`. */
function exerciseNode(
  nodeId: string,
  chosen: Buffer,
  o: { choiceId?: string; contractId?: string; children?: string[] } = {},
): Buffer {
  const ex = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, o.contractId ?? "00factory"),
    str(9 /* choice_id */, o.choiceId ?? "TransferFactory_Transfer"),
    len(10 /* chosen_value */, chosen),
    vintField(11 /* consuming */, 1),
    ...(o.children ?? []).map(c => str(12 /* children */, c)),
  ]);
  return Buffer.concat([
    str(1 /* node_id */, nodeId),
    len(1000 /* DamlTransaction.Node.v1 */, len(3 /* v1.Node.exercise */, ex)),
  ]);
}

/** A v1 Create node whose Create.argument (field 5) is `arg`. */
function createNode(nodeId: string, arg: Buffer): Buffer {
  const create = len(5 /* Create.argument */, arg);
  return Buffer.concat([
    str(1 /* node_id */, nodeId),
    len(1000 /* DamlTransaction.Node.v1 */, len(1 /* v1.Node.create */, create)),
  ]);
}

/** Assemble a full base64 PreparedTransaction from node buffers + a roots list. */
function prepared(o: { nodes: Buffer[]; roots: string[]; actAs?: string[] }): string {
  const damlTx = Buffer.concat([
    str(1 /* version */, "2.1"),
    ...o.roots.map(r => str(2 /* roots */, r)),
    ...o.nodes.map(n => len(3 /* nodes */, n)),
  ]);
  const submitterInfo = Buffer.concat([
    ...(o.actAs ?? [SENDER]).map(p => str(1 /* act_as */, p)),
    str(2 /* command_id */, "cmd-1"),
  ]);
  const metadata = Buffer.concat([
    len(2 /* submitter_info */, submitterInfo),
    str(3 /* synchronizer_id */, "sync::1220aaaa"),
  ]);
  return Buffer.concat([
    len(1 /* PreparedTransaction.transaction */, damlTx),
    len(2 /* PreparedTransaction.metadata */, metadata),
  ]).toString("base64");
}

/** Single-exercise prepared tx convenience. */
function singleExercise(chosen: Buffer, contractId = "00factory"): string {
  return prepared({ nodes: [exerciseNode("0", chosen, { contractId })], roots: ["0"] });
}

/* ════════════════════════════════════════════════════════════════════════
 * C1 — looksLikeTransferRecord fallback divergence (amount inflation).
 *
 * The engine's position-1 transfer record is type-diverged in ONE field so it
 * fails the (removed) shape heuristic, and carries an INFLATED amount; a
 * well-typed honest DECOY transfer record is planted at outer position 0. The
 * fixed verifier reads position 1 directly and rejects the malformed record.
 * ════════════════════════════════════════════════════════════════════════ */

describe("C1: cip56 transfer-record divergence via looksLikeTransferRecord fallback", () => {
  // The honest decoy that previously the `.find()` fallback returned: well-typed,
  // honest amount 1.0 — it satisfies parties>=2 && numerics>=1.
  const honestDecoy = transferRecord({ amount: vNumeric("1.0") });

  it("REJECTS sender=Optional(Party) on the engine record + inflated amount + honest decoy at pos0", () => {
    const engineTransfer = transferRecord({
      sender: vOptional(vParty(SENDER)), // type-diverged: only 1 plain party leaf left
      amount: vNumeric("9999.0"), // the amount the ENGINE actually binds
    });
    const arg = choiceArg({ pos0: honestDecoy, transfer: engineTransfer });

    // extractTransfer must NOT read the decoy's amount; it must read position 1
    // (the engine's record) and fail closed on its malformed sender.
    expect(() => extractTransfer(arg)).toThrow(PreparedDecodeError);
    expect(() => assertPreparedTransferMatches(singleExercise(arg), EXPECT)).toThrow();
  });

  it("REJECTS receiver=List(Party) on the engine record + inflated amount + honest decoy at pos0", () => {
    const engineTransfer = transferRecord({
      receiver: vList([vParty(RECEIVER)]), // type-diverged
      amount: vNumeric("9999.0"),
    });
    const arg = choiceArg({ pos0: honestDecoy, transfer: engineTransfer });
    expect(() => extractTransfer(arg)).toThrow(PreparedDecodeError);
    expect(() => assertPreparedTransferMatches(singleExercise(arg), EXPECT)).toThrow();
  });

  it("REJECTS amount=Optional(Numeric) on the engine record (amount not a plain Numeric leaf)", () => {
    // amount wrapped in Optional → not a numeric leaf at position 2; decoy carries
    // honest 1.0 at pos0. Must fail closed (engine record is read, not the decoy).
    const engineTransfer = transferRecord({ amount: vOptional(vNumeric("9999.0")) });
    const arg = choiceArg({ pos0: honestDecoy, transfer: engineTransfer });
    expect(() => extractTransfer(arg)).toThrow(PreparedDecodeError);
    expect(() => assertPreparedTransferMatches(singleExercise(arg), EXPECT)).toThrow();
  });

  it("does not let a DECOY at pos2 (extraArgs slot) override the engine record at pos1", () => {
    // Even with a well-typed honest decoy occupying the extraArgs slot,
    // extractTransfer must bind position 1 (the engine's transfer) — which here is
    // type-malformed — and fail closed, never reaching into the decoy.
    const engineTransfer = transferRecord({
      sender: vOptional(vParty(SENDER)),
      amount: vNumeric("9999.0"),
    });
    const arg = choiceArg({ transfer: engineTransfer, pos2: honestDecoy });
    expect(() => extractTransfer(arg)).toThrow(PreparedDecodeError);
    expect(() => assertPreparedTransferMatches(singleExercise(arg), EXPECT)).toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C5 — label-free structural fallback not positionally pinned.
 *
 * Same root cause as C1 but framed for a fully label-free encoding: position 1
 * is the engine's `transfer`. Even if a different outer position is a perfectly
 * transfer-shaped record, the verifier must bind position 1 only.
 * ════════════════════════════════════════════════════════════════════════ */

describe("C5: label-free transfer must be read at declaration position 1 only", () => {
  it("REJECTS when pos1 is type-diverged even though a transfer-shaped sibling exists at pos0", () => {
    // pos0 is a fully valid transfer record (honest values); pos1 (the engine's
    // transfer) is diverged + inflated. Pre-fix the `.find()` returned pos0.
    const honestSibling = transferRecord({ amount: vNumeric("1.0") });
    const engineTransfer = transferRecord({
      sender: vOptional(vParty(SENDER)),
      amount: vNumeric("5000.0"),
    });
    const arg = choiceArg({ pos0: honestSibling, transfer: engineTransfer });
    expect(() => assertPreparedTransferMatches(singleExercise(arg), EXPECT)).toThrow();
  });

  it("ACCEPTS an honest label-free transfer (positive guard — no over-strictness)", () => {
    const arg = choiceArg({ transfer: transferRecord({ amount: vNumeric("1.0") }) });
    expect(() => assertPreparedTransferMatches(singleExercise(arg), EXPECT)).not.toThrow();
  });

  it("reads amount strictly from pos1 — a 1.0 decoy at pos0 cannot mask an inflated pos1", () => {
    // Both records are WELL-TYPED here (so the old heuristic matched BOTH): pos0
    // honest 1.0, pos1 inflated 9999.0. The engine binds pos1; verify must too.
    const decoy = transferRecord({ amount: vNumeric("1.0") });
    const engineInflated = transferRecord({ amount: vNumeric("9999.0") });
    const arg = choiceArg({ pos0: decoy, transfer: engineInflated });
    const t = extractTransfer(arg);
    expect(t.amount).toBe("9999.0"); // read pos1, NOT the decoy
    expect(() => assertPreparedTransferMatches(singleExercise(arg), EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C2 — Exercise.contract_id unpinned, but contained by the all-nodes backstop.
 * ════════════════════════════════════════════════════════════════════════ */

describe("C2: contract-id substitution is contained by the all-nodes party backstop", () => {
  const honestArg = choiceArg({ transfer: transferRecord({ amount: vNumeric("1.0") }) });

  it("REJECTS an exercise on an attacker cid whose consequence Create pays a foreign party", () => {
    // root exercise (honest args) points at an attacker-deployed contract id and
    // has a child Create that mints an Amulet owned by ATTACKER — the redirect a
    // substituted choice body would produce. The backstop sees ATTACKER.
    const amulet = vRecord([
      { label: "owner", value: vParty(ATTACKER) },
      { label: "amount", value: vNumeric("1.0") },
    ]);
    const root = exerciseNode("0", honestArg, {
      contractId: "00attackerFactory",
      children: ["1"],
    });
    const child = createNode("1", amulet);
    const bytes = prepared({ nodes: [root, child], roots: ["0"] });
    expect(() => assertPreparedTransferMatches(bytes, EXPECT)).toThrow(
      PreparedTransferMismatchError,
    );
  });

  it("ACCEPTS an honest single exercise regardless of the (relay-supplied) contract id", () => {
    // The cid is not pinned on the base flow; an honest tx still verifies. (The
    // cid is contained by the backstop, not by a pin — this documents that.)
    const bytes = singleExercise(honestArg, "00whatever-relay-cid");
    expect(() => assertPreparedTransferMatches(bytes, EXPECT)).not.toThrow();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * C3 — Hash binding posture: default fail-closed; opt-in is explicit.
 * ════════════════════════════════════════════════════════════════════════ */
