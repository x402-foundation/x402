/**
 * Authorization Evidence Declaration Helper
 *
 * Server-side helper for declaring the authorization-evidence requirement on
 * a route. Declaring the extension on a route makes evidence MANDATORY for
 * that route: requests without a valid presentation are denied before any
 * payment processing.
 */

import { authorizationEvidenceSchema } from "./schema";
import { AUTHORIZATION_EVIDENCE, AUTHORIZATION_EVIDENCE_PROFILE } from "./types";
import type {
  AuthorizationEvidenceDeclaration,
  DeclareAuthorizationEvidenceOptions,
} from "./types";

/**
 * Declare the authorization-evidence extension for a route. Spread the result
 * into the route's `extensions` record.
 *
 * @param options - Optional per-route settings (challenge lifetime)
 * @returns A keyed record for the route's `extensions` field
 */
export function declareAuthorizationEvidenceExtension(
  options: DeclareAuthorizationEvidenceOptions = {},
): Record<string, AuthorizationEvidenceDeclaration> {
  if (
    options.challengeTtlSeconds !== undefined &&
    (!Number.isInteger(options.challengeTtlSeconds) || options.challengeTtlSeconds <= 0)
  ) {
    throw new Error(
      `Invalid authorization-evidence challengeTtlSeconds: "${options.challengeTtlSeconds}" ` +
        `must be a positive integer`,
    );
  }
  return {
    [AUTHORIZATION_EVIDENCE]: {
      info: {
        profile: AUTHORIZATION_EVIDENCE_PROFILE,
      },
      schema: authorizationEvidenceSchema,
      _options: options,
    },
  };
}
