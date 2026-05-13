import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

import { isNodeEnoent, readJsonFile, writeJsonAtomic } from "../storage-utils";
import type { FileChannelStorageOptions } from "../types";
import type { ChannelStorage, Channel, ChannelUpdateResult } from "./storage";

export type { FileChannelStorageOptions };

/**
 * Node.js file-backed {@link ChannelStorage} for the batched server scheme.
 */
export class FileChannelStorage implements ChannelStorage {
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
    const lockHandle = await this.acquireLock(lockPath);

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
   * Absolute path to the JSON file for a channel.
   *
   * @param channelId - The channel identifier.
   * @returns Filesystem path under `{root}/server/...`.
   */
  private filePath(channelId: string): string {
    return join(this.root, "server", `${channelId.toLowerCase()}.json`);
  }

  /**
   * Creates an exclusive lock file, polling until no other process holds it.
   *
   * @param lockPath - Absolute path for the lock file (created with `O_EXCL`).
   * @returns Writable file handle for the lock file; caller must close it to release.
   */
  private async acquireLock(lockPath: string) {
    while (true) {
      try {
        return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
}
