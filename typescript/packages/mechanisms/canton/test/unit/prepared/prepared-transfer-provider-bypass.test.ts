/**
 * ADVERSARIAL suite for the validator-provider role exception.
 *
 * The relay is hostile and controls every byte. Granting the preapproval
 * `provider` a position exception must NOT give it a second money destination,
 * and must not be obtainable by presenting a preapproval that does not belong to
 * this exact payment. Each case below builds the attack structurally.
 *
 * Wire layout here is the REAL one, taken from a live MainNet capture:
 * Create = lf_version(1), contract_id(2), package_name(3), template_id(4),
 * create_argument(5), signatories(6), stakeholders(7).
 */
import { describe, it, expect } from "vitest";
import {
  choiceArgument,
  len,
  str,
  vintField,
  vParty,
  vRecord,
  type TransferOpts,
} from "./prepared-fixture.js";
import {
  assertPreparedTransferMatches,
  type PreparedTransferExpectation,
} from "../../../src/prepared-transfer.js";

const SENDER = "agent::1220aaaa";
const MERCHANT = "merchant::1220bbbb";
const PROVIDER = "validator-1::1220cccc";
const DSO = "dso::1220dddd";
const ATTACKER = "attacker::1220eeee";
const PRE_CID = "00preapproval";
const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const FUTURE = (NOW + 300_000) * 1000; // micros

const OK: TransferOpts = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  admin: DSO,
  id: "Amulet",
};
const EXPECT: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: MERCHANT,
  amount: "1.0000000000",
  instrumentId: "Amulet",
  instrumentAdmin: DSO,
  nowMs: NOW,
};

/** TransferPreapproval argument: [0] dso [1] receiver [2] provider. */
function preapprovalArg(o: { dso?: string; receiver?: string; provider?: string } = {}): Buffer {
  return vRecord([
    { label: "dso", value: vParty(o.dso ?? DSO) },
    { label: "receiver", value: vParty(o.receiver ?? MERCHANT) },
    { label: "provider", value: vParty(o.provider ?? PROVIDER) },
  ]);
}

function inputContract(o: {
  contractId: string;
  template: string;
  argument: Buffer;
  signatories: string[];
}): Buffer {
  const created = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, o.contractId),
    str(3 /* package_name */, "splice-amulet"),
    str(4 /* template_id */, o.template),
    len(5 /* create_argument */, o.argument),
    ...o.signatories.map(s => str(6, s)),
    ...o.signatories.map(s => str(7, s)),
  ]);
  return Buffer.concat([
    len(1 /* InputContract.v1 */, created),
    vintField(1000 /* created_at */, FUTURE),
  ]);
}

function exerciseNode(o: {
  nodeId: string;
  choiceId: string;
  contractId: string;
  template: string;
  chosenValue: Buffer;
  children?: string[];
}): Buffer {
  const ex = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, o.contractId),
    str(4 /* template_id */, o.template),
    str(9 /* choice_id */, o.choiceId),
    len(10 /* chosen_value */, o.chosenValue),
    vintField(11 /* consuming */, 1),
    // EX_CHILDREN: consequences MUST hang off the root, else the (correct)
    // orphan-node check refuses first and the case proves nothing.
    ...(o.children ?? []).map(c => str(12, c)),
  ]);
  return Buffer.concat([
    str(1 /* node_id */, o.nodeId),
    len(1000 /* v1 */, len(3 /* exercise */, ex)),
  ]);
}

function createNode(o: {
  nodeId: string;
  template: string;
  argument: Buffer;
  signatories?: string[];
}): Buffer {
  const cr = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, "00created"),
    str(3 /* package_name */, "splice-amulet"),
    str(4 /* template_id */, o.template),
    len(5 /* create_argument */, o.argument),
    ...(o.signatories ?? []).map(s => str(6, s)),
  ]);
  return Buffer.concat([
    str(1 /* node_id */, o.nodeId),
    len(1000 /* v1 */, len(2 /* create */, cr)),
  ]);
}

/** Assemble a prepared transaction: root transfer + given extra nodes + inputs. */
function build(
  o: {
    transfer?: TransferOpts;
    extraNodes?: Buffer[];
    inputs?: Buffer[];
    actAs?: string[];
  } = {},
): string {
  const t = o.transfer ?? OK;
  const extras = o.extraNodes ?? [];
  const root = exerciseNode({
    nodeId: "0",
    choiceId: "TransferFactory_Transfer",
    contractId: "00factory",
    template: "Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules",
    chosenValue: choiceArgument(t),
    children: extras.map((_, i) => String(i + 1)),
  });
  const damlTx = Buffer.concat([
    str(1 /* version */, "2.1"),
    str(2 /* roots */, "0"),
    len(3, root),
    ...extras.map(n => len(3, n)),
  ]);
  const submitterInfo = Buffer.concat([
    ...(o.actAs ?? [t.sender]).map(p => str(1, p)),
    str(2 /* command_id */, "cmd-1"),
  ]);
  const metadata = Buffer.concat([
    len(2 /* submitter_info */, submitterInfo),
    str(3 /* synchronizer_id */, "sync::1220ffff"),
    ...(o.inputs ?? []).map(ic => len(7 /* input_contracts */, ic)),
  ]);
  return Buffer.concat([len(1, damlTx), len(2, metadata)]).toString("base64");
}

