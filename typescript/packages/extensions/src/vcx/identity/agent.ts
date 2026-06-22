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

import { generateEd25519KeyPair, type Ed25519KeyPair } from "./did";
import type { AgentDelegation, DelegationConditions } from "../types";

export interface AgentIdentity {
  did: string;
  name: string;
  privateKeyHex: string;
  keyPair: Ed25519KeyPair;
}

/**
 * Create a new agent identity by generating a fresh Ed25519 key pair and
 * associating it with a human-readable name. The resulting identity's DID
 * is the key pair's `did:key`.
 *
 * @param name - A human-readable label for the agent.
 * @returns The agent identity, including its DID, name, and key material.
 */
export function createAgent(name: string): AgentIdentity {
  const keyPair = generateEd25519KeyPair();
  return {
    did: keyPair.did,
    name,
    privateKeyHex: keyPair.privateKeyHex,
    keyPair,
  };
}

/**
 * Build an agent delegation record describing the agent a principal
 * delegates to, along with the optional payment source and conditions
 * that constrain the delegation.
 *
 * @param opts - The delegation parameters.
 * @param opts.agentDid - The DID of the agent being delegated to.
 * @param opts.paymentSource - Optional payment source authorised for the delegation.
 * @param opts.conditions - Optional conditions constraining the delegation.
 * @returns The assembled agent delegation record.
 */
export function buildDelegation(opts: {
  agentDid: string;
  paymentSource?: string;
  conditions?: DelegationConditions;
}): AgentDelegation {
  return {
    agentDid: opts.agentDid,
    paymentSource: opts.paymentSource,
    conditions: opts.conditions,
  };
}
