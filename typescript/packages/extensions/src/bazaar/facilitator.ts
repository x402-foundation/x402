/**
 * Facilitator functions for validating and extracting Bazaar discovery extensions
 *
 * These functions help facilitators validate extension data against schemas
 * and extract the discovery information for cataloging in the Bazaar.
 *
 * Supports both v2 (extensions in PaymentRequired) and v1 (outputSchema in PaymentRequirements).
 */

import { domainToASCII } from "node:url";
import Ajv from "ajv/dist/2020.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  PaymentRequirementsV1,
  ResourceInfo,
} from "@x402/core/types";
import type { DiscoveryExtension, DiscoveryInfo } from "./types";
import type { McpDiscoveryInfo } from "./mcp/types";
import type { DiscoveredHTTPResource } from "./http/types";
import type { DiscoveredMCPResource } from "./mcp/types";
import { BAZAAR } from "./types";
import { extractDiscoveryInfoV1 } from "./v1/facilitator";

/**
 * Valid routeTemplate pattern: must start with "/", contain only safe URL path characters
 * and :param identifiers, and not include traversal sequences or scheme markers.
 *
 * Allowed: /users/:userId, /weather/:country/:city, /api/v1/items
 */
const ROUTE_TEMPLATE_REGEX = /^\/[a-zA-Z0-9_/:.\-~%]+$/;

/**
 * Checks whether a routeTemplate value is structurally valid.
 *
 * Expected format: "/:param" segments using colon-prefixed identifiers
 * (e.g. "/users/:userId", "/weather/:country/:city").
 *
 * The facilitator is a trust boundary: clients control the payment payload and
 * can modify routeTemplate before submission. A malicious value could cause the
 * facilitator to catalog the payment under an arbitrary URL (catalog poisoning).
 * This function enforces minimal structural requirements:
 * - Must be a non-empty string starting with "/"
 * - Must match the safe URL path character set (alphanumeric, _, :, /, ., -, ~, %)
 * - Must not contain ".." (path traversal)
 * - Must not contain "://" (URL injection)
 *
 * @param value - The raw routeTemplate string from the client payload
 * @returns true if the value is a valid routeTemplate, false otherwise
 *
 * @internal Exported for facilitator use.
 */
export function isValidRouteTemplate(value: string | undefined): value is string {
  if (!value) return false;
  if (!ROUTE_TEMPLATE_REGEX.test(value)) return false;
  // Decode percent-encoding before traversal checks so that %2e%2e is caught.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  if (decoded.includes("..")) return false;
  if (decoded.includes("://")) return false;
  return true;
}

/**
 * Validates a routeTemplate and returns it if valid, undefined otherwise.
 *
 * @param value - The raw routeTemplate string to validate
 * @returns The validated value, or undefined if invalid
 * @deprecated Use `isValidRouteTemplate` instead.
 */
export function validateRouteTemplate(value: string | undefined): string | undefined {
  return isValidRouteTemplate(value) ? value : undefined;
}

/**
 * Maximum lengths for resource service metadata fields. Spec: see
 * `specs/extensions/bazaar.md` "Service Metadata on `resource`".
 */
const MAX_SERVICE_NAME_LEN = 32;
const MAX_TAG_LEN = 32;
const MAX_TAGS = 5;
const MAX_ICON_URL_LEN = 2048;
// Matches ASCII control characters (C0 + DEL).
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f]/;
// Printable ASCII range (U+0020–U+007E). `serviceName` and `tags` are
// constrained to this range so that String.length (UTF-16 code units),
// len() in Python (code points), and len() in Go (UTF-8 bytes) all agree
// on the character count. Same convention as paymentidentifier.id.
const PRINTABLE_ASCII_REGEX = /^[\x20-\x7e]+$/;
// Unicode control characters (category Cc). Defense-in-depth: the printable
// ASCII regex already rejects every control character, but this explicit
// check documents intent and would survive any future relaxation of the
// ASCII restriction. Mirrors `unicode.IsControl` (Go).
const UNICODE_CONTROL_REGEX = /\p{Cc}/u;

// Loopback hostnames that must be rejected for SSRF defense. Includes the
// common /etc/hosts aliases on Linux/macOS (`localhost.localdomain`,
// `ip6-localhost`, `ip6-loopback`) — without these, a hostile provider could
// route the facilitator's image fetcher to its own loopback interface.
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);
// Matches a bare IPv4 dotted-quad. IPv6 literals are detected via hostname brackets.
const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// SSRF defense: any all-digit hostname is suspect because no legitimate DNS name
// is purely numeric. Catches decimal-encoded IPs (`http://2130706433/` → 127.0.0.1)
// and short-form IPs (`http://0/` → 0.0.0.0, treated as loopback on Linux).
const ALL_DIGITS_REGEX = /^\d+$/;
// SSRF defense: hex-encoded IPs (`http://0x7f000001/` → 127.0.0.1) — same family
// of bypasses as the decimal form above.
const HEX_LITERAL_REGEX = /^0x[0-9a-f]+$/i;

