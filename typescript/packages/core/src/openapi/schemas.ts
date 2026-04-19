/**
 * Zod schemas for OpenAPI 3.1.0 spec generation.
 *
 * These schemas match the shape expected by agentcash-discovery's
 * OpenApiDocSchema / OpenApiOperationSchema / OpenApiPaymentInfoSchema.
 */
import { z } from "zod";

// ─── OpenAPI path item ──────────────────────────────────────────────────────

import { HTTP_METHODS, type HttpMethod } from "./route";

// ─── x-payment-info ─────────────────────────────────────────────────────────

export const FixedPriceSchema = z.object({
  mode: z.literal("fixed"),
  amount: z.string(),
  currency: z.string().default("USD"),
});

export const DynamicPriceSchema = z.object({
  mode: z.literal("dynamic"),
});

export const PaymentPriceSchema = z.discriminatedUnion("mode", [
  FixedPriceSchema,
  DynamicPriceSchema,
]);

export const X402ProtocolSchema = z.object({
  x402: z.record(z.string(), z.unknown()).default({}),
});

export const PaymentInfoSchema = z.object({
  price: PaymentPriceSchema,
  protocols: z.array(X402ProtocolSchema),
});

// ─── JSON Schema subset (used inside parameters / responses) ────────────────

export const JsonSchemaPropertySchema: z.ZodType<JsonSchemaProperty> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    properties: z.record(z.string(), JsonSchemaPropertySchema).optional(),
    required: z.array(z.string()).optional(),
    items: JsonSchemaPropertySchema.optional(),
    description: z.string().optional(),
    example: z.unknown().optional(),
    additionalProperties: z.union([z.boolean(), JsonSchemaPropertySchema]).optional(),
    enum: z.array(z.unknown()).optional(),
    const: z.unknown().optional(),
    format: z.string().optional(),
  }),
);

export type JsonSchemaProperty = {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  items?: JsonSchemaProperty;
  description?: string;
  example?: unknown;
  additionalProperties?: boolean | JsonSchemaProperty;
  enum?: unknown[];
  const?: unknown;
  format?: string;
};

// ─── OpenAPI parameter ──────────────────────────────────────────────────────

export const ParameterSchema = z.object({
  in: z.enum(["path", "query", "header", "cookie"]),
  name: z.string(),
  required: z.boolean(),
  schema: JsonSchemaPropertySchema,
  description: z.string().optional(),
});

// ─── OpenAPI response ───────────────────────────────────────────────────────

export const MediaTypeSchema = z.object({
  schema: JsonSchemaPropertySchema,
});

export const ResponseSchema = z.object({
  description: z.string(),
  content: z.record(z.string(), MediaTypeSchema).optional(),
});

// ─── OpenAPI operation ──────────────────────────────────────────────────────

export const OperationSchema = z.object({
  summary: z.string().optional(),
  description: z.string().optional(),
  "x-payment-info": PaymentInfoSchema,
  parameters: z.array(ParameterSchema).optional(),
  requestBody: z
    .object({
      required: z.boolean().optional(),
      content: z.record(z.string(), MediaTypeSchema),
    })
    .optional(),
  responses: z.record(z.string(), ResponseSchema),
});

export const PathItemSchema = z.object(
  Object.fromEntries(HTTP_METHODS.map(m => [m, OperationSchema.optional()])) as Record<
    HttpMethod,
    z.ZodOptional<typeof OperationSchema>
  >,
);

// ─── OpenAPI document ───────────────────────────────────────────────────────

export const InfoSchema = z.object({
  title: z.string(),
  version: z.string(),
  description: z.string().optional(),
  "x-guidance": z.string().optional(),
});

export const ServerSchema = z.object({
  url: z.string(),
});

export const OpenAPIDocSchema = z.object({
  openapi: z.literal("3.1.0"),
  info: InfoSchema,
  servers: z.array(ServerSchema).optional(),
  paths: z.record(z.string(), PathItemSchema),
});

// ─── Inferred types ─────────────────────────────────────────────────────────

export type FixedPrice = z.infer<typeof FixedPriceSchema>;
export type DynamicPrice = z.infer<typeof DynamicPriceSchema>;
export type PaymentPrice = z.infer<typeof PaymentPriceSchema>;
export type PaymentInfo = z.infer<typeof PaymentInfoSchema>;
export type Parameter = z.infer<typeof ParameterSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type PathItem = z.infer<typeof PathItemSchema>;
export type OpenAPIDoc = z.infer<typeof OpenAPIDocSchema>;
export type OpenAPIResponse = z.infer<typeof ResponseSchema>;
