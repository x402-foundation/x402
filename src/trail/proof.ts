import { createHash } from "crypto";
import type { TrailPayload, TrailRecord, TrailScope } from "../../types/trail_record.js";

/**
 * Compute the action_ref from agent action parameters.
 *
 * action_ref = SHA-256(agent_id || action_type || scope_json || timestamp_ms)
 */
export function computeActionRef(params: {
  agent_id: string;
  action_type: string;
  scope: TrailScope;
  timestamp_ms: number;
}): string {
  const scopeJson = JSON.stringify(params.scope, Object.keys(params.scope).sort());
  const raw = params.agent_id + params.action_type + scopeJson + params.timestamp_ms;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Compute the evidence_hash for a trail payload.
 */
export function computeEvidenceHash(payload: TrailPayload): string {
  const sorted = Object.fromEntries(
    Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Build a complete TrailRecord from settlement and action parameters.
 */
export function buildTrailRecord(params: {
  payment_hash: string;
  agent_id: string;
  action_type: string;
  scope: TrailScope;
  timestamp_ms: number;
  anchor_id: string;
  anchor_type: "sigstore_rekor" | "on_chain";
  anchor_data: Record<string, unknown>;
  signature: string;
  signer_id: string;
}): TrailRecord {
  const action_ref = computeActionRef({
    agent_id: params.agent_id,
    action_type: params.action_type,
    scope: params.scope,
    timestamp_ms: params.timestamp_ms,
  });

  const payload: TrailPayload = {
    payment_hash: params.payment_hash,
    action_ref,
    agent_id: params.agent_id,
    action_type: params.action_type,
    scope: params.scope,
    timestamp_ms: params.timestamp_ms,
  };

  const evidence_hash = computeEvidenceHash(payload);

  return {
    payment_hash: params.payment_hash,
    action_ref,
    agent_id: params.agent_id,
    action_type: params.action_type,
    scope: params.scope,
    timestamp_ms: params.timestamp_ms,
    anchor_id: params.anchor_id,
    anchor_type: params.anchor_type,
    anchor_data: params.anchor_data,
    evidence_hash,
    created_at: new Date(params.timestamp_ms).toISOString(),
  };
}

/**
 * Verify that a TrailRecord's evidence_hash matches its contents.
 */
export function verifyTrailEvidence(record: TrailRecord): boolean {
  const payload: TrailPayload = {
    payment_hash: record.payment_hash,
    action_ref: record.action_ref,
    agent_id: record.agent_id,
    action_type: record.action_type,
    scope: record.scope,
    timestamp_ms: record.timestamp_ms,
  };
  return computeEvidenceHash(payload) === record.evidence_hash;
}

/**
 * Verify the action_ref is correctly derived from record fields.
 */
export function verifyActionRef(record: TrailRecord): boolean {
  const expected = computeActionRef({
    agent_id: record.agent_id,
    action_type: record.action_type,
    scope: record.scope,
    timestamp_ms: record.timestamp_ms,
  });
  return expected === record.action_ref;
}

/**
 * Derive the action_ref from a payment_hash and action parameters.
 * Used to look up trail records given settlement proof.
 */
export function deriveActionRef(params: {
  payment_hash: string;
  agent_id: string;
  action_type: string;
  scope: TrailScope;
  timestamp_ms: number;
}): { payment_hash: string; action_ref: string } {
  return {
    payment_hash,
    action_ref: computeActionRef({
      agent_id: params.agent_id,
      action_type: params.action_type,
      scope: params.scope,
      timestamp_ms: params.timestamp_ms,
    }),
  };
}