/**
 * Checks whether a serviceName value is structurally valid for the bazaar
 * `resource.serviceName` field. Non-empty string of printable ASCII
 * (U+0020–U+007E), length ≤ 32.
 *
 * The ASCII restriction matches the `paymentidentifier.id` convention and
 * keeps `len()` semantics identical across TS / Python / Go.
 *
 * Mirrors `_is_valid_service_name` (Python) and `isValidServiceName` (Go).
 * All three implementations must stay in sync.
 *
 * @param value - The raw serviceName string from the resource object
 * @returns true if the value is a valid serviceName, false otherwise
 *
 * @internal Exported for facilitator use.
 */
export function isValidServiceName(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_SERVICE_NAME_LEN) return false;
  if (UNICODE_CONTROL_REGEX.test(value)) return false;
  if (!PRINTABLE_ASCII_REGEX.test(value)) return false;
  return true;
}

/**
 * Sanitizes a tags array for the bazaar `resource.tags` field. Drops entries
 * that are not non-empty printable-ASCII strings of at most 32 characters,
 * then truncates to the first 5 valid entries. Returns undefined when no
 * entries survive (so the field can be omitted from the catalog).
 *
 * The ASCII restriction matches the `paymentidentifier.id` convention and
 * keeps `len()` semantics identical across TS / Python / Go.
 *
 * Mirrors `_sanitize_tags` (Python) and `sanitizeTags` (Go).
 * All three implementations must stay in sync.
 *
 * @param value - The raw tags value from the resource object (typed as unknown
 *   because callers pass it directly from a parsed JSON payload)
 * @returns The sanitized tags array, or undefined if no entries survive
 *
 * @internal Exported for facilitator use.
 */
