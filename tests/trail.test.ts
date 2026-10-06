import { describe, it, expect } from "vitest";
import {
  buildTrailRecord,
  computeActionRef,
  computeEvidenceHash,
  deriveActionRef,
  verifyActionRef,
  verifyTrailEvidence,
} from "../src/trail/proof.js";
import { TrailStore } from "../src/trail/store.js";
import type { TrailRecord } from "../types/trail_record.js";

describe("TrailRecord", () => {
  const baseParams = {
    payment_hash: "abc123def456",
    agent_id: "agent-001",
    action_type: "tool_call",
    scope: { model: "claude-sonnet-4-20250514", max_tokens: "4096" },
    timestamp_ms: 1735689600000,
    anchor_id: "rekor-uuid-12345",
    anchor_type: "sigstore_rekor" as const,
    anchor_data: { bundlePath: "entry.json" },
    signature: "sig_xyz",
    signer_id: "agent-001",
  };

  it("computes deterministic action_ref", () => {
    const ref1 = computeActionRef({
      agent_id: baseParams.agent_id,
      action_type: baseParams.action_type,
      scope: baseParams.scope,
      timestamp_ms: baseParams.timestamp_ms,
    });
    const ref2 = computeActionRef({
      agent_id: baseParams.agent_id,
      action_type: baseParams.action_type,
      scope: baseParams.scope,
      timestamp_ms: baseParams.timestamp_ms,
    });
    expect(ref1).toBe(ref2);
    expect(ref1).toHaveLength(64);
  });

  it("derives different action_refs for different scopes", () => {
    const ref1 = computeActionRef({
      ...baseParams,
      scope: { model: "claude-sonnet-4-20250514" },
    });
    const ref2 = computeActionRef({
      ...baseParams,
      scope: { model: "gpt-4o" },
    });
    expect(ref1).not.toBe(ref2);
  });

  it("builds a valid trail record", () => {
    const record = buildTrailRecord(baseParams);
    expect(record.payment_hash).toBe(baseParams.payment_hash);
    expect(record.action_ref).toBe(
      computeActionRef({
        agent_id: baseParams.agent_id,
        action_type: baseParams.action_type,
        scope: baseParams.scope,
        timestamp_ms: baseParams.timestamp_ms,
      })
    );
    expect(record.anchor_id).toBe(baseParams.anchor_id);
    expect(record.anchor_type).toBe("sigstore_rekor");
    expect(verifyTrailEvidence(record)).toBe(true);
    expect(verifyActionRef(record)).toBe(true);
  });

  it("detects tampered evidence_hash", () => {
    const record = buildTrailRecord(baseParams);
    const tampered: TrailRecord = { ...record, evidence_hash: "tampered" };
    expect(verifyTrailEvidence(tampered)).toBe(false);
  });

  it("detects tampered action_ref", () => {
    const record = buildTrailRecord(baseParams);
    const tampered: TrailRecord = { ...record, action_ref: "tampered" };
    expect(verifyActionRef(tampered)).toBe(false);
  });

  it("stores and retrieves from TrailStore", () => {
    const store = new TrailStore();
    const record = buildTrailRecord(baseParams);
    expect(store.store(record)).toBe(true);

    const retrieved = store.get(record.payment_hash, record.action_ref);
    expect(retrieved).toBeDefined();
    expect(retrieved?.agent_id).toBe(baseParams.agent_id);

    const result = store.verify(record.payment_hash, record.action_ref);
    expect(result.exists).toBe(true);
    expect(result.valid).toBe(true);
  });

  it("rejects tampered records in store", () => {
    const store = new TrailStore();
    const record = buildTrailRecord(baseParams);
    record.evidence_hash = "invalid";
    expect(store.store(record)).toBe(false);
  });

  it("derives action_ref for lookup", () => {
    const { payment_hash, action_ref } = deriveActionRef({
      payment_hash: baseParams.payment_hash,
      agent_id: baseParams.agent_id,
      action_type: baseParams.action_type,
      scope: baseParams.scope,
      timestamp_ms: baseParams.timestamp_ms,
    });
    expect(payment_hash).toBe(baseParams.payment_hash);
    expect(action_ref).toBe(computeActionRef({
      agent_id: baseParams.agent_id,
      action_type: baseParams.action_type,
      scope: baseParams.scope,
      timestamp_ms: baseParams.timestamp_ms,
    }));
  });

  it("lists all records for a payment_hash", () => {
    const store = new TrailStore();
    const record1 = buildTrailRecord(baseParams);
    const record2 = buildTrailRecord({
      ...baseParams,
      action_type: "response",
      timestamp_ms: 1735689700000,
      anchor_id: "rekor-uuid-67890",
    });
    store.store(record1);
    store.store(record2);

    const byPayment = store.getByPaymentHash(baseParams.payment_hash);
    expect(byPayment).toHaveLength(2);
  });
});
