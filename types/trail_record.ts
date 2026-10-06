/**
 * TrailRecord: Post-Settlement Accountability Layer
 *
 * Provides tamper-evident proof of an agent's action after payment settlement,
 * enabling independent third-party verification without trusting the operator's
 * infrastructure.
 */

export type AnchorType = "sigstore_rekor" | "on_chain";

export interface TrailScope {
  [key: string]: string;
}

export interface TrailRecord {
  /** SHA-256 hash of the x402 settlement proof */
  payment_hash: string;

  /** SHA-256(agent_id || action_type || scope_json || timestamp_ms) */
  action_ref: string;

  /** Unique identifier of the agent that performed the action */
  agent_id: string;

  /** Type of action performed (e.g., "tool_call", "response", "decision") */
  action_type: string;

  /** Authorized scope of the action */
  scope: TrailScope;

  /** Millisecond timestamp when the action was recorded */
  timestamp_ms: number;

  /** External anchor identifier (Sigstore Rekor UUID or on-chain tx hash) */
  anchor_id: string;

  /** Type of external anchor used */
  anchor_type: AnchorType;

  /** Additional anchor verification data */
  anchor_data: Record<string, unknown>;

  /** SHA-256 hash of the signed trail payload */
  evidence_hash: string;

  /** ISO 8601 timestamp of record creation */
  created_at: string;
}

export interface TrailPayload {
  payment_hash: string;
  action_ref: string;
  agent_id: string;
  action_type: string;
  scope: TrailScope;
  timestamp_ms: number;
}

export interface TrailSignature {
  payload: TrailPayload;
  signature: string;
  signer_id: string;
}
