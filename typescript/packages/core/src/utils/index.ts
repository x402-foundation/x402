import { Money, Network } from "../types";

/**
 * Converts a JavaScript number to a plain decimal string, expanding scientific notation
 * via string manipulation rather than parseFloat round-tripping.
 *
 * e.g. 1e-7 → "0.0000001", 4.02 → "4.02"
 *
 * @param n - The number to convert
 * @returns A plain decimal string representation with no scientific notation
 */
export function numberToDecimalString(n: number): string {
  const str = n.toString();
  if (!/[eE]/.test(str)) return str;

  const [significand, exponentStr] = str.split(/[eE]/);
  const exp = parseInt(exponentStr, 10);
  const negative = significand.startsWith("-");
  const abs = negative ? significand.slice(1) : significand;
  const [intDigits, fracDigits = ""] = abs.split(".");
  const allDigits = intDigits + fracDigits;
  const decimalPos = intDigits.length + exp;

  let result: string;
  if (decimalPos <= 0) {
    result = "0." + "0".repeat(-decimalPos) + allDigits;
  } else if (decimalPos >= allDigits.length) {
    result = allDigits + "0".repeat(decimalPos - allDigits.length);
  } else {
    result = allDigits.slice(0, decimalPos) + "." + allDigits.slice(decimalPos);
  }
  return (negative ? "-" : "") + result;
}

/**
 * Parses a money string into a finite, non-negative decimal string.
 * Accepts plain decimal strings with an optional leading dollar sign.
 * Rejects ticker suffixes — use {@link parseMoney} when a symbol may be present.
 *
 * @param money - The money string to parse
 * @returns The cleaned decimal substring (no `$`, no ticker)
 */
export function parseMoneyString(money: string): string {
  const cleaned = money.replace(/^\$/, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned) || /[eE]/.test(cleaned)) {
    throw new Error(`Invalid money format: ${money}`);
  }
  return cleaned;
}

/**
 * Parse money into `{ amount, symbol? }`. `"1.50 USDT"` → symbol; `"1.50 USD"`
 * and bare amounts have none. Glued tickers (`"1.50USDT"`) are rejected.
 *
 * String prices keep the extracted decimal substring. Number prices are
 * stringified once via {@link numberToDecimalString}; digits already lost in
 * the caller's `number` stay lost.
 *
 * @param money - Money value (string or number)
 * @returns Parsed decimal-string amount and optional uppercase ticker
 */
export function parseMoney(money: Money): { amount: string; symbol?: string } {
  if (typeof money === "number") {
    if (!Number.isFinite(money) || money < 0) {
      throw new Error(`Invalid money format: ${money}`);
    }
    return { amount: numberToDecimalString(money) };
  }

  const trimmed = money.trim();
  const match = trimmed.match(/^\$?\s*(-?\d+(?:\.\d+)?)(?:\s+([A-Za-z][A-Za-z0-9.]*))?$/);
  if (!match) {
    throw new Error(`Invalid money format: ${money}`);
  }

  const amount = parseMoneyString(match[1]);
  const rawSymbol = match[2];
  if (!rawSymbol || rawSymbol.toUpperCase() === "USD") {
    return { amount };
  }
  return { amount, symbol: rawSymbol.toUpperCase() };
}

/**
 * Convert a decimal amount to token smallest units.
 * Accepts only plain decimal strings — scientific notation is not allowed.
 * Pads or truncates toward zero, including to `"0"`. Does not round.
 *
 * @param decimalAmount - The decimal amount as a plain string (e.g., "0.10")
 * @param decimals - The number of decimals for the token (e.g., 6 for USDC)
 * @returns The amount in smallest units as a string
 */
export function convertToTokenAmount(decimalAmount: string, decimals: number): string {
  if (/[eE]/.test(decimalAmount)) {
    throw new Error(
      `Invalid amount: ${decimalAmount} — use decimal notation, not scientific notation`,
    );
  }
  if (!isPlainDecimalAmount(decimalAmount)) {
    throw new Error(`Invalid amount: ${decimalAmount}`);
  }
  const [intPart, decPart = ""] = decimalAmount.split(".");
  const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
  return (intPart + paddedDec).replace(/^0+/, "") || "0";
}

