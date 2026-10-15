/**
 * External Verifier Contract v1 Host
 *
 * A minimal, dependency-free host for the External Verifier Contract v1: it
 * spawns a configured verifier subprocess, writes exactly one JSON request to
 * its stdin, reads exactly one closed verdict from its stdout, and fails
 * closed on every abnormal path with the failure class the contract's
 * host-conformance suite asserts. Contract:
 * https://github.com/bolyra/bolyra/blob/main/spec/external-verifier-contract-v1.md
 * Conformance: `npx @bolyra/evc-conformance --host "<command>"`.
 */

import { spawn } from "node:child_process";
import { EVC_DENIAL_CODES, EVC_VERIFIER_KINDS } from "./types";
import type { CommandVerifierOptions, EvcDecision, EvcNonceEntry } from "./types";
import { DEFAULT_VERIFIER_MAX_STDOUT_BYTES, DEFAULT_VERIFIER_TIMEOUT_MS } from "./types";

interface ClosedAllow {
  verdict: "allow";
  kind?: string;
  consume_nonces?: EvcNonceEntry[];
}

interface ClosedDeny {
  verdict: "deny";
  kind?: string;
  code: string;
  message: string;
  detail?: unknown;
}

/**
 * Spawn the verifier for one request and return the host's closed decision.
 * Never throws for verifier misbehavior: every abnormal path is a fail-closed
 * deny carrying the detected failure class, classified in the contract's
 * precedence order (the host's own kills first, then unsolicited signal
 * death, then non-zero exit, then the stdout parse and schema checks).
 *
 * @param request - The verifier request object, serialized as one JSON document
 * @param options - Verifier command and host-enforced bounds
 * @param reserveNonces - Reserve-before-act callback for allow verdicts carrying `consume_nonces`
 * @returns The closed decision: allow, a relayed verifier deny code, or a fail-closed class
 */
export function runEvcVerifier(
  request: unknown,
  options: CommandVerifierOptions,
  reserveNonces?: (entries: EvcNonceEntry[]) => boolean | Promise<boolean>,
): Promise<EvcDecision> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_VERIFIER_MAX_STDOUT_BYTES;
  const [command, ...args] = options.command;
  if (!command) {
    return Promise.resolve({ decision: "deny", failureClass: "spawn_error" });
  }

  return new Promise(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
    } catch {
      resolve({ decision: "deny", failureClass: "spawn_error" });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    /**
     * Resolve the decision exactly once and stop the timeout timer.
     *
     * @param decision - The final closed decision for this run
     */
    const finish = (decision: EvcDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(decision);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.once("error", () => finish({ decision: "deny", failureClass: "spawn_error" }));

    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxStdoutBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });

    child.once("close", (code, signal) => {
      void (async () => {
        if (settled) return;
        if (overflow) return finish({ decision: "deny", failureClass: "oversize_stdout" });
        if (timedOut) return finish({ decision: "deny", failureClass: "timeout" });
        if (signal !== null) return finish({ decision: "deny", failureClass: "signal_death" });
        if (code !== 0) return finish({ decision: "deny", failureClass: "nonzero_exit" });

        const parsed = parseSingleObject(Buffer.concat(chunks).toString("utf8"));
        if ("failureClass" in parsed) {
          return finish({ decision: "deny", failureClass: parsed.failureClass });
        }
        const verdict = parsed.value;
        if (!isClosedVerdict(verdict)) {
          return finish({ decision: "deny", failureClass: "schema_invalid" });
        }
        if (verdict.verdict === "deny") {
          return finish({ decision: "deny", code: verdict.code });
        }
        if (Array.isArray(verdict.consume_nonces)) {
          if (!reserveNonces) {
            return finish({ decision: "deny", failureClass: "replay" });
          }
          try {
            const novel = await reserveNonces(verdict.consume_nonces);
            if (!novel) return finish({ decision: "deny", failureClass: "replay" });
          } catch {
            return finish({ decision: "deny", failureClass: "replay" });
          }
        }
        return finish({ decision: "allow" });
      })();
    });

    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}

/**
 * Parse verifier stdout as exactly one JSON value with no surrounding bytes.
 * A concatenated JSON stream classifies as `multiple_objects`; every other
 * non-conforming shape classifies as `unparseable_stdout`.
 *
 * @param raw - The verifier's complete stdout as UTF-8 text
 * @returns The parsed value, or the failure class the host must report
 */
function parseSingleObject(
  raw: string,
): { value: unknown } | { failureClass: "unparseable_stdout" | "multiple_objects" } {
  const s = raw.trim();
  if (s === "" || (s[0] !== "{" && s[0] !== "[")) {
    return { failureClass: "unparseable_stdout" };
  }
  const end = firstValueEnd(s);
  if (end < 0) return { failureClass: "unparseable_stdout" };
  let first: unknown;
  try {
    first = JSON.parse(s.slice(0, end));
  } catch {
    return { failureClass: "unparseable_stdout" };
  }
  const rest = s.slice(end).trim();
  if (rest === "") return { value: first };
  if (rest[0] === "{" || rest[0] === "[") return { failureClass: "multiple_objects" };
  return { failureClass: "unparseable_stdout" };
}

/**
 * Find the end index of the first balanced top-level JSON value, honoring
 * string escapes.
 *
 * @param s - Trimmed candidate JSON text starting with `{` or `[`
 * @returns Index one past the value's closing bracket, or -1 when unbalanced
 */
function firstValueEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Validate the contract's closed verdict schema: an allow carries only
 * `verdict`, `kind?`, and `consume_nonces?`; a deny carries only `verdict`,
 * `kind?`, `code`, `message`, and `detail?`. The deny `code` is closed over
 * the contract's denial-code registry, so an out-of-registry code fails the
 * schema and is never relayed.
 *
 * @param value - The parsed stdout value
 * @returns Whether the value is a schema-valid verdict
 */
function isClosedVerdict(value: unknown): value is ClosedAllow | ClosedDeny {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== undefined && !EVC_VERIFIER_KINDS.has(String(record.kind))) return false;

  if (record.verdict === "allow") {
    if (!Object.keys(record).every(key => ["verdict", "kind", "consume_nonces"].includes(key))) {
      return false;
    }
    if (record.consume_nonces === undefined) return true;
    return (
      Array.isArray(record.consume_nonces) &&
      record.consume_nonces.length > 0 &&
      record.consume_nonces.every(isNonceEntry)
    );
  }

  if (record.verdict === "deny") {
    return (
      Object.keys(record).every(key =>
        ["verdict", "kind", "code", "message", "detail"].includes(key),
      ) &&
      typeof record.code === "string" &&
      EVC_DENIAL_CODES.has(record.code) &&
      typeof record.message === "string" &&
      (record.detail === undefined ||
        (typeof record.detail === "object" &&
          record.detail !== null &&
          !Array.isArray(record.detail)))
    );
  }

  return false;
}

/**
 * Validate one `consume_nonces` entry: exactly the three contract fields.
 *
 * @param value - Candidate entry
 * @returns Whether the entry is schema-valid
 */
function isNonceEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.issuer_key === "string" &&
    typeof record.nonce === "string" &&
    Number.isInteger(record.retain_until)
  );
}
