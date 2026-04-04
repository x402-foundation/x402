import { Network } from "../types";

/**
 * Scheme data structure for facilitator storage
 */
export interface SchemeData<T> {
  facilitator: T;
  networks: Set<Network>;
  pattern: Network;
}

export const findSchemesByNetwork = <T>(
  map: Map<string, Map<string, T>>,
  network: Network,
): Map<string, T> | undefined => {
  // Direct match first
  let implementationsByScheme = map.get(network);

  if (!implementationsByScheme) {
    // Try pattern matching for registered network patterns
    for (const [registeredNetworkPattern, implementations] of map.entries()) {
      // Convert the registered network pattern to a regex
      // e.g., "eip155:*" becomes /^eip155:.*$/
      const pattern = registeredNetworkPattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&") // Escape special regex chars except *
        .replace(/\\\*/g, ".*"); // Replace escaped * with .*

      const regex = new RegExp(`^${pattern}$`);

      if (regex.test(network)) {
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
  const patternRegex = new RegExp("^" + schemeData.pattern.replace("*", ".*") + "$");
  if (patternRegex.test(network)) {
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
 * Recursively compares objects with key-order independence
 *
 * @param obj1 - First object to compare
 * @param obj2 - Second object to compare
 * @returns True if objects are deeply equal
 */
export function deepEqual(obj1: unknown, obj2: unknown): boolean {
  if (obj1 === obj2) return true;
  if (obj1 === null || obj2 === null) return false;
  if (obj1 === undefined || obj2 === undefined) return false;
  if (typeof obj1 !== typeof obj2) return false;
  if (typeof obj1 !== "object") return false;

  if (Array.isArray(obj1)) {
    if (!Array.isArray(obj2)) return false;
    if (obj1.length !== obj2.length) return false;
    return obj1.every((item, i) => deepEqual(item, obj2[i]));
  }

  if (Array.isArray(obj2)) return false;

  const keys1 = Object.keys(obj1 as Record<string, unknown>);
  const keys2 = Object.keys(obj2 as Record<string, unknown>);
  if (keys1.length !== keys2.length) return false;

  return keys1.every(key => {
    if (!Object.prototype.hasOwnProperty.call(obj2, key)) return false;
    return deepEqual(
      (obj1 as Record<string, unknown>)[key],
      (obj2 as Record<string, unknown>)[key],
    );
  });
}
