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

export { generateEd25519KeyPair, publicKeyToDidKey, buildDid } from "./did";
export type { Ed25519KeyPair } from "./did";

export { buildCredentialSubject, meetsKycRequirement } from "./principal";
export type { PrincipalIdentity } from "./principal";

export { createAgent, buildDelegation } from "./agent";
export type { AgentIdentity } from "./agent";
