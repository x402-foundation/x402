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

import crypto from "crypto";
import { base58btcEncode } from "./base58";

export interface Ed25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  did: string;
  privateKeyHex: string;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const rawPublic = publicKey.subarray(publicKey.length - 32);
  const rawPrivate = privateKey.subarray(privateKey.length - 32);

  return {
    publicKey: rawPublic,
    privateKey: rawPrivate,
    did: publicKeyToDidKey(rawPublic),
    privateKeyHex: Buffer.from(rawPrivate).toString("hex"),
  };
}

export function publicKeyToDidKey(publicKey: Uint8Array): string {
  const multicodecPrefix = new Uint8Array([0xed, 0x01]);
  const multicodecKey = new Uint8Array(
    multicodecPrefix.length + publicKey.length
  );
  multicodecKey.set(multicodecPrefix);
  multicodecKey.set(publicKey, multicodecPrefix.length);

  return `did:key:${base58btcEncode(multicodecKey)}`;
}

export function buildDid(domain: string, path: string): string {
  // did:web encodes path segments with `:`, not `/`. Translate so callers
  // can pass familiar URL-style paths like "user/abc".
  const colonPath = path.split("/").join(":");
  return `did:web:${domain}:${colonPath}`;
}