/**
 * Validates a plain decimal string with a linear scan to avoid regex backtracking.
 */
function isPlainDecimalAmount(decimalAmount: string): boolean {
  if (decimalAmount.length === 0) {
    return false;
  }

  let index = decimalAmount.startsWith("-") ? 1 : 0;
  if (index === decimalAmount.length) {
    return false;
  }

  let hasIntegerDigit = false;
  while (index < decimalAmount.length) {
    const charCode = decimalAmount.charCodeAt(index);
    if (charCode < 48 || charCode > 57) {
      break;
    }
    hasIntegerDigit = true;
    index++;
  }

  if (!hasIntegerDigit) {
    return false;
  }

  if (index === decimalAmount.length) {
    return true;
  }

  if (decimalAmount[index] !== ".") {
    return false;
  }

  index++;
  while (index < decimalAmount.length) {
    const charCode = decimalAmount.charCodeAt(index);
    if (charCode < 48 || charCode > 57) {
      return false;
    }
    index++;
  }

  return true;
}

/**
 * Scheme data structure for facilitator storage
 */
export interface SchemeData<T> {
  facilitator: T;
  networks: Set<Network>;
  pattern: Network;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const networkPatternToRegExp = (pattern: Network): RegExp => {
  const source = escapeRegExp(pattern).replace(/\\\*/g, ".*");
  return new RegExp(`^${source}$`);
};

export const networkMatchesPattern = (pattern: Network, network: Network): boolean => {
  return networkPatternToRegExp(pattern).test(network);
};

export const findSchemesByNetwork = <T>(
  map: Map<string, Map<string, T>>,
  network: Network,
): Map<string, T> | undefined => {
  // Direct match first
  let implementationsByScheme = map.get(network);

  if (!implementationsByScheme) {
    // Try pattern matching for registered network patterns
    for (const [registeredNetworkPattern, implementations] of map.entries()) {
      if (networkMatchesPattern(registeredNetworkPattern as Network, network)) {
        implementationsByScheme = implementations;
        break;
      }
    }
  }

  return implementationsByScheme;
};

export const findByNetworkAndScheme = <T>(
  map: Map<string, Map<string, T>>,
  scheme: string,
  network: Network,
): T | undefined => {
  return findSchemesByNetwork(map, network)?.get(scheme);
};

/**
 * Finds a facilitator by scheme and network using pattern matching.
 * Works with new SchemeData storage structure.
 *
 * @param schemeMap - Map of scheme names to SchemeData
 * @param scheme - The scheme to find
 * @param network - The network to match against
 * @returns The facilitator if found, undefined otherwise
 */
export const findFacilitatorBySchemeAndNetwork = <T>(
  schemeMap: Map<string, SchemeData<T>>,
  scheme: string,
  network: Network,
): T | undefined => {
  const schemeData = schemeMap.get(scheme);
  if (!schemeData) return undefined;

  // Check if network is in the stored networks set
  if (schemeData.networks.has(network)) {
    return schemeData.facilitator;
  }

  // Try pattern matching
  if (networkMatchesPattern(schemeData.pattern, network)) {
    return schemeData.facilitator;
  }

  return undefined;
};

export const Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Encodes a string to base64 format
 *
 * @param data - The string to be encoded to base64
 * @returns The base64 encoded string
 */
export function safeBase64Encode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.btoa === "function") {
    const bytes = new TextEncoder().encode(data);
    const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
    return globalThis.btoa(binaryString);
  }
  return Buffer.from(data, "utf8").toString("base64");
}

/**
 * Decodes a base64 string back to its original format
 *
 * @param data - The base64 encoded string to be decoded
 * @returns The decoded string in UTF-8 format
 */