/** The honest validator-provided shape: preapproval input + delivery exercise. */
const honestPreapprovalInput = inputContract({
  contractId: PRE_CID,
  template: "Splice.AmuletRules:TransferPreapproval",
  argument: preapprovalArg(),
  signatories: [DSO, MERCHANT, PROVIDER],
});
const honestDelivery = exerciseNode({
  nodeId: "1",
  choiceId: "TransferPreapproval_SendV2",
  contractId: PRE_CID,
  template: "Splice.AmuletRules:TransferPreapproval",
  chosenValue: vRecord([]),
});

describe("provider role exception — honest baseline", () => {
  it("accepts the standard validator-provided shape", () => {
    const b64 = build({ extraNodes: [honestDelivery], inputs: [honestPreapprovalInput] });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).not.toThrow();
  });
});

describe("provider role exception — attacks that MUST be refused", () => {
  it("provider as the owner of an extra created Amulet", () => {
    const b64 = build({
      extraNodes: [
        honestDelivery,
        createNode({
          nodeId: "2",
          template: "Splice.Amulet:Amulet",
          argument: vRecord([{ label: "owner", value: vParty(PROVIDER) }]),
        }),
      ],
      inputs: [honestPreapprovalInput],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });

  it("provider smuggled into the ROOT transfer argument", () => {
    // The provider is legitimate in metadata, but NEVER inside the transfer
    // record itself: that is where a recipient would be smuggled.
    const injected = buildRootInjected();
    expect(() => assertPreparedTransferMatches(injected, EXPECT)).toThrow(/unexpected part/);
  });

  it("preapproval belongs to a DIFFERENT receiver (harvested provider)", () => {
    const b64 = build({
      extraNodes: [honestDelivery],
      inputs: [
        inputContract({
          contractId: PRE_CID,
          template: "Splice.AmuletRules:TransferPreapproval",
          argument: preapprovalArg({ receiver: ATTACKER }),
          signatories: [DSO, ATTACKER, PROVIDER],
        }),
      ],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });

  it("preapproval names a DIFFERENT dso than the pinned instrument admin", () => {
    const b64 = build({
      extraNodes: [honestDelivery],
      inputs: [
        inputContract({
          contractId: PRE_CID,
          template: "Splice.AmuletRules:TransferPreapproval",
          argument: preapprovalArg({ dso: ATTACKER }),
          signatories: [ATTACKER, MERCHANT, PROVIDER],
        }),
      ],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });

  it("TWO preapproval inputs (ambiguous: an honest one paired with a decoy)", () => {
    const decoy = inputContract({
      contractId: "00decoy",
      template: "Splice.AmuletRules:TransferPreapproval",
      argument: preapprovalArg({ provider: ATTACKER }),
      signatories: [DSO, MERCHANT, ATTACKER],
    });
    const b64 = build({
      extraNodes: [honestDelivery],
      inputs: [honestPreapprovalInput, decoy],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });

  it("preapproval carries a FOURTH signatory", () => {
    const b64 = build({
      extraNodes: [honestDelivery],
      inputs: [
        inputContract({
          contractId: PRE_CID,
          template: "Splice.AmuletRules:TransferPreapproval",
          argument: preapprovalArg(),
          signatories: [DSO, MERCHANT, PROVIDER, ATTACKER],
        }),
      ],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });

  it("delivery exercise targets a DIFFERENT contract id than the matched input", () => {
    const b64 = build({
      extraNodes: [
        exerciseNode({
          nodeId: "1",
          choiceId: "TransferPreapproval_SendV2",
          contractId: "00other",
          template: "Splice.AmuletRules:TransferPreapproval",
          chosenValue: vRecord([]),
        }),
      ],
      inputs: [honestPreapprovalInput],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });

  it("preapproval present but NO delivery exercise at all", () => {
    const b64 = build({ inputs: [honestPreapprovalInput] });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });

  it("provider value reused for a FOURTH foreign party elsewhere", () => {
    const b64 = build({
      extraNodes: [
        honestDelivery,
        createNode({
          nodeId: "2",
          template: "Splice.Amulet:FeaturedAppActivityMarker",
          argument: vRecord([{ label: "beneficiary", value: vParty(ATTACKER) }]),
        }),
      ],
      inputs: [honestPreapprovalInput],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/attacker/);
  });

  it("provider inside an UNRELATED input contract is not granted a role", () => {
    const b64 = build({
      extraNodes: [],
      inputs: [
        inputContract({
          contractId: "00amulet",
          template: "Splice.Amulet:Amulet",
          argument: vRecord([{ label: "owner", value: vParty(PROVIDER) }]),
          signatories: [DSO, PROVIDER],
        }),
      ],
    });
    expect(() => assertPreparedTransferMatches(b64, EXPECT)).toThrow(/unexpected part/);
  });
});

/** Root injection helper: put the provider inside the transfer record itself. */
function buildRootInjected(): string {
  const rootArg = choiceArgument(OK, [{ label: "observers", value: vParty(PROVIDER) }]);
  const root = exerciseNode({
    nodeId: "0",
    choiceId: "TransferFactory_Transfer",
    contractId: "00factory",
    template: "Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules",
    chosenValue: rootArg,
    children: ["1"],
  });
  const damlTx = Buffer.concat([str(1, "2.1"), str(2, "0"), len(3, root), len(3, honestDelivery)]);
  const metadata = Buffer.concat([
    len(2, Buffer.concat([str(1, SENDER), str(2, "cmd-1")])),
    str(3, "sync::1220ffff"),
    len(7, honestPreapprovalInput),
  ]);
  return Buffer.concat([len(1, damlTx), len(2, metadata)]).toString("base64");
}
