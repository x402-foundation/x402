import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import { isNodeEnoent, readJsonFile, resolveWithinDir, writeJsonAtomic } from "../storage-utils";
import { normalizeChannelId } from "../utils";
import type { FileChannelStorageOptions } from "../types";
import type { ChannelLockStorage, ChannelStorage, Channel, ChannelUpdateResult } from "./storage";

export type { FileChannelStorageOptions };

const FILE_LOCK_MAX_ATTEMPTS = 50;
const FILE_LOCK_RETRY_INTERVAL_MS = 10;
const FILE_LOCK_STALE_MS = 2_000;

export type AcquireExclusiveFileOptions = {
  maxAttempts?: number;
  retryIntervalMs?: number;
  staleMs?: number;
};

/**
 * Node.js file-backed {@link ChannelStorage} for the batched server scheme.
 */
export class FileChannelStorage implements ChannelStorage, ChannelLockStorage {
  private readonly root: string;

  /**
   * Creates file-backed server channel storage under the given root directory.
   *
   * @param options - Configuration including the storage root directory.
   */
  constructor(options: FileChannelStorageOptions) {
    this.root = options.directory;
  }

  /**
   * Loads a persisted channel record, if present.
   *
   * @param channelId - The channel identifier (path segment is lowercased).
   * @returns Parsed channel record or `undefined` when the file is missing.
   */
  async get(channelId: string): Promise<Channel | undefined> {
    return readJsonFile<Channel>(this.filePath(channelId));
  }

  /**
   * Lists all stored channel records by reading the server directory.
   *
   * @returns Channel records sorted by channelId; empty array if the directory is missing.
   */
  async list(): Promise<Channel[]> {
    const dir = join(this.root, "server");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err: unknown) {
      if (isNodeEnoent(err)) return [];
      throw err;
    }

