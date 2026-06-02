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

export function createAgent(name: string): AgentIdentity {
  const keyPair = generateEd25519KeyPair();
  return {
    did: keyPair.did,
    name,
    privateKeyHex: keyPair.privateKeyHex,
    keyPair,
  };
}

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
