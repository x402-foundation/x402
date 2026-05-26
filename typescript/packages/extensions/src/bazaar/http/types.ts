/**
 * HTTP-specific type definitions for the Bazaar Discovery Extension
 */

import type { BodyMethods, QueryParamMethods } from "@x402/core/http";
import type { DiscoveryInfo } from "../types";

/** Shared schema definition for an object-typed parameter map (queryParams, pathParams, etc.) */
interface ParamMapSchemaProperty {
  type: "object";
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
}

/**
 * Discovery info for query parameter methods (GET, HEAD, DELETE)
 */
export interface QueryDiscoveryInfo {
  input: {
    type: "http";
    /** Absent at declaration time; set by bazaarResourceServerExtension.enrichDeclaration */
    method?: QueryParamMethods;
    queryParams?: Record<string, unknown>;
    pathParams?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  output?: {
    type?: string;
    format?: string;
    example?: unknown;
  };
}

/**
 * Discovery info for body methods (POST, PUT, PATCH)
 */
export interface BodyDiscoveryInfo {
  input: {
    type: "http";
    /** Absent at declaration time; set by bazaarResourceServerExtension.enrichDeclaration */
    method?: BodyMethods;
    bodyType: "json" | "form-data" | "text";
    body: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
    pathParams?: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  output?: {
    type?: string;
    format?: string;
    example?: unknown;
  };
}

/**
 * Discovery extension for query parameter methods (GET, HEAD, DELETE)
 */
export interface QueryDiscoveryExtension {
  info: QueryDiscoveryInfo;
  routeTemplate?: string;

  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema";
    type: "object";
    properties: {
      input: {
        type: "object";
        properties: {
          type: {
            type: "string";
            const: "http";
          };
          method: {
            type: "string";
            enum: QueryParamMethods[];
          };
          queryParams?: ParamMapSchemaProperty & { required?: string[] };
          pathParams?: ParamMapSchemaProperty;
          headers?: {
            type: "object";
            additionalProperties: {
              type: "string";
            };
          };
        };
        required: ("type" | "method")[];
        additionalProperties?: boolean;
      };
      output?: {
        type: "object";
        properties?: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties?: boolean;
      };
    };
    required: ["input"];
  };
}

/**
 * Discovery extension for body methods (POST, PUT, PATCH)
 */
export interface BodyDiscoveryExtension {
  info: BodyDiscoveryInfo;
  routeTemplate?: string;

  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema";
    type: "object";
    properties: {
      input: {
        type: "object";
        properties: {
          type: {
            type: "string";
            const: "http";
          };
          method: {
            type: "string";
            enum: BodyMethods[];
          };
          bodyType: {
            type: "string";
            enum: ["json", "form-data", "text"];
          };
          body: Record<string, unknown>;
          queryParams?: ParamMapSchemaProperty & { required?: string[] };
          pathParams?: ParamMapSchemaProperty;
          headers?: {
            type: "object";
            additionalProperties: {
              type: "string";
            };
          };
        };
        required: ("type" | "method" | "bodyType" | "body")[];
        additionalProperties?: boolean;
      };
      output?: {
        type: "object";
        properties?: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties?: boolean;
      };
    };
    required: ["input"];
  };
}

export interface DeclareQueryDiscoveryExtensionConfig {
  method?: QueryParamMethods;
  input?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  pathParams?: Record<string, unknown>;
  pathParamsSchema?: Record<string, unknown>;
  output?: {
    example?: unknown;
    schema?: Record<string, unknown>;
  };
}

export interface DeclareBodyDiscoveryExtensionConfig {
  method?: BodyMethods;
  input?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  pathParams?: Record<string, unknown>;
  pathParamsSchema?: Record<string, unknown>;
  bodyType: "json" | "form-data" | "text";
  output?: {
    example?: unknown;
    schema?: Record<string, unknown>;
  };
}

export interface DiscoveredHTTPResource {
  resourceUrl: string;
  description?: string;
  mimeType?: string;
  /** Sanitized service metadata. See `sanitizeResourceServiceMetadata` for rules. */
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  /** Present after server extension enrichment; may be absent for pre-enrichment data */
  method?: string;
  routeTemplate?: string;
  x402Version: number;
  discoveryInfo: DiscoveryInfo;
}

export const isQueryExtensionConfig = (
  config: DeclareQueryDiscoveryExtensionConfig | DeclareBodyDiscoveryExtensionConfig,
): config is DeclareQueryDiscoveryExtensionConfig => {
  return !("bodyType" in config) && !("toolName" in config);
};

export const isBodyExtensionConfig = (
  config: DeclareQueryDiscoveryExtensionConfig | DeclareBodyDiscoveryExtensionConfig,
): config is DeclareBodyDiscoveryExtensionConfig => {
  return "bodyType" in config;
};
