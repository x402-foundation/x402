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

// AUTHORED OFFLINE — first CI run is the verification step.

import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryNonceStorage, NoOpNonceStorage } from "../src/vcx";

const WINDOW = 60_000;

describe("InMemoryNonceStorage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false on first sighting and true on immediate replay", async () => {
    const store = new InMemoryNonceStorage();
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(true);
  });

  it("treats distinct nonces independently", async () => {
    const store = new InMemoryNonceStorage();
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);
    expect(await store.checkAndRecord("nonce-b", WINDOW)).toBe(false);
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(true);
    expect(await store.checkAndRecord("nonce-b", WINDOW)).toBe(true);
  });

  it("evicts entries older than the freshness window", async () => {
    vi.useFakeTimers();
    const store = new InMemoryNonceStorage();
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);

    vi.advanceTimersByTime(WINDOW + 1);

    // After the window elapses, the nonce should be fresh again.
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);
  });

  it("does not evict entries within the freshness window", async () => {
    vi.useFakeTimers();
    const store = new InMemoryNonceStorage();
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);

    vi.advanceTimersByTime(WINDOW - 1);

    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(true);
  });
});

describe("NoOpNonceStorage", () => {
  it("always reports nonces as new (disables replay protection)", async () => {
    const store = new NoOpNonceStorage();
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);
    expect(await store.checkAndRecord("nonce-a", WINDOW)).toBe(false);
  });
});
