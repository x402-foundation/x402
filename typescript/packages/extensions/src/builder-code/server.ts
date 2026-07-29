/**
 * Resource Server utilities for the Builder Code Extension.
 */

import type { ResourceServerExtension } from "@x402/core/types";
import { BUILDER_CODE, BUILDER_CODE_PATTERN, type BuilderCodeExtensionData } from "./types";

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
      maxItems: 5,
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
 * @returns Extension declaration with info and schema for PaymentRequired.extensions
 */
export function declareBuilderCodeExtension(appCode: string): BuilderCodeRequiredExtension {
  if (!BUILDER_CODE_PATTERN.test(appCode)) {
    throw new Error(
      `Invalid builder code: "${appCode}". ` +
        `Must be 1-32 characters, lowercase alphanumeric and underscores only.`,
    );
  }

  return {
    info: { a: appCode },
    schema: BUILDER_CODE_SCHEMA,
  };
}

export const builderCodeResourceServerExtension: ResourceServerExtension = {
  key: BUILDER_CODE,
};
