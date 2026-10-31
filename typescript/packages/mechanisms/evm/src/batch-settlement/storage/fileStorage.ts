import { mkdir, open, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { isNodeEnoent, readJsonFile, resolveWithinDir, writeJsonAtomic } from "../storage-utils";
import { normalizeChannelId } from "../utils";
import type { FileChannelStorageOptions } from "../types";
import type { ChannelLockStorage, ChannelStorage, Channel, ChannelUpdateResult } from "./channel";

export type { FileChannelStorageOptions };

const FILE_LOCK_MAX_ATTEMPTS = 50;
const FILE_LOCK_RETRY_INTERVAL_MS = 10;
const FILE_LOCK_STALE_MS = 30_000;

/**
 * Owner record written into every exclusive lock marker.
 *
 * The on-disk protocol is shared with the Go SDK: a lock file contains JSON
 * `{ pid, token, createdAt }`. Stealing is only allowed when the owner is
 * provably gone (dead PID) or when an unreadable legacy marker is older than
 * `staleMs`. A live owner is never stolen, no matter how old the marker is.
 */
export type FileLockOwner = {
  pid: number;
  token: string;
  createdAt: number;
};

export type AcquireExclusiveFileOptions = {
  maxAttempts?: number;
  retryIntervalMs?: number;
  staleMs?: number;
};

/** File-backed channel and admission-lock storage. */
export class FileChannelStorage<T extends Channel = Channel>
  implements ChannelStorage<T>, ChannelLockStorage
{
  private readonly root: string;

  /**
   * Creates storage rooted at the configured directory.
   *
   * @param options - Storage configuration.
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
  async get(channelId: string): Promise<T | undefined> {
    return readJsonFile<T>(this.filePath(channelId));
  }

  /**
   * Lists all stored channel records by reading the server directory.
   *
   * @returns Channel records sorted by channelId; empty array if the directory is missing.
   */
  async list(): Promise<T[]> {
    const dir = join(this.root, "server");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err: unknown) {
      if (isNodeEnoent(err)) return [];
      throw err;
    }

    const channels: T[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const raw = await readFile(path, "utf8");
        channels.push(JSON.parse(raw) as T);
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
    update: (current: T | undefined) => T | undefined,
  ): Promise<ChannelUpdateResult<T>> {
    const lockPath = this.filePath(channelId) + ".lock";
    await mkdir(dirname(lockPath), { recursive: true });
    const lockHandle = await acquireExclusiveFile(lockPath);

    try {
      const path = this.filePath(channelId);
      let current: T | undefined;
      try {
        const raw = await readFile(path, "utf8");
        current = JSON.parse(raw) as T;
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
        if (existing.expiresAt > Date.now()) {
          return false;
        }
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
   * Returns the channel record path.
   *
   * @param channelId - Channel identifier.
   * @returns Channel record path.
   */
  private filePath(channelId: string): string {
    const id = normalizeChannelId(channelId);
    return resolveWithinDir(join(this.root, "server"), `${id}.json`);
  }

  /**
   * Returns the admission-lock path.
   *
   * @param channelId - Channel identifier.
   * @returns Admission-lock path.
   */
  private holdPath(channelId: string): string {
    const id = normalizeChannelId(channelId);
    return resolveWithinDir(join(this.root, "server"), `${id}.hold`);
  }

  /**
   * Removes a channel's admission hold.
   *
   * @param channelId - Channel identifier.
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
   * Serializes operations on a channel's admission hold.
   *
   * @param channelId - Channel identifier.
   * @param fn - Work to run under the lock.
   * @returns The work result.
   */
  private async withHoldLock<R>(channelId: string, fn: () => Promise<R>): Promise<R> {
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
 * Creates an exclusive lock file with an owner marker.
 *
 * The marker holds JSON `{ pid, token, createdAt }` under the same on-disk
 * protocol as the Go SDK. A contended marker is unlinked only when its owner
 * is provably gone (dead PID) or when a legacy/unreadable marker is older
 * than `staleMs`. A live owner is never stolen: slow writers keep the lock
 * and contenders fail with `contended` after `maxAttempts`.
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
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      );
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: Date.now() }),
        );
        await handle.sync();
      } catch {
        // Best effort: the O_EXCL marker already serializes writers even if the
        // owner payload cannot be persisted; steal decisions fall back to mtime.
      }
      return handle;
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
 * Returns whether `lockPath` may be unlinked and retried.
 *
 * A marker with a readable owner is stale only when its PID is provably gone.
 * Legacy or unreadable markers (empty file from an older SDK, partial write
 * after a crash) fall back to mtime age so crash debris cannot pin the channel
 * forever.
 *
 * @param lockPath - Absolute path for the lock file.
 * @param staleMs - Age after which a legacy marker is treated as crash debris.
 * @returns Whether the caller may unlink and retry exclusive create.
 */
async function isStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (err: unknown) {
    if (isNodeEnoent(err)) return true;
    throw err;
  }
  let raw = "";
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err: unknown) {
    if (isNodeEnoent(err)) return true;
    throw err;
  }
  if (!raw.trim()) {
    return Date.now() - mtimeMs >= staleMs;
  }
  try {
    const owner = JSON.parse(raw) as Partial<FileLockOwner>;
    if (typeof owner.pid !== "number") {
      return Date.now() - mtimeMs >= staleMs;
    }
    return !isOwnerAlive(owner.pid);
  } catch {
    return Date.now() - mtimeMs >= staleMs;
  }
}

/**
 * Reports whether a lock-owner PID is still alive.
 *
 * Uses signal `0`: `ESRCH` means provably gone, `EPERM` means alive but
 * un-signallable, and any other failure fails closed to alive so a live writer
 * is never stolen.
 *
 * @param pid - PID recorded in the lock marker.
 * @returns Whether the owner process may still be running.
 */
function isOwnerAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return false;
    }
    return true;
  }
}