export function safeBase64Decode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
    const binaryString = globalThis.atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(bytes);
  }
  return Buffer.from(data, "base64").toString("utf-8");
}

/**
 * Deep equality comparison for payment requirements
 * Uses a normalized JSON.stringify for consistent comparison
 *
 * @param obj1 - First object to compare
 * @param obj2 - Second object to compare
 * @returns True if objects are deeply equal
 */
export function deepEqual(obj1: unknown, obj2: unknown): boolean {
  // Normalize and stringify both objects for comparison
  // This handles nested objects, arrays, and different property orders
  const normalize = (obj: unknown): string => {
    // Handle primitives and null/undefined
    if (obj === null || obj === undefined) return JSON.stringify(obj);
    if (typeof obj !== "object") return JSON.stringify(obj);

    // Handle arrays
    if (Array.isArray(obj)) {
      return JSON.stringify(
        obj.map(item =>
          typeof item === "object" && item !== null ? JSON.parse(normalize(item)) : item,
        ),
      );
    }

    // Handle objects - sort keys and recursively normalize values
    const sorted: Record<string, unknown> = {};
    Object.keys(obj as Record<string, unknown>)
      .sort()
      .forEach(key => {
        const value = (obj as Record<string, unknown>)[key];
        sorted[key] =
          typeof value === "object" && value !== null ? JSON.parse(normalize(value)) : value;
      });
    return JSON.stringify(sorted);
  };

  try {
    return normalize(obj1) === normalize(obj2);
  } catch {
    // Fallback to simple comparison if normalization fails
    return JSON.stringify(obj1) === JSON.stringify(obj2);
  }
}

/**
 * Coerces a value for array-aware merging/comparison: an array passes through
 * unchanged, while a bare scalar is wrapped as a single-element array so it can
 * merge or compare against an array declared on the other side (e.g. an
 * extension field documented as "string or array of strings"). Returns
 * undefined for values that cannot participate (null, undefined, objects).
 *
 * @param value - Value to coerce
 * @returns The value as an array, or undefined if it cannot be treated as one
 */
export function toComparableArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined || typeof value === "object") {
    return undefined;
  }
  return [value];
}

/**
 * Extension info fields, keyed by extension key, where a conflicting array
 * value declared by both server and client is additive rather than exclusive:
 * the client's merge concatenates both sides (client first, deduped, see
 * `mergeArraysUnique`), and the server's echo validation accepts any echo that
 * is a superset of the advertised value. Scoped narrowly per field (rather
 * than making all array fields additive) so unrelated extensions - e.g.
 * sign-in-with-x's `resources` - keep exact array matching in both directions.
 */
export const ADDITIVE_ARRAY_INFO_FIELDS: Record<string, ReadonlySet<string>> = {
  "builder-code": new Set(["s"]),
};

/**
 * Extension info fields, keyed by extension key, that only the resource server
 * may declare. Clients MUST NOT invent these on echo; core cannot import
 * `@x402/extensions`, so the key/field list is duplicated here (same as
 * {@link ADDITIVE_ARRAY_INFO_FIELDS}).
 */
export const SERVER_OWNED_INFO_FIELDS: Record<string, ReadonlySet<string>> = {
  "builder-code": new Set(["a"]),
};

/**
 * Caps the combined echoed length of an additive array field (see
 * {@link ADDITIVE_ARRAY_INFO_FIELDS}) so a hand-crafted payload cannot pad the
 * field past the sum of every party's own reservation and later crowd out a
 * legitimately declared entry once truncated further downstream (e.g. by a
 * facilitator extension). Core has no dependency on extension packages, so
 * this value (builder-code's `MAX_CLIENT_SERVICE_CODES` +
 * `MAX_SERVER_SERVICE_CODES`) is duplicated from
 * `packages/extensions/src/builder-code/types.ts` and must be kept in sync by
 * hand.
 */
export const ADDITIVE_ARRAY_MAX_LENGTHS: Record<string, Record<string, number>> = {
  "builder-code": { s: 10 },
};
