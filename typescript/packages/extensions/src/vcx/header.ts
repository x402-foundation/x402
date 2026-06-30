/**
 * Copyright 2026 PayPal Holdings, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { IdentityEnvelope } from "./types";

/** HTTP header carrying the VCX identity envelope (spec §6). */
export const VCX_HEADER_NAME = "VCX";

/**
 * Encode an identity envelope as a base64 string suitable for the VCX header.
 *
 * @param envelope - The VCX identity envelope to serialise.
 * @returns The base64-encoded JSON representation of the envelope.
 */
export function encodeVCXHeader(envelope: IdentityEnvelope): string {
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

/**
 * Decode the VCX header value back into an identity envelope.
 *
 * @param headerValue - The base64-encoded VCX header value to decode.
 * @returns The decoded identity envelope.
 * @throws If the input is not valid base64 JSON.
 */
export function parseVCXHeader(headerValue: string): IdentityEnvelope {
  const decoded = Buffer.from(headerValue, "base64").toString("utf8");
  return JSON.parse(decoded) as IdentityEnvelope;
}
