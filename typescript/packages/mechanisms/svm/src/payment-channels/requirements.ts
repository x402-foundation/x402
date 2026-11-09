import type { PaymentRequirements } from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../constants";
import { getStablecoinTokenProgram, validateSvmAddress } from "../utils";

/**
 * Read `extra.tokenProgram`. An absent hint is unset so the caller can fall back.
 * A present hint that is not a supported program throws.
 *
 * @param extra - Payment requirements `extra`
 * @returns The hinted program, or undefined when unset
 */
export function parseTokenProgramHint(extra: PaymentRequirements["extra"]): string | undefined {
  const hint = extra?.tokenProgram;
  if (hint === undefined || hint === null || hint === "") {
    return undefined;
  }
  if (typeof hint !== "string" || !validateSvmAddress(hint)) {
    throw new Error(`extra.tokenProgram ${String(hint)} is not a valid base58 address`);
  }
  if (hint !== TOKEN_PROGRAM_ADDRESS && hint !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new Error(`extra.tokenProgram ${hint} is not a supported SPL token program`);
  }
  return hint;
}

/**
 * Hinted token program, or the stablecoin registry when the hint is absent.
 *
 * @param requirements - Payment requirements being paid
 * @returns Token program address
 */
export function resolveTokenProgram(requirements: PaymentRequirements): string {
  return (
    parseTokenProgramHint(requirements.extra) ??
    getStablecoinTokenProgram(requirements.asset, requirements.network)
  );
}

/**
 * Seller memo from `extra.memo`. Empty and non-string are unset, so both roles
 * agree on whether a memo was requested.
 *
 * @param extra - Payment requirements `extra`
 * @returns The requested memo, or undefined when unset
 */
export function resolveUptoSvmMemo(extra: PaymentRequirements["extra"]): string | undefined {
  const memo = extra?.memo;
  return typeof memo === "string" && memo !== "" ? memo : undefined;
}

/**
 * `parseTokenProgramHint`, with every missing or rejected hint thrown as `invalid`.
 * Batch requires the hint; upto treats a missing hint as unset.
 *
 * @param extra - Payment requirements `extra`
 * @param invalid - Error message for a missing or rejected hint
 * @returns Supported token program address
 */
export function requireTokenProgramHint(
  extra: PaymentRequirements["extra"],
  invalid: string,
): string {
  let hinted: string | undefined;
  try {
    hinted = parseTokenProgramHint(extra);
  } catch {
    hinted = undefined;
  }
  if (hinted === undefined) throw new Error(invalid);
  return hinted;
}
