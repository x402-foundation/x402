import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { isNodeEnoent, readJsonFile, writeJsonAtomic } from "../storage-utils";
import type { FileChannelStorageOptions } from "../types";
import type { ClientChannelStorage, BatchSettlementClientContext } from "./storage";

/**
 * Node.js file-backed {@link ClientChannelStorage} for the batched client scheme.
 * Each channel's context is persisted as `{root}/client/{channelId}.json` so that channel
 * records survive process restarts.
 */
export class FileClientChannelStorage implements ClientChannelStorage {
  private readonly root: string;

  /**
   * Creates file-backed client channel storage under the given root directory.
   *
   * @param options - Configuration including the storage root directory.
   */
  constructor(options: FileChannelStorageOptions) {
    this.root = options.directory;
  }

  /**
   * Loads the stored client context for a channel, if present.
   *
   * @param key - Channel storage key (typically a lowercased channelId).
   * @returns Parsed context or `undefined` when the file is missing.
   */
  async get(key: string): Promise<BatchSettlementClientContext | undefined> {
    return readJsonFile<BatchSettlementClientContext>(this.filePath(key));
  }

  /**
   * Persists the client context for a channel.
   *
   * @param key - Channel storage key.
   * @param context - Context record to write.
   */
  async set(key: string, context: BatchSettlementClientContext): Promise<void> {
    await writeJsonAtomic(this.filePath(key), context);
  }

  /**
   * Removes the persisted context file for a channel, if it exists.
   *
   * @param key - Channel storage key.
   */
  async delete(key: string): Promise<void> {
    try {
      await unlink(this.filePath(key));
    } catch (err: unknown) {
      if (isNodeEnoent(err)) return;
      throw err;
    }
  }

  /**
   * Absolute path to the JSON file for a channel.
   *
   * @param key - Channel storage key.
   * @returns Filesystem path under `{root}/client/...`.
   */
  private filePath(key: string): string {
    return join(this.root, "client", `${key.toLowerCase()}.json`);
  }
}
