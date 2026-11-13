/** A page clock anchored to the server's time at render. */
export interface AnchoredClock {
  /** Estimated server time now (unix ms). */
  now(): number;
  /** Whether the anchor is still trustworthy. */
  health(): ClockHealth;
}

/** Anchor state: `ok`, or why the page must reload or refuse. */
export type ClockHealth = "ok" | "stale" | "drift" | "server_ahead";

/** Older anchors are refreshed by reloading the page. */
export const ANCHOR_MAX_AGE_MS = 30 * 60_000;
/** Wall vs monotonic disagreement that indicates sleep/suspend. */
export const ANCHOR_MAX_DRIFT_MS = 30_000;
/** A server clock this far ahead of the device is refused. */
export const SERVER_AHEAD_LIMIT_MS = 300_000;

/** Inputs for {@link createAnchoredClock}; injectable for tests. */
export interface AnchorInputs {
  serverTimeMs: number;
  perfNow?: () => number;
  wallNow?: () => number;
}

/**
 * Creates a clock that estimates the server's time as `serverTimeMs` plus the
 * monotonic time elapsed since the page loaded. The browser's own wall clock
 * is only used to detect sleep and a server claiming a far-future time (which
 * would let a payee collect a long-lived signed payment).
 *
 * @param inputs - Server time and clock sources.
 * @returns The anchored clock.
 */
export function createAnchoredClock(inputs: AnchorInputs): AnchoredClock {
  const perfNow = inputs.perfNow ?? (() => performance.now());
  const wallNow = inputs.wallNow ?? (() => Date.now());
  const perf0 = perfNow();
  const wall0 = wallNow();
  return {
    now: () => inputs.serverTimeMs + (perfNow() - perf0),
    health: () => {
      if (inputs.serverTimeMs > wall0 + SERVER_AHEAD_LIMIT_MS) return "server_ahead";
      const perfElapsed = perfNow() - perf0;
      if (perfElapsed > ANCHOR_MAX_AGE_MS) return "stale";
      if (Math.abs(wallNow() - wall0 - perfElapsed) > ANCHOR_MAX_DRIFT_MS) return "drift";
      return "ok";
    },
  };
}