    const channels: Channel[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const raw = await readFile(path, "utf8");
        channels.push(JSON.parse(raw) as Channel);
      } catch (err: unknown) {
        // Skip files that disappeared between readdir and readFile (e.g. concurrent delete).
        // Rethrow other failures (corrupt JSON, permission denied) so callers see them.
        if (isNodeEnoent(err)) continue;
        throw err;
      }
    }
    return channels.sort((a, b) => a.channelId.localeCompare(b.channelId));
  }

  /**
   * Atomically inspects and mutates a channel record under a cross-process file lock.
   *
   * @param channelId - The channel identifier.
   * @param update - Mutation callback. Return `undefined` to delete, or `current` to leave unchanged.
   * @returns The final stored channel and whether storage updated, stayed unchanged, or deleted.
   */
  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
  ): Promise<ChannelUpdateResult> {
    const lockPath = this.filePath(channelId) + ".lock";
    await mkdir(dirname(lockPath), { recursive: true });
    const lockHandle = await acquireExclusiveFile(lockPath);

    try {
      const path = this.filePath(channelId);
      let current: Channel | undefined;
      try {
        const raw = await readFile(path, "utf8");
        current = JSON.parse(raw) as Channel;
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
      }

      const next = update(current);
      if (next === current) {
        return { channel: current, status: "unchanged" };
      }

      if (!next) {
        try {
          await unlink(path);
        } catch (err: unknown) {
          if (!isNodeEnoent(err)) throw err;
        }
        await this.dropHold(channelId);
        return { channel: undefined, status: current ? "deleted" : "unchanged" };
      }

      await writeJsonAtomic(path, next);
      return { channel: next, status: "updated" };
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch(() => {});
    }
  }

  /**
   * Acquires a per-channel admission lock via a sidecar hold file.
   *
   * Serialized with {@link FileChannelStorage.release} and {@link FileChannelStorage.isHeld}
   * on `{id}.hold.lock` so an expired hold cannot be unlinked out from under a new holder.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - Request-scoped lock owner.
   * @param ttlMs - Lock time-to-live in milliseconds.
   * @returns Whether this request now holds the lock.
   */
  async acquire(channelId: string, pendingId: string, ttlMs: number): Promise<boolean> {
    return this.withHoldLock(channelId, async () => {
      const path = this.holdPath(channelId);
      await mkdir(dirname(path), { recursive: true });
      try {
        const existing = JSON.parse(await readFile(path, "utf8")) as {
          pendingId: string;
          expiresAt: number;
        };
        if (existing.expiresAt > Date.now()) return false;
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
      }
      await writeFile(path, JSON.stringify({ pendingId, expiresAt: Date.now() + ttlMs }), "utf8");
      return true;
    });
  }

  /**
   * Releases the admission lock only when `pendingId` still holds it.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - Request-scoped lock owner.
   */
  async release(channelId: string, pendingId: string): Promise<void> {
    await this.withHoldLock(channelId, async () => {
      const path = this.holdPath(channelId);
      try {
        const hold = JSON.parse(await readFile(path, "utf8")) as { pendingId: string };
        if (hold.pendingId !== pendingId) return;
        await unlink(path);
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
      }
    });
  }

  /**
   * Returns whether a live admission lock exists, optionally matching `pendingId`.
   *
   * @param channelId - The channel identifier.
   * @param pendingId - When set, require this request to hold the lock.
   * @returns Whether a live lock (or this request's lock) is present.
   */
  async isHeld(channelId: string, pendingId?: string): Promise<boolean> {
    return this.withHoldLock(channelId, async () => {
      try {
        const hold = JSON.parse(await readFile(this.holdPath(channelId), "utf8")) as {
          pendingId: string;
          expiresAt: number;
        };
        if (hold.expiresAt <= Date.now()) return false;
        return pendingId === undefined || hold.pendingId === pendingId;
      } catch (err: unknown) {
        if (isNodeEnoent(err)) return false;
        throw err;
      }
    });
  }

  /**
   * Absolute path to the JSON file for a channel.
   *
   * @param channelId - The channel identifier.
   * @returns Filesystem path under `{root}/server/...`.
   * @throws When `channelId` is not a canonical `bytes32` string or escapes the storage root.
   */
  private filePath(channelId: string): string {
    const id = normalizeChannelId(channelId);
    return resolveWithinDir(join(this.root, "server"), `${id}.json`);
  }

  /**
   * Absolute path to the admission hold sidecar for a channel.
   *
   * @param channelId - The channel identifier.
   * @returns Filesystem path under `{root}/server/{id}.hold`.
   */
  private holdPath(channelId: string): string {
    const id = normalizeChannelId(channelId);
    return resolveWithinDir(join(this.root, "server"), `${id}.hold`);
  }

  /**
   * Drops the admission hold for a deleted channel row.
   *
   * @param channelId - The channel identifier.
   */
  private async dropHold(channelId: string): Promise<void> {
    await this.withHoldLock(channelId, async () => {
      try {
        await unlink(this.holdPath(channelId));
      } catch (err: unknown) {
        if (!isNodeEnoent(err)) throw err;
      }
    });
  }

  /**
   * Serializes acquire, release, and isHeld on the `.hold` sidecar.
   *
   * @param channelId - The channel identifier.
   * @param fn - Work to run while holding `{id}.hold.lock`.
   * @returns The resolved result of `fn`.
   */
  private async withHoldLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.holdPath(channelId) + ".lock";
    await mkdir(dirname(lockPath), { recursive: true });
    const lockHandle = await acquireExclusiveFile(lockPath);
    try {
      return await fn();
    } finally {
      await lockHandle.close();
      await unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Creates an exclusive lock file, stealing markers whose mtime is older than `staleMs`.
 *
 * @param lockPath - Absolute path for the lock file (created with `O_EXCL`).
 * @param options - Attempt, retry, and stale-mtime bounds.
 * @returns Writable file handle for the lock file; caller must close it to release.
 * @throws When the lock remains contended after `maxAttempts`.
 */
export async function acquireExclusiveFile(
  lockPath: string,
  options: AcquireExclusiveFileOptions = {},
) {
  const maxAttempts = options.maxAttempts ?? FILE_LOCK_MAX_ATTEMPTS;
  const retryIntervalMs = options.retryIntervalMs ?? FILE_LOCK_RETRY_INTERVAL_MS;
  const staleMs = options.staleMs ?? FILE_LOCK_STALE_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (await isStaleLock(lockPath, staleMs)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
    }
  }
  throw new Error(`acquire lock ${lockPath}: contended`);
}

/**
 * Returns whether `lockPath` is missing or older than `staleMs`.
 *
 * @param lockPath - Absolute path for the lock file.
 * @param staleMs - Age after which a leftover marker is treated as crash debris.
 * @returns Whether the caller may unlink and retry exclusive create.
 */
async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs >= staleMs;
  } catch (err: unknown) {
    if (isNodeEnoent(err)) return true;
    throw err;
  }
}
