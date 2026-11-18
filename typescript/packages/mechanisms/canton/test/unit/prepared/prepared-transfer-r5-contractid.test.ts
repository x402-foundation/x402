/**
 * ROUND-5 C2 ADVERSARY suite — Exercise.contract_id pinning (defense-in-depth).
 *
 * The round-4 all-nodes party backstop already CONTAINS a contract-id swap (a
 * redirect needs a consequence Create owned by a foreign party, which the
 * backstop rejects — see verify-prepared-r5-bypass.test.ts C2). This suite adds
 * the explicit, OPT-IN pin the finding asks for: when the caller knows the exact
 * contract the exercise must target (e.g. the factory/EPAR cid it built the
 * command against), the verifier pins Exercise.contract_id to it and fails
 * closed on any divergence — closing the resolve→prepare TOCTOU where a relay
 * resolves one contract to the agent but prepares the exercise against another.
 *
 * No pin supplied ⇒ unchanged behaviour (the backstop still contains redirects).
 * Covers BOTH arms: cip56 TransferFactory_Transfer and v1 CreateTransferCommand.
 */
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "../../../src/prepared-transfer.js";
import { str, len, vintField, choiceArgument, type TransferOpts } from "./prepared-fixture.js";

const SENDER = "agent::1220abcd";
const RECEIVER = "merchant::1220beef";
const DSO = "dso.global::nonhexNS99";

/** Build a single-exercise prepared tx with a CHOSEN contract_id (field 2). */
function preparedWithCid(choiceId: string, chosen: Buffer, contractId: string): string {
  const exercise = Buffer.concat([
    str(1 /* lf_version */, "2.1"),
    str(2 /* contract_id */, contractId),
    str(9 /* choice_id */, choiceId),
    len(10 /* chosen_value */, chosen),
    vintField(11 /* consuming */, 1),
  ]);
  const node = Buffer.concat([
    str(1 /* node_id */, "0"),
    len(1000 /* DamlTransaction.Node.v1 */, len(3 /* v1.Node.exercise */, exercise)),
  ]);
  const damlTx = Buffer.concat([
    str(1 /* version */, "2.1"),
    str(2 /* roots */, "0"),
    len(3 /* DamlTransaction.nodes */, node),
  ]);
  const submitterInfo = Buffer.concat([str(1 /* act_as */, SENDER), str(2 /* command_id */, "c")]);
  const metadata = Buffer.concat([
    len(2 /* submitter_info */, submitterInfo),
    str(3 /* synchronizer_id */, "sync::1220aaaa"),
  ]);
  return Buffer.concat([
    len(1 /* PreparedTransaction.transaction */, damlTx),
    len(2 /* PreparedTransaction.metadata */, metadata),
  ]).toString("base64");
}

const transferOpts: TransferOpts = {
  sender: SENDER,
  receiver: RECEIVER,
  amount: "1.0",
  admin: DSO,
  id: "Amulet",
};
const transferExpect: PreparedTransferExpectation = {
  sender: SENDER,
  receiver: RECEIVER,
  amount: "1.0",
  instrumentId: "Amulet",
  nowMs: Date.now(),
};

describe("C2 cip56: Exercise.contract_id pin (opt-in, fail-closed)", () => {
  const chosen = choiceArgument(transferOpts);

  it("ACCEPTS when no expectedContractId is supplied (unchanged behaviour)", () => {
    const bytes = preparedWithCid("TransferFactory_Transfer", chosen, "00relayCidWhatever");
    expect(() => assertPreparedTransferMatches(bytes, transferExpect)).not.toThrow();
  });

  it("ACCEPTS when the prepared contract_id matches the caller's expected cid", () => {
    const bytes = preparedWithCid("TransferFactory_Transfer", chosen, "00factoryAbc");
    expect(() =>
      assertPreparedTransferMatches(bytes, {
        ...transferExpect,
        expectedContractId: "00factoryAbc",
      }),
    ).not.toThrow();
  });

  it("REJECTS when the prepared contract_id differs from the expected cid (TOCTOU swap)", () => {
    const bytes = preparedWithCid("TransferFactory_Transfer", chosen, "00attackerFactory");
    expect(() =>
      assertPreparedTransferMatches(bytes, {
        ...transferExpect,
        expectedContractId: "00factoryAbc",
      }),
    ).toThrow(PreparedTransferMismatchError);
  });
});
