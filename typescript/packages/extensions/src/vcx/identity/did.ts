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

/**
 * Generate a fresh Ed25519 key pair and derive its `did:key` identifier.
 * The raw 32-byte public and private keys are extracted from the encoded
 * SPKI/PKCS#8 output, and the private key is also exposed as hex.
 *
 * @returns The generated key pair with its raw keys, `did:key`, and hex private key.
 */
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

/**
 * Derive the `did:key` identifier for a raw Ed25519 public key by
 * prepending the Ed25519 multicodec prefix (`0xed 0x01`) and encoding the
 * result as a base58btc multibase string.
 *
 * @param publicKey - The raw 32-byte Ed25519 public key.
 * @returns The `did:key:z...` identifier.
 */
export function publicKeyToDidKey(publicKey: Uint8Array): string {
  const multicodecPrefix = new Uint8Array([0xed, 0x01]);
  const multicodecKey = new Uint8Array(multicodecPrefix.length + publicKey.length);
  multicodecKey.set(multicodecPrefix);
  multicodecKey.set(publicKey, multicodecPrefix.length);

  return `did:key:${base58btcEncode(multicodecKey)}`;
}

/**
 * Build a `did:web` identifier from a domain and a URL-style path,
 * translating path separators (`/`) into the `:` segment delimiter
 * required by the did:web method.
 *
 * @param domain - The host (and optional encoded port) for the DID.
 * @param path - A URL-style path such as `user/abc`.
 * @returns The `did:web:...` identifier.
 */
export function buildDid(domain: string, path: string): string {
  // did:web encodes path segments with `:`, not `/`. Translate so callers
  // can pass familiar URL-style paths like "user/abc".
  const colonPath = path.split("/").join(":");
  return `did:web:${domain}:${colonPath}`;
}
