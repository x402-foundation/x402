export {
  buildTrailRecord,
  computeActionRef,
  computeEvidenceHash,
  deriveActionRef,
  verifyActionRef,
  verifyTrailEvidence,
} from "./proof.js";

export { TrailStore } from "./store.js";

export type {
  AnchorType,
  TrailPayload,
  TrailRecord,
  TrailScope,
  TrailSignature,
} from "../../types/trail_record.js";
