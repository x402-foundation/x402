import { describe, it, expect } from "vitest";
import { ErrSettlementPending } from "../../src/exact/facilitator/errors";

// The transport layer (@x402/core http, and the Go/Python servers) hardcodes the wire
// literal "settlement_pending" for its failure-transaction sanitizer, mirrored to avoid a
// core -> mechanisms import. This pins the mechanism's canonical constant to that exact
// literal so the two cannot drift; if they did, the sanitizer would strip the broadcast
// hash off a genuinely pending settlement (or leak it for a terminal failure).
describe("ErrSettlementPending wire contract", () => {
  it("equals the settlement_pending wire literal the transport layers mirror", () => {
    expect(ErrSettlementPending).toBe("settlement_pending");
  });
});
