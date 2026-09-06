/**
 * Resource Server utilities for the Builder Code Extension.
 */

import type { ResourceServerExtension } from "@x402/core/types";
import {
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  MAX_SERVER_SERVICE_CODES,
  MAX_SERVICE_CODES,
  type BuilderCodeExtensionData,
} from "./types";

export const BUILDER_CODE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    a: {
      type: "string",
      pattern: "^[a-z0-9_]{1,32}$",
      description: "App builder code",
    },
    w: {
      type: "string",
      pattern: "^[a-z0-9_]{1,32}$",
      description: "Wallet builder code",
    },
    s: {
      type: "array",
      maxItems: MAX_SERVICE_CODES,
      items: {
        type: "string",
        pattern: "^[a-z0-9_]{1,32}$",
      },
      description: "Service builder codes",
    },
  },
  additionalProperties: false,
} as const;

export interface BuilderCodeRequiredExtension {
  info: BuilderCodeExtensionData;
  schema: typeof BUILDER_CODE_SCHEMA;
}

/**
 * Declares the builder-code extension for inclusion in PaymentRequired.extensions.
 *
 * @param appCode - The service's builder code (e.g., "bc_weather_svc")
 * @param serviceCodes - Optional service code(s) (e.g. attribution for a server-side
 *   SDK the service depends on). Client-provided service codes are merged with these
 *   by the core client, client entries first.
 * @returns Extension declaration with info and schema for PaymentRequired.extensions
 */
export function declareBuilderCodeExtension(
  appCode: string,
  serviceCodes?: string | string[],
): BuilderCodeRequiredExtension {
  if (!BUILDER_CODE_PATTERN.test(appCode)) {
    throw new Error(
      `Invalid builder code: "${appCode}". ` +
        `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
    );
  }

  const codes = serviceCodes === undefined ? [] : ([] as string[]).concat(serviceCodes);
  if (codes.length > MAX_SERVER_SERVICE_CODES) {
    throw new Error(
      `Too many service codes: ${codes.length} exceeds the maximum of ${MAX_SERVER_SERVICE_CODES}.`,
    );
  }
  for (const code of codes) {
    if (!BUILDER_CODE_PATTERN.test(code)) {
      throw new Error(
        `Invalid builder code: "${code}". ` +
          `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
      );
    }
  }

  return {
    info: codes.length > 0 ? { a: appCode, s: codes } : { a: appCode },
    schema: BUILDER_CODE_SCHEMA,
  };
}

export const builderCodeResourceServerExtension: ResourceServerExtension = {
  key: BUILDER_CODE,
};