export function sanitizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  // Case-insensitive dedup: keeps the first occurrence's casing.
  // Prevents catalog noise like ["Weather", "weather", "WEATHER"].
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (entry.length === 0 || entry.length > MAX_TAG_LEN) continue;
    if (UNICODE_CONTROL_REGEX.test(entry)) continue;
    if (!PRINTABLE_ASCII_REGEX.test(entry)) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length === MAX_TAGS) break;
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Checks whether an iconUrl value is structurally safe for the bazaar
 * `resource.iconUrl` field.
 *
 * Rules (see `specs/extensions/bazaar.md` "Service Metadata on `resource`"):
 *   - String of length ≤ 2048
 *   - No ASCII control characters
 *   - Parses as an absolute http:// or https:// URL
 *   - No userinfo (user@host)
 *   - Host is IDN-normalized (UTS #46) before checks, so confusable
 *     full-width / Unicode forms (e.g. `ｌｏｃａｌｈｏｓｔ`) collapse to their
 *     ASCII canonical and get caught by the loopback check
 *   - Host is not an IP literal (v4 or v6), not in the loopback set
 *     (`localhost`, `localhost.localdomain`, `ip6-localhost`, `ip6-loopback`)
 *   - Host is not a decimal IP encoding (e.g. `2130706433` → 127.0.0.1) or
 *     hex literal (e.g. `0x7f000001`) — common SSRF bypass forms
 *
 * Percent-decoding is applied to the hostname before IDN normalization, and
 * IDN normalization runs before the IP / loopback checks (parallel to the
 * routeTemplate decoder).
 *
 * Mirrors `_is_valid_icon_url` (Python) and `isValidIconUrl` (Go).
 * All three implementations must stay in sync.
 *
 * @param value - The raw iconUrl string from the resource object
 * @returns true if the value is a structurally safe iconUrl, false otherwise
 *
 * @internal Exported for facilitator use.
 */
export function isValidIconUrl(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_ICON_URL_LEN) return false;
  if (CONTROL_CHAR_REGEX.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  // URL.hostname strips IPv6 brackets, so detect IPv6 from the bracketed host instead.
  if (parsed.host.startsWith("[")) return false;
  let hostname: string;
  try {
    hostname = decodeURIComponent(parsed.hostname);
  } catch {
    return false;
  }
  // IDN/full-width normalization: e.g. "ｌｏｃａｌｈｏｓｔ" (full-width Latin)
  // → "localhost". Without this the loopback alias check would miss
  // confusable Unicode hostnames. domainToASCII applies the same WHATWG /
  // UTS #46 mapping that idna.Lookup.ToASCII (Go) and idna.encode (Python)
  // use; returns "" on failure.
  const asciiHost = domainToASCII(hostname);
  if (asciiHost === "") return false;
  hostname = asciiHost.toLowerCase();
  if (hostname === "") return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false;
  if (IPV4_REGEX.test(hostname)) return false;
  if (ALL_DIGITS_REGEX.test(hostname)) return false;
  if (HEX_LITERAL_REGEX.test(hostname)) return false;
  return true;
}

/**
 * Sanitized service metadata extracted from a `resource` object.
 */
export interface SanitizedResourceServiceMetadata {
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/**
 * Applies the bazaar service-metadata validation rules to a `resource` object
 * and returns only the fields that survive. Missing or invalid fields are
 * dropped silently (soft-drop semantics — see spec).
 *
 * @param resource - The raw `resource` object from a PaymentRequired or
 *   PaymentPayload, or undefined.
 * @returns An object containing only the valid serviceName / tags / iconUrl.
 *
 * @internal Exported for facilitator use.
 */
export function sanitizeResourceServiceMetadata(
  resource: ResourceInfo | undefined | null,
): SanitizedResourceServiceMetadata {
  if (!resource) return {};
  const out: SanitizedResourceServiceMetadata = {};
  if (isValidServiceName(resource.serviceName)) {
    out.serviceName = resource.serviceName;
  }
  const tags = sanitizeTags(resource.tags);
  if (tags) {
    out.tags = tags;
  }
  if (isValidIconUrl(resource.iconUrl)) {
    out.iconUrl = resource.iconUrl;
  }
  return out;
}

/**
 * Validation result for discovery extensions
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Validates a discovery extension's info against its schema
 *
 * @param extension - The discovery extension containing info and schema
 * @returns Validation result indicating if the info matches the schema
 *
 * @example
 * ```typescript
 * const extension = declareDiscoveryExtension(...);
 * const result = validateDiscoveryExtension(extension);
 *
 * if (result.valid) {
 *   console.log("Extension is valid");
 * } else {
 *   console.error("Validation errors:", result.errors);
 * }
 * ```
 */
export function validateDiscoveryExtension(extension: DiscoveryExtension): ValidationResult {
  try {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(extension.schema);

    // The schema describes the structure of info directly
    // Schema has properties: { input: {...}, output: {...} }
    // So we validate extension.info which has { input: {...}, output: {...} }
    const valid = validate(extension.info);

    if (valid) {
      return { valid: true };
    }

    const errors = validate.errors?.map(err => {
      const path = err.instancePath || "(root)";
      return `${path}: ${err.message}`;
    }) || ["Unknown validation error"];

    return { valid: false, errors };
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/**
 * Extracts the discovery info from payment payload and requirements
 *
 * This function handles both v2 (extensions) and v1 (outputSchema) formats.
 *
 * For v2: Discovery info is in PaymentPayload.extensions (client copied it from PaymentRequired)
 * For v1: Discovery info is in PaymentRequirements.outputSchema
 *
 * V1 data is automatically transformed to v2 DiscoveryInfo format, making smart
 * assumptions about field names (queryParams/query/params for GET, bodyFields/body/data for POST, etc.)
 *
 * @param paymentPayload - The payment payload containing extensions (v2) and version info
 * @param paymentRequirements - The payment requirements (contains outputSchema for v1)
 * @param validate - Whether to validate v2 extensions before extracting (default: true)
 * @returns The discovery info in v2 format if present, or null if not discoverable
 *
 * @example
 * ```typescript
 * // V2 - extensions are in PaymentPayload
 * const info = extractDiscoveryInfo(paymentPayload, paymentRequirements);
 *
 * // V1 - discovery info is in PaymentRequirements.outputSchema
 * const info = extractDiscoveryInfo(paymentPayloadV1, paymentRequirementsV1);
 *
 * if (info) {
 *   // Both v1 and v2 return the same DiscoveryInfo structure
 *   console.log("Method:", info.input.method);
 * }
 * ```
 */
export type { DiscoveredHTTPResource } from "./http/types";
export type { DiscoveredMCPResource } from "./mcp/types";

export type DiscoveredResource = DiscoveredHTTPResource | DiscoveredMCPResource;

/**
 * Extracts discovery information from payment payload and requirements.
 * Combines resource URL, HTTP method, version, and discovery info into a single object.
 *
 * @param paymentPayload - The payment payload containing extensions and resource info
 * @param paymentRequirements - The payment requirements to validate against
 * @param validate - Whether to validate the discovery info against the schema (default: true)
 * @returns Discovered resource info with URL, method, version and discovery data, or null if not found
 */
export function extractDiscoveryInfo(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements | PaymentRequirementsV1,
  validate: boolean = true,
): DiscoveredResource | null {
  let discoveryInfo: DiscoveryInfo | null = null;
  let resourceUrl: string;

  let routeTemplate: string | undefined;

  if (paymentPayload.x402Version === 2) {
    resourceUrl = paymentPayload.resource?.url ?? "";

    if (paymentPayload.extensions) {
      const bazaarExtension = paymentPayload.extensions[BAZAAR.key];

      if (bazaarExtension && typeof bazaarExtension === "object") {
        try {
          // routeTemplate uses :param syntax (e.g. "/users/:userId", "/weather/:country/:city").
          // Must start with "/", must not contain ".." or "://".
          // Validate before use: the client controls this field in the payment payload.
          const rawExt = bazaarExtension as Record<string, unknown>;
          const rawTemplate =
            typeof rawExt.routeTemplate === "string" ? rawExt.routeTemplate : undefined;
          if (isValidRouteTemplate(rawTemplate)) {
            routeTemplate = rawTemplate;
          }
          const extension = bazaarExtension as DiscoveryExtension;

          if (validate) {
            const result = validateDiscoveryExtension(extension);
            if (!result.valid) {
              console.warn(
                `V2 discovery extension validation failed: ${result.errors?.join(", ")}`,
              );
            } else {
              discoveryInfo = extension.info;
            }
          } else {
            discoveryInfo = extension.info;
          }
        } catch (error) {
          console.warn(`V2 discovery extension extraction failed: ${error}`);
        }
      }
    }
  } else if (paymentPayload.x402Version === 1) {
    const requirementsV1 = paymentRequirements as PaymentRequirementsV1;
    resourceUrl = requirementsV1.resource;
    discoveryInfo = extractDiscoveryInfoV1(requirementsV1);
  } else {
    return null;
  }

  if (!discoveryInfo) {
    return null;
  }

  // Strip query params (?) and hash sections (#) for discovery cataloging
  const url = new URL(resourceUrl);
  // If a routeTemplate is present (dynamic route), use it as the canonical path
  const canonicalUrl = routeTemplate
    ? `${url.origin}${routeTemplate}`
    : `${url.origin}${url.pathname}`;

  // Extract description and mimeType from resource info (v2) or requirements (v1)
  let description: string | undefined;
  let mimeType: string | undefined;
  let serviceMetadata: SanitizedResourceServiceMetadata = {};

  if (paymentPayload.x402Version === 2) {
    description = paymentPayload.resource?.description;
    mimeType = paymentPayload.resource?.mimeType;
    // Service metadata only exists in v2; v1 had no equivalent.
    serviceMetadata = sanitizeResourceServiceMetadata(paymentPayload.resource);
  } else if (paymentPayload.x402Version === 1) {
    const requirementsV1 = paymentRequirements as PaymentRequirementsV1;
    description = requirementsV1.description;
    mimeType = requirementsV1.mimeType;
  }

  const base = {
    resourceUrl: canonicalUrl,
    description,
    mimeType,
    ...serviceMetadata,
    x402Version: paymentPayload.x402Version,
    discoveryInfo,
  };

  if (discoveryInfo.input.type === "mcp") {
    // MCP routes are not parameterized; routeTemplate is not applicable.
    return { ...base, toolName: (discoveryInfo as McpDiscoveryInfo).input.toolName };
  }

  return { ...base, routeTemplate, method: discoveryInfo.input.method };
}

/**
 * Extracts discovery info from a v2 extension directly
 *
 * This is a lower-level function for when you already have the extension object.
 * For general use, prefer the main extractDiscoveryInfo function.
 *
 * @param extension - The discovery extension to extract info from
 * @param validate - Whether to validate before extracting (default: true)
 * @returns The discovery info if valid
 * @throws Error if validation fails and validate is true
 */
export function extractDiscoveryInfoFromExtension(
  extension: DiscoveryExtension,
  validate: boolean = true,
): DiscoveryInfo {
  if (validate) {
    const result = validateDiscoveryExtension(extension);
    if (!result.valid) {
      throw new Error(
        `Invalid discovery extension: ${result.errors?.join(", ") || "Unknown error"}`,
      );
    }
  }

  return extension.info;
}

/**
 * Validates and extracts discovery info in one step
 *
 * This is a convenience function that combines validation and extraction,
 * returning both the validation result and the info if valid.
 *
 * @param extension - The discovery extension to validate and extract
 * @returns Object containing validation result and info (if valid)
 *
 * @example
 * ```typescript
 * const extension = declareDiscoveryExtension(...);
 * const { valid, info, errors } = validateAndExtract(extension);
 *
 * if (valid && info) {
 *   // Store info in Bazaar catalog
 * } else {
 *   console.error("Validation errors:", errors);
 * }
 * ```
 */
export function validateAndExtract(extension: DiscoveryExtension): {
  valid: boolean;
  info?: DiscoveryInfo;
  errors?: string[];
} {
  const result = validateDiscoveryExtension(extension);

  if (result.valid) {
    return {
      valid: true,
      info: extension.info,
    };
  }

  return {
    valid: false,
    errors: result.errors,
  };
}
